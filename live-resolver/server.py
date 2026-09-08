"""
live-resolver — 央视直播流动态解析服务（本地 HLS 代理模式）

原理（与已验证可正常播放的 4000 端口 cctv 转发一致）：
  央视官网接口只返回“被干扰/挖空”的 hls_cdrm 流，播放器直连央视 CDN
  时只能出声、出不了画面。本服务把流拉到本地后再转发给播放器：

    播放器 ──> 本服务(localhost:8788) ──> 央视 CDN
              固定单档播放列表 + ts 分片全部经本服务中转

  这样播放器拿到的是干净的本地 HLS，不再直连央视 CDN。

端点：
  GET  /cctv/<channel_id>/playlist.m3u8   单档媒体播放列表（ts 指向本服务）
  GET  /cctv/<channel_id>/ts/<url>        ts 分片本地转发
  GET  /play/<channel_id>                 302 -> /cctv/<id>/playlist.m3u8（兼容旧地址）
  GET  /live.m3u                          播放列表（指向 /cctv/...）
  GET  /live.txt                          TXT 播放列表
  GET  /api/channels                      频道列表（JSON）
  GET  /health                            健康检查

运行：python server.py
Docker：docker build -t live-resolver . && docker run -p 8788:8788 live-resolver
"""
import json
import logging
import os
import re
import threading
import time
import urllib.parse

import requests
from flask import Flask, Response, jsonify, redirect, request

from cctv_resolver import CCTVRResolver


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8788"))
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

# 上游（央视 CDN）请求超时（秒）
UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", "15"))
# 档位：auto=自动选最高分辨率；也可强制如 1280x720 / 640x360
QUALITY = os.environ.get("QUALITY", "auto")
# 上游请求是否附带浏览器 UA/Referer（默认不附带，与可用的 4000 转发保持一致）
SEND_BROWSER_HEADERS = os.environ.get("SEND_BROWSER_HEADERS", "0") == "1"

# 频道数据文件
_CHANNELS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "channels.json")

# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("live-resolver")

# ---------------------------------------------------------------------------
# 应用
# ---------------------------------------------------------------------------
app = Flask(__name__)

# 解析器实例
resolver = CCTVRResolver()

# 上游请求会话（Keep-Alive 复用，加速分片转发）
_upstream = requests.Session()

# 每个频道的“媒体播放列表”缓存：id -> (expires_at, media_url)
_media_cache = {}
_media_lock = threading.Lock()
MEDIA_CACHE_SECONDS = float(os.environ.get("MEDIA_CACHE_SECONDS", "30"))

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    ),
    "Referer": "https://tv.cctv.com/",
    "Origin": "https://tv.cctv.com",
}

# 加载频道列表
with open(_CHANNELS_FILE, "r", encoding="utf-8") as f:
    CHANNEL_DATA = json.load(f)
CHANNELS = CHANNEL_DATA["channels"]
CHANNEL_MAP = {ch["id"]: ch for ch in CHANNELS}
log.info("loaded %d channels from %s", len(CHANNELS), _CHANNELS_FILE)


# ---------------------------------------------------------------------------
# 上游解析
# ---------------------------------------------------------------------------
def _upstream_get(url, **kwargs):
    """带超时与（可选）浏览器请求头的上游 GET，返回 requests.Response"""
    headers = dict(kwargs.pop("headers", None) or {})
    if SEND_BROWSER_HEADERS:
        for k, v in _BROWSER_HEADERS.items():
            headers.setdefault(k, v)
    return _upstream.get(url, headers=headers or None,
                         timeout=UPSTREAM_TIMEOUT, **kwargs)


def _resolve_media_url(channel_id):
    """
    解析出该频道“单档媒体播放列表”的绝对地址（自动挑最高分辨率档）。

    结果缓存 MEDIA_CACHE_SECONDS 秒，避免每次刷新列表都重新请求 master。
    """
    now = time.monotonic()
    cached = _media_cache.get(channel_id)
    if cached and now < cached[0]:
        return cached[1]

    with _media_lock:
        # 双检：等锁期间可能已被其它线程更新
        cached = _media_cache.get(channel_id)
        if cached and now < cached[0]:
            return cached[1]

        master_url = resolver.resolve(channel_id)  # 央视 API -> index.m3u8
        resp = _upstream_get(master_url)
        resp.raise_for_status()
        media_url = _pick_variant(master_url, resp.text)

        _media_cache[channel_id] = (now + MEDIA_CACHE_SECONDS, media_url)
        log.info("resolve %s master=%s -> media=%s",
                 channel_id, master_url[:90] + "..." if len(master_url) > 90 else master_url,
                 media_url)
        return media_url


def _pick_variant(master_url, text):
    """
    从 master 播放列表中挑选单档媒体列表地址。

    QUALITY=auto 时挑分辨率最大的一档；否则按 RESOLUTION=WxH 精确匹配，
    匹配不到就退回第一档。
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    candidates = []  # (width, height, uri)
    for i, ln in enumerate(lines):
        if ln.startswith("#EXT-X-STREAM-INF"):
            uri = lines[i + 1] if i + 1 < len(lines) else None
            if not uri or uri.startswith("#"):
                continue
            m = re.search(r"RESOLUTION=(\d+)x(\d+)", ln)
            if m:
                candidates.append((int(m.group(1)), int(m.group(2)), uri))
            else:
                candidates.append((0, 0, uri))
    if not candidates:
        raise ValueError("no variant found in master playlist")

    if QUALITY.lower() == "auto":
        picked = max(candidates, key=lambda c: (c[0], c[1]))
    else:
        m = re.search(r"(\d+)x(\d+)", QUALITY.lower())
        picked = None
        if m:
            w, h = int(m.group(1)), int(m.group(2))
            for cand in candidates:
                if cand[0] == w and cand[1] == h:
                    picked = cand
                    break
        if picked is None:
            picked = candidates[0]
            log.warning("QUALITY=%s not found, fallback to %dx%d",
                        QUALITY, picked[0], picked[1])

    return urllib.parse.urljoin(master_url, picked[2])


# ---------------------------------------------------------------------------
# 端点
# ---------------------------------------------------------------------------
@app.route("/cctv/<channel_id>/playlist.m3u8")
def channel_playlist(channel_id):
    """
    返回该频道单档媒体播放列表。

    列表里的 ts 分片地址全部改写成指向本服务的 /cctv/<id>/ts/<url>，
    让分片也经本服务转发（避免播放器直连央视 CDN 拿到残缺视频）。
    """
    if channel_id not in CHANNEL_MAP:
        return jsonify({"error": "channel not found", "channel": channel_id}), 404

    try:
        media_url = _resolve_media_url(channel_id)
        resp = _upstream_get(media_url)
        resp.raise_for_status()
        body = resp.text
    except Exception as e:
        log.error("fetch playlist %s failed: %s", channel_id, e)
        return jsonify({"error": str(e), "channel": channel_id}), 502

    base = request.host_url.rstrip("/")
    rewritten = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            rewritten.append(raw)
            continue
        # 把分片地址统一成绝对地址，再指回本服务转发
        abs_url = urllib.parse.urljoin(media_url, line)
        local = "{}/cctv/{}/ts/{}".format(
            base, channel_id, urllib.parse.quote(abs_url, safe="")
        )
        rewritten.append(local)

    content = "\n".join(rewritten) + "\n"
    return Response(
        content,
        mimetype="application/vnd.apple.mpegurl; charset=utf-8",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
        },
    )


@app.route("/cctv/<channel_id>/ts/<path:quoted_url>")
def channel_segment(channel_id, quoted_url):
    """
    本地转发 ts 分片：本服务去央视 CDN 取回干净分片后原样回传给播放器。
    """
    if channel_id not in CHANNEL_MAP:
        return jsonify({"error": "channel not found", "channel": channel_id}), 404

    target = urllib.parse.unquote(quoted_url)
    if not target.startswith(("http://", "https://")):
        return jsonify({"error": "invalid url"}), 400

    try:
        upstream = _upstream_get(target, stream=True)
        # 首次失败重试一次（分片是直播尾部的数据，偶尔抽风）
        if upstream.status_code >= 400:
            log.warning("upstream %s -> %s, retry once", target, upstream.status_code)
            upstream.close()
            upstream = _upstream_get(target, stream=True)
        upstream.raise_for_status()
    except Exception as e:
        log.error("fetch segment %s failed: %s", target, e)
        return jsonify({"error": str(e)}), 502

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(
        generate(),
        status=upstream.status_code,
        mimetype=upstream.headers.get("Content-Type")
        or "video/mp2t",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
        },
    )


@app.route("/play/<channel_id>")
def play(channel_id):
    """
    兼容旧地址：302 到本地单档播放列表（经本服务转发）。
    不再直接跳央视 CDN（直连拿到的视频是残缺的）。
    """
    if channel_id not in CHANNEL_MAP:
        return jsonify({"error": "channel not found", "channel": channel_id}), 404
    return redirect("/cctv/{}/playlist.m3u8".format(channel_id), code=302)


@app.route("/live.m3u")
def live_m3u():
    """
    生成 M3U 播放列表，所有频道指向本服务的本地转发播放列表。
    """
    base_url = request.host_url.rstrip("/")
    lines = ["#EXTM3U"]

    for ch in CHANNELS:
        ch_id = ch["id"]
        name = ch["name"]
        logo = ch.get("logo", "")
        group = ch.get("group", "央视频道")
        lines.append(
            '#EXTINF:-1 tvg-id="{}" tvg-name="{}" tvg-logo="{}" group-title="{}",{}'.format(
                ch_id, name, logo, group, name
            )
        )
        lines.append("{}/cctv/{}/playlist.m3u8".format(base_url, ch_id))

    content = "\n".join(lines) + "\n"
    return Response(
        content,
        mimetype="application/vnd.apple.mpegurl; charset=utf-8",
        headers={"Access-Control-Allow-Origin": "*"},
    )


@app.route("/live.txt")
def live_txt():
    """生成 TXT 格式播放列表（兼容旧版播放器）"""
    base_url = request.host_url.rstrip("/")
    lines = ["央视频道,#genre#"]

    for ch in CHANNELS:
        name = ch["name"]
        ch_id = ch["id"]
        lines.append("{},{}/cctv/{}/playlist.m3u8".format(name, base_url, ch_id))

    content = "\n".join(lines) + "\n"
    return Response(
        content,
        mimetype="text/plain; charset=utf-8",
        headers={"Access-Control-Allow-Origin": "*"},
    )


@app.route("/api/channels")
def api_channels():
    """返回频道列表 JSON"""
    return jsonify(CHANNEL_DATA)


@app.route("/health")
def health():
    """健康检查"""
    return jsonify({
        "status": "ok",
        "channels": len(CHANNELS),
        "mode": "local-hls-proxy",
        "quality": QUALITY,
        "version": "3.0.0",
    })


@app.route("/")
def index():
    """首页"""
    base_url = request.host_url.rstrip("/")
    return jsonify({
        "service": "live-resolver",
        "description": "CCTV 直播流动态解析服务（本地 HLS 代理）",
        "mode": "local-hls-proxy",
        "version": "3.0.0",
        "endpoints": {
            "playlist": "{}/cctv/<channel_id>/playlist.m3u8".format(base_url),
            "play_legacy": "{}/play/<channel_id>".format(base_url),
            "m3u": "{}/live.m3u".format(base_url),
            "txt": "{}/live.txt".format(base_url),
            "channels": "{}/api/channels".format(base_url),
            "health": "{}/health".format(base_url),
        },
        "channels": len(CHANNELS),
    })


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    log.info(
        "starting live-resolver on %s:%d  (%d channels, quality=%s)",
        HOST, PORT, len(CHANNELS), QUALITY,
    )
    app.run(host=HOST, port=PORT, threaded=True, debug=(LOG_LEVEL == "DEBUG"))
