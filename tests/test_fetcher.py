"""Tests for the HTTP fetcher module.

All tests use mocks — no real network calls.
"""

import os
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from scraper.fetcher import Fetcher


class TestRateLimiting:
    """Verify the fetcher enforces delay between requests."""

    @patch("scraper.fetcher.requests.Session")
    @patch("scraper.fetcher.time.sleep")
    def test_rate_limiting_enforces_delay(self, mock_sleep, mock_session_cls):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = "<html></html>"
        mock_response.encoding = "utf-8"

        session_instance = MagicMock()
        session_instance.get.return_value = mock_response
        mock_session_cls.return_value = session_instance

        fetcher = Fetcher(cache_dir=None, delay=0.75)
        fetcher.fetch("https://example.com/page1")
        fetcher.fetch("https://example.com/page2")

        # Sleep should have been called at least once after the first fetch
        assert mock_sleep.call_count >= 1
        # Verify delay value
        mock_sleep.assert_called_with(0.75)


class TestCaching:
    """Verify the fetcher caches responses to disk."""

    @patch("scraper.fetcher.requests.Session")
    def test_cache_returns_cached_on_second_call(
        self, mock_session_cls, tmp_path
    ):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = "<html>cached content</html>"
        mock_response.encoding = "utf-8"
        mock_response.content = b"<html>cached content</html>"

        session_instance = MagicMock()
        session_instance.get.return_value = mock_response
        mock_session_cls.return_value = session_instance

        cache_dir = str(tmp_path / "cache")
        fetcher = Fetcher(cache_dir=cache_dir, delay=0)
        url = "https://example.com/page1"

        # First call: should fetch from network
        result1 = fetcher.fetch(url)
        assert result1 == "<html>cached content</html>"
        assert session_instance.get.call_count == 1

        # Second call: should return from cache, not network
        result2 = fetcher.fetch(url)
        assert result2 == "<html>cached content</html>"
        # Still only 1 network call
        assert session_instance.get.call_count == 1

    @patch("scraper.fetcher.requests.Session")
    def test_no_cache_when_cache_dir_is_none(self, mock_session_cls):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = "<html></html>"
        mock_response.encoding = "utf-8"

        session_instance = MagicMock()
        session_instance.get.return_value = mock_response
        mock_session_cls.return_value = session_instance

        fetcher = Fetcher(cache_dir=None, delay=0)
        fetcher.fetch("https://example.com/p1")
        fetcher.fetch("https://example.com/p1")
        # Without cache, both calls hit the network
        assert session_instance.get.call_count == 2


class TestRetries:
    """Verify the fetcher retries on server errors."""

    @patch("scraper.fetcher.time.sleep")
    @patch("scraper.fetcher.requests.Session")
    def test_retry_on_server_error(self, mock_session_cls, mock_sleep):
        response_500 = MagicMock()
        response_500.status_code = 500
        response_500.text = "Error"
        response_500.raise_for_status = MagicMock(
            side_effect=Exception("Server Error")
        )

        response_200 = MagicMock()
        response_200.status_code = 200
        response_200.text = "<html>ok</html>"
        response_200.encoding = "utf-8"
        response_200.raise_for_status = MagicMock()

        session_instance = MagicMock()
        session_instance.get.side_effect = [response_500, response_200]
        mock_session_cls.return_value = session_instance

        fetcher = Fetcher(cache_dir=None, delay=0, max_retries=3)
        result = fetcher.fetch("https://example.com/flaky")
        assert result == "<html>ok</html>"
        assert session_instance.get.call_count == 2

    @patch("scraper.fetcher.time.sleep")
    @patch("scraper.fetcher.requests.Session")
    def test_raises_after_max_retries(self, mock_session_cls, mock_sleep):
        response_500 = MagicMock()
        response_500.status_code = 500
        response_500.text = "Error"

        session_instance = MagicMock()
        session_instance.get.return_value = response_500
        mock_session_cls.return_value = session_instance

        fetcher = Fetcher(cache_dir=None, delay=0, max_retries=3)
        with pytest.raises(RuntimeError, match="Failed to fetch"):
            fetcher.fetch("https://example.com/broken")
        # Should have tried max_retries times
        assert session_instance.get.call_count == 3
