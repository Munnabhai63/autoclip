"""
Automatic browser cookie synchronization and management for AutoClip.
Ensures yt-dlp always has fresh, valid cookies for YouTube and protected sites.
"""
import os
import time
import logging
import sqlite3
import http.cookiejar
from pathlib import Path
from typing import Optional, List

logger = logging.getLogger(__name__)

# Max age before cookies are considered stale and eligible for background refresh (4 hours)
COOKIE_REFRESH_INTERVAL_SEC = 4 * 3600


def find_firefox_profiles() -> List[Path]:
    """Find all candidate Firefox profile directories."""
    candidates = []
    for env_var in ('APPDATA', 'LOCALAPPDATA'):
        val = os.environ.get(env_var)
        if val:
            p_dir = Path(val) / 'Mozilla' / 'Firefox' / 'Profiles'
            if p_dir.is_dir():
                for sub in p_dir.iterdir():
                    if sub.is_dir() and (sub / 'cookies.sqlite').is_file():
                        candidates.append(sub)
    return candidates


def find_best_firefox_profile() -> Optional[Path]:
    """
    Find the Firefox profile with the most active YouTube cookies.
    Opens sqlite databases in read-only mode to prevent locking.
    """
    profiles = find_firefox_profiles()
    if not profiles:
        return None

    best_profile = None
    max_yt_cookies = -1

    for p in profiles:
        db_file = p / 'cookies.sqlite'
        try:
            conn = sqlite3.connect(f'file:{db_file}?mode=ro', uri=True)
            c = conn.cursor()
            c.execute("SELECT COUNT(1) FROM moz_cookies WHERE host LIKE '%youtube%'")
            count = c.fetchone()[0]
            conn.close()
            if count > max_yt_cookies:
                max_yt_cookies = count
                best_profile = p
        except Exception as e:
            logger.debug("Could not inspect Firefox profile %s: %s", p.name, e)

    return best_profile or profiles[0]


def extract_cookies_to_file(browser_name: str, target_file: Path, profile: Optional[str] = None) -> int:
    """
    Extract cookies from the specified browser into a Netscape cookie file.
    Returns the count of cookies exported.
    """
    import yt_dlp.cookies
    try:
        kwargs = {}
        if profile:
            kwargs['profile'] = profile
        jar = yt_dlp.cookies.extract_cookies_from_browser(browser_name, **kwargs)
        cookies = list(jar)
        if not cookies:
            return 0

        target_file.parent.mkdir(parents=True, exist_ok=True)
        tmp_file = target_file.with_suffix(f'.tmp_{os.getpid()}_{int(time.time())}')
        
        mozilla_jar = http.cookiejar.MozillaCookieJar(str(tmp_file))
        for c in cookies:
            mozilla_jar.set_cookie(c)
        mozilla_jar.save(ignore_discard=True, ignore_expires=True)

        # Atomic replace
        tmp_file.replace(target_file)
        logger.info("Successfully exported %d cookies from %s to %s", len(cookies), browser_name, target_file)
        return len(cookies)
    except Exception as e:
        logger.warning("Failed to extract cookies from %s: %s", browser_name, e)
        return 0


def sync_browser_cookies(force: bool = False) -> Optional[Path]:
    """
    Sync cookies from local browsers into cookies.txt in the AutoClip data directory.
    If cookies.txt exists and is younger than COOKIE_REFRESH_INTERVAL_SEC, skip unless force=True.
    """
    try:
        from backend.core.path_utils import get_data_directory
        data_dir = get_data_directory()
    except Exception:
        data_dir = Path("appdata")

    target_file = data_dir / 'cookies.txt'

    if not force and target_file.is_file() and target_file.stat().st_size > 500:
        age = time.time() - target_file.stat().st_mtime
        if age < COOKIE_REFRESH_INTERVAL_SEC:
            return target_file

    # 1. Try Firefox first (best support on Windows)
    profile = find_best_firefox_profile()
    if profile:
        count = extract_cookies_to_file('firefox', target_file, profile=str(profile))
        if count > 0:
            return target_file

    # Generic Firefox fallback if specific profile failed
    count = extract_cookies_to_file('firefox', target_file)
    if count > 0:
        return target_file

    # 2. Try Chrome / Edge / Brave as fallback if Firefox had no cookies
    for b in ('chrome', 'edge', 'brave', 'opera'):
        try:
            count = extract_cookies_to_file(b, target_file)
            if count > 0:
                return target_file
        except Exception:
            continue

    if target_file.is_file() and target_file.stat().st_size > 0:
        return target_file

    return None


def get_valid_cookie_file() -> Optional[Path]:
    """
    Returns path to a valid cookie file, syncing automatically if missing.
    """
    try:
        from backend.core.path_utils import get_data_directory
        data_dir = get_data_directory()
    except Exception:
        data_dir = Path("appdata")

    for name in ('cookies.txt', 'youtube_cookies.txt'):
        f = data_dir / name
        if f.is_file() and f.stat().st_size > 500:
            # If older than 6 hours, trigger non-blocking background refresh
            if time.time() - f.stat().st_mtime > 6 * 3600:
                import threading
                threading.Thread(target=sync_browser_cookies, args=(True,), daemon=True).start()
            return f

    return sync_browser_cookies(force=True)
