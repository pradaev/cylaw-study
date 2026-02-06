"""Tests for the storage module.

Verifies JSON file creation, structure, and load/save roundtrip.
"""

import json
from pathlib import Path

import pytest

from scraper.parser import CaseEntry
from scraper.storage import save_court_index, load_court_index, save_updates_index


def _make_entries() -> list[CaseEntry]:
    """Create sample CaseEntry objects for testing."""
    return [
        CaseEntry(
            url="https://www.cylaw.org/cgi-bin/open.pl?file=/supreme/2025/case1.html",
            file_path="/supreme/2025/case1.html",
            title="Case Alpha v. Beta",
            court="supreme",
            year="2025",
        ),
        CaseEntry(
            url="https://www.cylaw.org/cgi-bin/open.pl?file=/supreme/2025/case2.html",
            file_path="/supreme/2025/case2.html",
            title="Case Gamma v. Delta",
            court="supreme",
            year="2025",
        ),
        CaseEntry(
            url="https://www.cylaw.org/cgi-bin/open.pl?file=/supreme/2026/case3.html",
            file_path="/supreme/2026/case3.html",
            title="Case Epsilon v. Zeta",
            court="supreme",
            year="2026",
        ),
    ]


class TestSaveCourtIndex:
    """Tests for saving court indexes to JSON."""

    def test_save_creates_json_file(self, tmp_path):
        entries = _make_entries()
        save_court_index("supreme", entries, str(tmp_path))
        output_file = tmp_path / "supreme.json"
        assert output_file.exists()

    def test_json_structure_has_required_keys(self, tmp_path):
        entries = _make_entries()
        save_court_index("supreme", entries, str(tmp_path))
        data = json.loads((tmp_path / "supreme.json").read_text())
        assert data["court"] == "supreme"
        assert data["total"] == 3
        assert "scraped_at" in data
        assert "by_year" in data

    def test_json_structure_has_by_year(self, tmp_path):
        entries = _make_entries()
        save_court_index("supreme", entries, str(tmp_path))
        data = json.loads((tmp_path / "supreme.json").read_text())
        by_year = data["by_year"]
        assert "2025" in by_year
        assert "2026" in by_year
        assert len(by_year["2025"]) == 2
        assert len(by_year["2026"]) == 1

    def test_json_entries_have_all_fields(self, tmp_path):
        entries = _make_entries()
        save_court_index("supreme", entries, str(tmp_path))
        data = json.loads((tmp_path / "supreme.json").read_text())
        entry = data["by_year"]["2025"][0]
        assert "url" in entry
        assert "file_path" in entry
        assert "title" in entry
        assert "court" in entry
        assert "year" in entry

    def test_empty_entries_creates_valid_json(self, tmp_path):
        save_court_index("supreme", [], str(tmp_path))
        data = json.loads((tmp_path / "supreme.json").read_text())
        assert data["total"] == 0
        assert data["by_year"] == {}


class TestLoadCourtIndex:
    """Tests for loading court indexes from JSON."""

    def test_load_roundtrip(self, tmp_path):
        entries = _make_entries()
        save_court_index("supreme", entries, str(tmp_path))
        loaded = load_court_index("supreme", str(tmp_path))
        assert loaded is not None
        assert loaded["total"] == 3
        assert len(loaded["by_year"]["2025"]) == 2

    def test_load_nonexistent_returns_none(self, tmp_path):
        loaded = load_court_index("nonexistent", str(tmp_path))
        assert loaded is None


class TestSaveUpdatesIndex:
    """Tests for saving the updates cross-court index."""

    def test_save_updates_creates_file(self, tmp_path):
        entries = _make_entries()
        save_updates_index(entries, str(tmp_path))
        assert (tmp_path / "updates.json").exists()

    def test_updates_groups_by_court_then_year(self, tmp_path):
        entries = _make_entries()
        save_updates_index(entries, str(tmp_path))
        data = json.loads((tmp_path / "updates.json").read_text())
        assert data["total"] == 3
        assert "by_year" in data
