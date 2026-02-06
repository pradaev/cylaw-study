#!/usr/bin/env python3
"""Convert existing CyLaw CSV databases for the aad/ court into JSON format.

The CSVs use pipe-delimited format with ISO-8859-7 encoding:
    #File name|Title|Number|Date|Citation page|Citation year

This script reads cases_non_reported_table.csv (the most complete CSV for aad/)
and converts it to the same JSON structure used by the scraper.
"""

import csv
import logging
import re
import sys
from pathlib import Path

from scraper.config import BASE_URL
from scraper.parser import CaseEntry
from scraper.storage import save_court_index

logger = logging.getLogger(__name__)

# CSV columns (pipe-delimited, first line is header)
CSV_HEADER_PREFIX = "#File name"
ENCODINGS_TO_TRY = ("iso-8859-7", "windows-1253", "latin-1", "utf-8")


def _detect_year_from_path(file_path: str) -> str:
    """Extract year from a path like /aad/meros_1/1996/... or /aad/2020/..."""
    m = re.search(r"/(\d{4})/", file_path)
    return m.group(1) if m else ""


def _read_csv_with_encoding(csv_path: str) -> str:
    """Read CSV file trying multiple encodings."""
    path = Path(csv_path)
    for enc in ENCODINGS_TO_TRY:
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    # Last resort
    return path.read_bytes().decode("latin-1")


def convert_csv_to_entries(csv_path: str) -> list[CaseEntry]:
    """Parse a pipe-delimited CSV file and return CaseEntry objects.

    Args:
        csv_path: Path to the CSV file.

    Returns:
        List of CaseEntry objects extracted from the CSV.
    """
    content = _read_csv_with_encoding(csv_path)
    lines = content.splitlines()

    entries: list[CaseEntry] = []
    seen_paths: set[str] = set()
    skipped = 0

    for i, line in enumerate(lines):
        # Skip header
        if line.startswith(CSV_HEADER_PREFIX) or line.startswith("#"):
            continue

        # Skip empty lines
        line = line.strip()
        if not line:
            continue

        parts = line.split("|")
        if len(parts) < 2:
            skipped += 1
            continue

        file_path = parts[0].strip()
        title = parts[1].strip() if len(parts) > 1 else ""
        date = parts[3].strip() if len(parts) > 3 else ""

        if not file_path:
            skipped += 1
            continue

        # Normalize path: ensure it starts with /apofaseis/aad/ or /aad/
        # The CSV uses /aad/ but the website uses /apofaseis/aad/
        if file_path.startswith("/aad/"):
            normalized_path = f"/apofaseis{file_path}"
        elif file_path.startswith("/apofaseis/aad/"):
            normalized_path = file_path
        else:
            normalized_path = file_path

        if normalized_path in seen_paths:
            continue
        seen_paths.add(normalized_path)

        # Build URL using the open.pl gateway
        url = f"{BASE_URL}/cgi-bin/open.pl?file={normalized_path}"
        year = _detect_year_from_path(file_path)

        entries.append(
            CaseEntry(
                url=url,
                file_path=normalized_path,
                title=title,
                court="aad",
                year=year,
                date=date,
            )
        )

    if skipped:
        logger.warning("Skipped %d malformed CSV lines", skipped)

    logger.info(
        "Parsed %d entries from CSV: %s", len(entries), csv_path
    )
    return entries


def main() -> None:
    """Convert aad CSV to JSON format."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    project_root = Path(__file__).resolve().parent.parent
    csv_path = project_root / "data" / "cases_non_reported_table.csv"
    output_dir = str(project_root / "data" / "indexes")

    if not csv_path.exists():
        print(
            f"CSV file not found: {csv_path}\n"
            "Download it first with:\n"
            "  curl -s https://www.cylaw.org/apofaseis/database/"
            "cases_non_reported_table.csv -o data/cases_non_reported_table.csv"
        )
        sys.exit(1)

    entries = convert_csv_to_entries(str(csv_path))
    save_court_index("aad_csv", entries, output_dir)
    print(f"\nDone: {len(entries)} aad entries converted from CSV.")


if __name__ == "__main__":
    main()
