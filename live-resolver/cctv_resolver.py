"""
CCTV 直播流地址解析器
从央视官网播放 API 动态解析出 HLS 流地址。
来源：tv.cctv.com 的播放接口 vdnx.live.cntv.cn

用法：
    resolver = CCTVRResolver()
    url = resolver.resolve("cctv1")  # 返回 HLS 流地址
"""
import base64
import hashlib
import secrets
import time
import requests


PLAY_URL = "https://vdnx.live.cntv.cn/api/v3/vdn/live"
PLAY_SECRET = "a4220a71b31746908fa3e7fdd7a6852a"
REQUEST_TIMEOUT = 8
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
)
CACHE_SECONDS = 60


class CCTVRResolver:
    """CCTV 直播流解析器"""

    def __init__(self):
        self.uid = self._generate_uid()
        self._cache = {}  # channel_id -> (expires_at, url)

    def resolve(self, channel_id: str) -> str:
        """
        解析指定频道的直播流地址。

        Args:
            channel_id: 频道 ID，如 "cctv1", "cctv5plus", "cctvjilu"

        Returns:
            HLS 直播流 URL（m3u8 地址）

        Raises:
            ValueError: 频道 ID 无效、API 返回错误或缺少流地址
            requests.RequestException: 网络请求失败
        """
        # 检查缓存
        now = time.monotonic()
        cached = self._cache.get(channel_id)
        if cached and now < cached[0]:
            return cached[1]

        # 构建签名
        timestamp = int(time.time() * 1000)
        nonce = secrets.randbelow(901) + 100
        digest = hashlib.md5(
            "{}{}{}{}".format(channel_id, timestamp, nonce, PLAY_SECRET).encode("utf-8")
        ).hexdigest()
        auth_key = "{}-{}-{}".format(timestamp, nonce, digest)

        # 请求播放 API
        with requests.get(
            PLAY_URL,
            params={
                "channel": channel_id,
                "vn": "1",
                "pdrm": "1",
                "uid": self.uid,
                "hbss": str(timestamp),
            },
            headers={
                "auth-key": auth_key,
                "Origin": "https://tv.cctv.com",
                "Referer": "https://tv.cctv.com/",
                "User-Agent": USER_AGENT,
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout=REQUEST_TIMEOUT,
        ) as response:
            response.raise_for_status()
            result = response.json()

        # 检查 API 响应
        if result.get("ack") != "yes":
            raise ValueError("CCTV API rejected channel: {}".format(channel_id))

        manifest = result.get("manifest") or {}
        backup = result.get("backup") or {}
        location = manifest.get("hls_cdrm") or backup.get("hls_cdrm")

        if not isinstance(location, str) or not location.startswith(
            ("http://", "https://")
        ):
            raise ValueError("missing HLS manifest for channel: {}".format(channel_id))

        # 写入缓存
        self._cache[channel_id] = (now + CACHE_SECONDS, location)
        return location

    def clear_cache(self):
        """清除已缓存的流地址"""
        self._cache.clear()

    @staticmethod
    def _generate_uid() -> str:
        """生成匿名设备标识"""
        return base64.b64encode(secrets.token_bytes(18)).decode("ascii")