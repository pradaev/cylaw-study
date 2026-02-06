"""HTTP fetcher with rate limiting, disk caching, and retries.

Wraps requests.Session to provide polite, reliable fetching of
CyLaw index pages.
"""

import hashlib
import logging
import os
import time
from pathlib import Path
from typing import Optional

import requests

from scraper.config import (
    REQUEST_DELAY,
    REQUEST_TIMEOUT,
    MAX_RETRIES,
    USER_AGENT,
)

logger = logging.getLogger(__name__)


class Fetcher:
    """HTTP client with rate limiting, disk caching, and retry logic.

    Args:
        cache_dir: Directory for cached HTML responses.
            Pass None to disable caching.
        delay: Seconds to wait between HTTP requests.
        max_retries: Maximum number of retry attempts on server errors.
        timeout: HTTP request timeout in seconds.
    """

    def __init__(
        self,
        cache_dir: Optional[str] = None,
        delay: float = REQUEST_DELAY,
        max_retries: int = MAX_RETRIES,
        timeout: int = REQUEST_TIMEOUT,
    ):
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": USER_AGENT})
        self._cache_dir = cache_dir
        self._delay = delay
        self._max_retries = max_retries
        self._timeout = timeout
        self._last_request_time: float = 0.0

        if self._cache_dir:
            os.makedirs(self._cache_dir, exist_ok=True)

    def _cache_path(self, url: str) -> Optional[Path]:
        """Return cache file path for a given URL, or None if caching disabled."""
        if not self._cache_dir:
            return None
        url_hash = hashlib.md5(url.encode()).hexdigest()
        return Path(self._cache_dir) / f"{url_hash}.html"

    def _read_cache(self, url: str) -> Optional[str]:
        """Read cached response for URL, or None if not cached."""
        path = self._cache_path(url)
        if path and path.exists():
            logger.debug("Cache hit: %s", url)
            return path.read_text(encoding="utf-8", errors="replace")
        return None

    def _write_cache(self, url: str, content: str) -> None:
        """Write response content to cache."""
        path = self._cache_path(url)
        if path:
            path.write_text(content, encoding="utf-8")
            logger.debug("Cached: %s", url)

    def _rate_limit(self) -> None:
        """Wait if needed to respect the rate limit."""
        if self._delay <= 0:
            return
        elapsed = time.time() - self._last_request_time
        if elapsed < self._delay and self._last_request_time > 0:
            time.sleep(self._delay)

    def fetch(self, url: str) -> str:
        """Fetch a URL, using cache if available.

        Implements rate limiting, disk caching, retry with exponential
        backoff on 5xx errors, and proper encoding handling for Greek text.

        Args:
            url: The URL to fetch.

        Returns:
            HTML content as a string.

        Raises:
            RuntimeError: If all retry attempts fail.
        """
        # Check cache first
        cached = self._read_cache(url)
        if cached is not None:
            return cached

        # Rate limit
        self._rate_limit()

        last_error: Optional[Exception] = None
        for attempt in range(1, self._max_retries + 1):
            try:
                self._last_request_time = time.time()
                response = self._session.get(url, timeout=self._timeout)

                if response.status_code >= 500:
                    logger.warning(
                        "Server error %d for %s (attempt %d/%d)",
                        response.status_code,
                        url,
                        attempt,
                        self._max_retries,
                    )
                    if attempt < self._max_retries:
                        backoff = 2 ** (attempt - 1)
                        time.sleep(backoff)
                    continue

                # Handle encoding — the site uses ISO-8859-7 / Windows-1253
                if response.encoding and response.encoding.lower() in (
                    "iso-8859-1",
                    "latin-1",
                ):
                    # requests defaults to ISO-8859-1 for text/html without
                    # explicit charset; try Greek encoding instead
                    response.encoding = "iso-8859-7"

                content = response.text
                self._write_cache(url, content)
                return content

            except requests.RequestException as exc:
                last_error = exc
                logger.warning(
                    "Request error for %s (attempt %d/%d): %s",
                    url,
                    attempt,
                    self._max_retries,
                    exc,
                )
                if attempt < self._max_retries:
                    backoff = 2 ** (attempt - 1)
                    time.sleep(backoff)

        raise RuntimeError(
            f"Failed to fetch {url} after {self._max_retries} attempts. "
            f"Last error: {last_error}"
        )
