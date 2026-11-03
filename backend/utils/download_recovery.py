"""Bounded media retries shared by legacy imports and Studio."""
import os
import re
from pathlib import Path
from urllib.parse import urlparse
import yt_dlp
from yt_dlp.cookies import CookieLoadError

from backend.pipeline.failures import PipelineFailure


COOKIE_ACCESS_HINT = '无法读取浏览器登录信息。请关闭浏览器后重试，或不选浏览器下载公开视频。原素材已保留。'
# 也是前端 i18n 的 key（8 个 locale），改动时同步 frontend/src/i18n/locales/*.json。
SOURCE_BLOCKED_HINT = '视频网站拒绝了这次下载（HTTP 403/412/429），常见于当前网络被网站风控或请求过于频繁。请稍后换个网络（如手机热点）重试，或在导入时选择已登录的浏览器读取 Cookie。'
SOURCE_BLOCKED_CODE = 'source_blocked'
# yt-dlp: "Unable to download webpage: HTTP Error 412: Precondition Failed"
_BLOCKED_HTTP_ERROR = re.compile(r'\bhttp error (403|412|429)\b')

# YouTube bot check / sign in required patterns
_YOUTUBE_BOT_CHECK_RE = re.compile(
    r"sign in to confirm you(?:['’]|&#39;)re not a bot|sign in to confirm|sign in required|use --cookies-from-browser|this video requires authentication",
    re.IGNORECASE
)
_COOKIE_EXPIRED_RE = re.compile(
    r"cookies are no longer valid|rotated in the browser|cookies? (?:have )?expired",
    re.IGNORECASE
)
_BROWSER_LOCKED_RE = re.compile(
    r"could not copy .* cookie database|being used by another process|database is locked",
    re.IGNORECASE
)
_DPAPI_FAIL_RE = re.compile(
    r"failed to decrypt with dpapi",
    re.IGNORECASE
)

YOUTUBE_AUTH_REQUIRED_HINT = 'YouTube 要求登录验证（Sign in to confirm you are not a bot）。请在“制作偏好”中选择已登录 YouTube 的浏览器（推荐 Firefox），或将导出的 cookies.txt 放入 AutoClip 数据目录后点击重试。'
YOUTUBE_AUTH_CODE = 'authentication'
BROWSER_LOCKED_HINT = '所选浏览器当前正在运行并锁定了 Cookie 数据库。请关闭该浏览器后点击重试；或者推荐使用 Firefox 登录 YouTube，或使用 cookies.txt 文件。'
BROWSER_DPAPI_HINT = 'Windows 版 Chrome/Edge 已启用应用绑定加密（App-Bound Encryption），外部程序无法直接解密其 Cookie。请使用 Firefox 浏览器登录 YouTube 后选择 Firefox，或将导出的 cookies.txt 放入 AutoClip 数据目录后重试。'
COOKIE_EXPIRED_HINT = 'YouTube 登录凭据已过期或被轮换。请在浏览器中重新登录 YouTube，或更新 AutoClip 数据目录中的 cookies.txt 文件后点击重试。'


def _browser_cookie_permission_failure(error):
    """Recognize yt-dlp's typed cookie wrapper, not arbitrary permission errors."""
    pending, seen = [error], set()
    cookie_failure = permission_failure = False
    while pending:
        current = pending.pop()
        if not isinstance(current, BaseException) or id(current) in seen:
            continue
        seen.add(id(current))
        cookie_failure |= isinstance(current, CookieLoadError)
        permission_failure |= isinstance(current, PermissionError)
        pending.extend((current.__cause__, current.__context__))
        info = getattr(current, 'exc_info', None)
        if isinstance(info, tuple) and len(info) > 1:
            pending.append(info[1])
    return cookie_failure and permission_failure


def download_with_recovery(url: str, options: dict):
    opts = {**options, 'socket_timeout': 30, 'retries': 2,
            'fragment_retries': 2, 'extractor_retries': 2,
            'concurrent_fragment_downloads': 4, 'skip_unavailable_fragments': False,
            'continuedl': True}
    youtube = urlparse(url).hostname in {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'}
    public_site = youtube or urlparse(url).hostname in {'bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'}
    retried_subtitles = retried_format = retried_cookies = retried_auth = False
    while True:
        try:
            with yt_dlp.YoutubeDL(opts) as downloader:
                result = downloader.download([url])
            if result:
                raise RuntimeError('视频下载未完成，请检查网络后重试；已下载的分片将用于续传。')
            return result
        except (yt_dlp.utils.DownloadError, CookieLoadError) as error:
            text = str(error).lower()
            if opts.get('cookiesfrombrowser') and (_browser_cookie_permission_failure(error) or _BROWSER_LOCKED_RE.search(text) or _DPAPI_FAIL_RE.search(text)):
                # Browser cookies are optional for public media. Do not touch the
                # browser database, export credentials, or retry its locked file.
                if public_site and not opts.get('cookiefile') and not retried_cookies:
                    retried_cookies = True
                    opts.pop('cookiesfrombrowser')
                    continue
                if _DPAPI_FAIL_RE.search(text):
                    raise PipelineFailure('INGEST', COOKIE_ACCESS_HINT, hint=BROWSER_DPAPI_HINT, code=YOUTUBE_AUTH_CODE) from None
                raise RuntimeError(COOKIE_ACCESS_HINT) from None
            if not retried_subtitles and ('subtitle' in text or 'subtitles' in text) and (opts.get('writesubtitles') or opts.get('writeautomaticsub')):
                retried_subtitles = True
                opts.update(writesubtitles=False, writeautomaticsub=False)
                continue
            if youtube and not retried_format and any(code in text for code in ('http error 403', 'http error 500', 'requested format is not available')):
                retried_format = True
                opts['format'] = 'bestvideo[height<=1080][protocol*=m3u8]+bestaudio[protocol*=m3u8]/best[height<=1080][protocol*=m3u8]/best[ext=mp4]/best'
                continue
            if retried_cookies:
                raise RuntimeError(COOKIE_ACCESS_HINT) from None
            if youtube and (_YOUTUBE_BOT_CHECK_RE.search(text) or _COOKIE_EXPIRED_RE.search(text)):
                if not retried_auth:
                    retried_auth = True
                    # 1. Automatically sync fresh cookies from local browsers (Firefox) into cookies.txt
                    try:
                        from backend.utils.cookie_manager import sync_browser_cookies
                        synced_path = sync_browser_cookies(force=True)
                        if synced_path and synced_path.is_file() and synced_path.stat().st_size > 500:
                            opts['cookiefile'] = str(synced_path)
                            opts.pop('cookiesfrombrowser', None)
                            continue
                    except Exception:
                        pass
                    # 2. Check for local cookies.txt in appdata if not tried yet
                    try:
                        from backend.core.path_utils import get_data_directory
                        data_dir = get_data_directory()
                        for cname in ('cookies.txt', 'youtube_cookies.txt'):
                            cpath = data_dir / cname
                            if cpath.is_file() and cpath.stat().st_size > 0 and not opts.get('cookiefile'):
                                opts['cookiefile'] = str(cpath)
                                break
                    except Exception:
                        pass
                    if opts.get('cookiefile'):
                        continue
                    # 3. Check for firefox browser cookies if no browser was tried yet
                    if not opts.get('cookiesfrombrowser'):
                        appdata = os.environ.get('APPDATA', '')
                        if appdata and (Path(appdata) / 'Mozilla/Firefox/Profiles').exists():
                            opts['cookiesfrombrowser'] = ('firefox',)
                            continue
                # If cookies were tried and expired:
                if _COOKIE_EXPIRED_RE.search(text):
                    raise PipelineFailure('INGEST', COOKIE_EXPIRED_HINT, code=YOUTUBE_AUTH_CODE) from None
                raise PipelineFailure('INGEST', YOUTUBE_AUTH_REQUIRED_HINT, code=YOUTUBE_AUTH_CODE) from None
            blocked = _BLOCKED_HTTP_ERROR.search(text)
            if blocked:
                # The site refused this network/client (e.g. Bilibili 412 risk control on
                # datacenter IPs). Expected and actionable: a stable code and a translated
                # hint, never yt-dlp's English text, URL or response.
                raise PipelineFailure('INGEST', SOURCE_BLOCKED_HINT, code=SOURCE_BLOCKED_CODE,
                                      http_status=int(blocked[1])) from None
            raise
