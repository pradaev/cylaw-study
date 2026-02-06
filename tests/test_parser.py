"""Tests for the HTML parser module.

All tests use saved HTML fixtures — no network calls.
"""

import os
from pathlib import Path

import pytest

# Parser will expose these when implemented
from scraper.parser import (
    CaseEntry,
    parse_court_main_index,
    parse_year_index,
    parse_updates_page,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _read_fixture(name: str) -> str:
    """Read an HTML fixture file, handling Greek encoding."""
    path = FIXTURES_DIR / name
    for enc in ("utf-8", "iso-8859-7", "windows-1253", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_bytes().decode("latin-1")


# ---------------------------------------------------------------------------
# parse_court_main_index
# ---------------------------------------------------------------------------


class TestParseCourtMainIndex:
    """Tests for extracting year-index URLs from a court's main index page."""

    def test_extracts_year_links_courtOfAppeal(self):
        html = _read_fixture("court_main_index_courtOfAppeal.html")
        urls = parse_court_main_index(html, "courtOfAppeal")
        assert len(urls) > 0
        # Should contain year-specific index URLs
        assert any("index_2026" in u for u in urls)
        assert any("index_2024" in u for u in urls)

    def test_extracts_year_links_epa(self):
        html = _read_fixture("court_main_index_epa.html")
        urls = parse_court_main_index(html, "epa")
        assert len(urls) > 0
        # EPA uses {year}/index.html pattern
        assert any("2025/index.html" in u for u in urls)

    def test_extracts_year_links_dioikitiko(self):
        html = _read_fixture("court_main_index_dioikitiko.html")
        urls = parse_court_main_index(html, "dioikitiko")
        assert len(urls) >= 1
        assert any("2023" in u for u in urls)

    def test_returns_list_of_strings(self):
        html = _read_fixture("court_main_index_courtOfAppeal.html")
        urls = parse_court_main_index(html, "courtOfAppeal")
        assert isinstance(urls, list)
        for u in urls:
            assert isinstance(u, str)

    def test_empty_html_returns_empty_list(self):
        urls = parse_court_main_index("<html><body></body></html>", "supreme")
        assert urls == []

    def test_urls_are_absolute_or_start_with_slash(self):
        html = _read_fixture("court_main_index_courtOfAppeal.html")
        urls = parse_court_main_index(html, "courtOfAppeal")
        for u in urls:
            assert u.startswith("/") or u.startswith("http")


# ---------------------------------------------------------------------------
# parse_year_index
# ---------------------------------------------------------------------------


class TestParseYearIndex:
    """Tests for extracting case entries from a year-specific index page."""

    def test_extracts_cases_courtOfAppeal_2026(self):
        html = _read_fixture("year_index_courtOfAppeal_2026.html")
        cases = parse_year_index(html, "courtOfAppeal", "2026")
        # We counted 33 case links in this fixture
        assert len(cases) == 33

    def test_extracts_cases_dioikitiko_2023(self):
        html = _read_fixture("year_index_dioikitiko_2023.html")
        cases = parse_year_index(html, "dioikitiko", "2023")
        assert len(cases) == 1

    def test_extracts_cases_epa_2025(self):
        html = _read_fixture("year_index_epa_2025.html")
        cases = parse_year_index(html, "epa", "2025")
        assert len(cases) == 26

    def test_case_entry_has_required_fields(self):
        html = _read_fixture("year_index_dioikitiko_2023.html")
        cases = parse_year_index(html, "dioikitiko", "2023")
        case = cases[0]
        assert isinstance(case, CaseEntry)
        assert case.url != ""
        assert case.file_path != ""
        assert case.title != ""
        assert case.court == "dioikitiko"
        assert case.year == "2023"

    def test_file_path_extracted_from_href(self):
        html = _read_fixture("year_index_dioikitiko_2023.html")
        cases = parse_year_index(html, "dioikitiko", "2023")
        case = cases[0]
        # file_path should start with / and end with .html
        assert case.file_path.startswith("/")
        assert case.file_path.endswith(".html")
        assert "dioikitiko" in case.file_path

    def test_url_is_absolute(self):
        html = _read_fixture("year_index_courtOfAppeal_2026.html")
        cases = parse_year_index(html, "courtOfAppeal", "2026")
        for case in cases:
            assert case.url.startswith("https://www.cylaw.org/")

    def test_empty_html_returns_empty_list(self):
        cases = parse_year_index(
            "<html><body></body></html>", "supreme", "2025"
        )
        assert cases == []

    def test_no_duplicate_entries(self):
        html = _read_fixture("year_index_courtOfAppeal_2026.html")
        cases = parse_year_index(html, "courtOfAppeal", "2026")
        file_paths = [c.file_path for c in cases]
        assert len(file_paths) == len(set(file_paths))


# ---------------------------------------------------------------------------
# parse_updates_page
# ---------------------------------------------------------------------------


class TestParseUpdatesPage:
    """Tests for extracting case entries from the updates.html page."""

    def test_extracts_cases_from_snippet(self):
        html = _read_fixture("updates_snippet.html")
        cases = parse_updates_page(html)
        # Our 300-line snippet had 57 links
        assert len(cases) == 57

    def test_detects_court_from_file_path(self):
        html = _read_fixture("updates_snippet.html")
        cases = parse_updates_page(html)
        courts_found = {c.court for c in cases}
        # The snippet has links to supreme, courtOfAppeal, supremeAdministrative
        assert len(courts_found) >= 2

    def test_case_entries_have_required_fields(self):
        html = _read_fixture("updates_snippet.html")
        cases = parse_updates_page(html)
        for case in cases:
            assert isinstance(case, CaseEntry)
            assert case.url.startswith("https://")
            assert case.file_path.startswith("/")
            assert case.title != ""
            assert case.court != ""

    def test_empty_html_returns_empty_list(self):
        cases = parse_updates_page("<html><body></body></html>")
        assert cases == []
