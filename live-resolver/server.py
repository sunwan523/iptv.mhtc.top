"""
live-resolver — 央视直播流动态解析服务

从 CCTV 官方 API 动态解析直播流地址，对外输出标准 M3U 播放列表。
原项目零改动，只需将其添加为普通数据源即可。

端点：
  GET  /play/<channel_id>   302 重定向到真实 HLS 流地址
  GET  /live.m3u            播放列表（M3U 格式，URL 指向 /play/）
  GET  /api/channels        频道列表（JSON）
  GET  /health              健康检查

运行：python server.py
Docker：docker build -t live-resolver . && docker run -p 8788:8788 live-resolver
"""
import json
import logging
import os
import time

from flask import Flask, Response, jsonify, redirect, request

from cctv_resolver import CCTVRResolver


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8788"))
CACHE_SECONDS = int(os.environ.get("CACHE_SECONDS", "60"))  # 解析结果缓存时间（秒）
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

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

# 加载频道列表
with open(_CHANNELS_FILE, "r", encoding="utf-8") as f:
    CHANNEL_DATA = json.load(f)
CHANNELS = CHANNEL_DATA["channels"]
CHANNEL_MAP = {ch["id"]: ch for ch in CHANNELS}
log.info("loaded %d channels from %s", len(CHANNELS), _CHANNELS_FILE)


# ---------------------------------------------------------------------------
# 端点
# ---------------------------------------------------------------------------
@app.route("/play/<channel_id>")
def play(channel_id):
    """
    解析并重定向到指定频道的 HLS 直播流。

    流程：
    1. 检查频道是否存在
    2. 调用 CCTV 播放 API 获取真实流地址
    3. 返回 302 重定向

    播放器拿到重定向后会直接连接 CDN 播放，不经过本服务。
    """
    channel = CHANNEL_MAP.get(channel_id)
    if not channel:
        log.warning("channel not found: %s", channel_id)
        return jsonify({"error": "channel not found", "channel": channel_id}), 404

    try:
        url = resolver.resolve(channel_id)
        log.info("resolve %s -> %s", channel_id, url[:80] + "..." if len(url) > 80 else url)
        return redirect(url, code=302)
    except Exception as e:
        log.error("resolve %s failed: %s", channel_id, e)
        return jsonify({"error": str(e), "channel": channel_id}), 502


@app.route("/live.m3u")
def live_m3u():
    """
    生成 M3U 播放列表。

    所有频道地址都指向本服务的 /play/<channel_id> 端点，
    播放时再由该端点 302 重定向到真实地址。
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
        lines.append("{}/play/{}".format(base_url, ch_id))

    content = "\n".join(lines) + "\n"
    return Response(
        content,
        mimetype="application/vnd.apple.mpegurl; charset=utf-8",
        headers={
            "Access-Control-Allow-Origin": "*",
        },
    )


@app.route("/live.txt")
def live_txt():
    """
    生成 TXT 格式播放列表（兼容旧版播放器）。

    格式：频道名,http://服务地址/play/频道ID
    """
    base_url = request.host_url.rstrip("/")
    lines = ["央视频道,#genre#"]

    for ch in CHANNELS:
        name = ch["name"]
        ch_id = ch["id"]
        lines.append("{},{}/play/{}".format(name, base_url, ch_id))

    content = "\n".join(lines) + "\n"
    return Response(
        content,
        mimetype="text/plain; charset=utf-8",
        headers={
            "Access-Control-Allow-Origin": "*",
        },
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
        "cache_seconds": CACHE_SECONDS,
        "version": "1.0.0",
    })


@app.route("/")
def index():
    """首页"""
    base_url = request.host_url.rstrip("/")
    return jsonify({
        "service": "live-resolver",
        "description": "CCTV 直播流动态解析服务",
        "endpoints": {
            "play": "{}/play/<channel_id>".format(base_url),
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
        "starting live-resolver on %s:%d  (%d channels, cache=%ds)",
        HOST, PORT, len(CHANNELS), CACHE_SECONDS,
    )
    app.run(host=HOST, port=PORT, debug=(LOG_LEVEL == "DEBUG"))