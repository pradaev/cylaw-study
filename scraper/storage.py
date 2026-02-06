"""Storage module for saving and loading court case indexes as JSON.

Produces JSON files organized by court with cases grouped by year.
"""

import json
import logging
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from scraper.parser import CaseEntry

logger = logging.getLogger(__name__)


def _group_by_year(
    entries: list[CaseEntry],
) -> dict[str, list[dict]]:
    """Group case entries by year, converting each to a dict."""
    by_year: dict[str, list[dict]] = defaultdict(list)
    for entry in entries:
        year_key = entry.year if entry.year else "unknown"
        by_year[year_key].append(entry.to_dict())
    # Sort years descending for readability
    return dict(sorted(by_year.items(), reverse=True))


def save_court_index(
    court_id: str,
    entries: list[CaseEntry],
    output_dir: str,
) -> Path:
    """Save a court's case index as a JSON file.

    Creates a file at {output_dir}/{court_id}.json with structure:
    {
        "court": "courtOfAppeal",
        "scraped_at": "2026-02-06T...",
        "total": 1111,
        "by_year": {"2026": [...], "2025": [...]}
    }

    Args:
        court_id: The court identifier.
        entries: List of CaseEntry objects to save.
        output_dir: Directory where the JSON file will be created.

    Returns:
        Path to the created JSON file.
    """
    os.makedirs(output_dir, exist_ok=True)
    output_path = Path(output_dir) / f"{court_id}.json"

    data = {
        "court": court_id,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "total": len(entries),
        "by_year": _group_by_year(entries),
    }

    output_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logger.info(
        "Saved %d entries for court '%s' to %s",
        len(entries),
        court_id,
        output_path,
    )
    return output_path


def save_updates_index(
    entries: list[CaseEntry],
    output_dir: str,
) -> Path:
    """Save the cross-court updates index as a JSON file.

    Args:
        entries: List of CaseEntry objects from the updates page.
        output_dir: Directory where updates.json will be created.

    Returns:
        Path to the created JSON file.
    """
    os.makedirs(output_dir, exist_ok=True)
    output_path = Path(output_dir) / "updates.json"

    data = {
        "source": "updates.html",
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "total": len(entries),
        "by_year": _group_by_year(entries),
    }

    output_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logger.info("Saved %d update entries to %s", len(entries), output_path)
    return output_path


def load_court_index(
    court_id: str,
    output_dir: str,
) -> Optional[dict]:
    """Load a previously saved court index.

    Args:
        court_id: The court identifier.
        output_dir: Directory containing the JSON files.

    Returns:
        Parsed JSON dict, or None if file does not exist.
    """
    path = Path(output_dir) / f"{court_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
