import os
from pathlib import Path
from backend.utils.cookie_manager import (
    find_firefox_profiles,
    find_best_firefox_profile,
    sync_browser_cookies,
    get_valid_cookie_file
)

def test_find_firefox_profiles():
    # Should safely return a list (may be empty or contain paths) without exceptions
    profiles = find_firefox_profiles()
    assert isinstance(profiles, list)

def test_find_best_firefox_profile():
    # Should safely return Path or None without crashing
    best = find_best_firefox_profile()
    if best is not None:
        assert isinstance(best, Path)
        assert (best / 'cookies.sqlite').exists()

def test_get_valid_cookie_file():
    # Should return a valid Path or None
    cf = get_valid_cookie_file()
    if cf is not None:
        assert isinstance(cf, Path)
        assert cf.exists()
