#!/usr/bin/env python3
"""CLI entrypoint for the CyLaw index scraper.

Usage:
    python -m scraper.scrape --court supreme
    python -m scraper.scrape --all
    python -m scraper.scrape --updates
    python -m scraper.scrape --stats
"""

import argparse
import json
import logging
import sys
from pathlib import Path

from tqdm import tqdm

from scraper.config import (
    COURTS,
    UPDATES_URL,
    CACHE_DIR,
    INDEX_DIR,
    get_court,
)
from scraper.fetcher import Fetcher
from scraper.parser import (
    CaseEntry,
    parse_court_main_index,
    parse_year_index,
    parse_updates_page,
)
from scraper.storage import save_court_index, save_updates_index, load_court_index

logger = logging.getLogger(__name__)

# Project root is one level up from scraper/
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _resolve_dir(relative_path: str) -> str:
    """Resolve a path relative to the project root."""
    return str(PROJECT_ROOT / relative_path)


def scrape_court(court_id: str, fetcher: Fetcher, output_dir: str) -> int:
    """Scrape all year indexes for a single court.

    Args:
        court_id: Court identifier from the registry.
        fetcher: Configured Fetcher instance.
        output_dir: Directory for JSON output.

    Returns:
        Total number of case entries found.
    """
    court = get_court(court_id)
    logger.info("Scraping court: %s", court_id)

    # Step 1: Fetch main index to discover year pages
    main_html = fetcher.fetch(court.main_index_url())
    year_urls = parse_court_main_index(main_html, court_id)

    if not year_urls:
        # Fallback: generate year URLs from config range
        logger.warning(
            "No year links found on main index for %s. "
            "Falling back to configured year range %d-%d.",
            court_id,
            court.year_start,
            court.year_end,
        )
        year_urls = []
        for year in range(court.year_start, court.year_end + 1):
            url = court.year_index_url(year)
            # Convert absolute URL to relative path for consistency
            relative = url.replace("https://www.cylaw.org", "")
            year_urls.append(relative)

    # Step 2: Fetch each year page and extract cases
    all_entries: list[CaseEntry] = []
    desc = f"  {court_id} years"
    for year_url in tqdm(year_urls, desc=desc, leave=False):
        # Make URL absolute
        if year_url.startswith("/"):
            full_url = f"https://www.cylaw.org{year_url}"
        else:
            full_url = year_url

        # Extract year from URL
        year = _extract_year_from_url(year_url)

        try:
            html = fetcher.fetch(full_url)
            entries = parse_year_index(html, court_id, year)
            all_entries.extend(entries)
            logger.info(
                "  %s year %s: %d cases", court_id, year, len(entries)
            )
        except RuntimeError as exc:
            logger.error("  Failed to fetch %s: %s", full_url, exc)

    # Step 3: Save
    save_court_index(court_id, all_entries, output_dir)
    logger.info(
        "Court %s: %d total cases saved.", court_id, len(all_entries)
    )
    return len(all_entries)


def _extract_year_from_url(url: str) -> str:
    """Extract a 4-digit year from a URL string.

    Handles patterns like:
        index_2026.html         → "2026"
        index_pol_2005.html     → "2005"
        2025/index.html         → "2025"
        index_1.html            → "vol_1"  (RSCC volumes)
    """
    import re

    m = re.search(r"(\d{4})", url)
    if m:
        return m.group(1)
    # Fallback: extract short number for volume-based indexes (RSCC)
    m = re.search(r"index_(\d+)\.html", url)
    if m:
        return f"vol_{m.group(1)}"
    return "unknown"


def scrape_updates(fetcher: Fetcher, output_dir: str) -> int:
    """Scrape the updates.html page.

    Args:
        fetcher: Configured Fetcher instance.
        output_dir: Directory for JSON output.

    Returns:
        Total number of case entries found.
    """
    logger.info("Scraping updates page...")
    html = fetcher.fetch(UPDATES_URL)
    entries = parse_updates_page(html)
    save_updates_index(entries, output_dir)
    logger.info("Updates: %d total cases saved.", len(entries))
    return len(entries)


def print_stats(output_dir: str) -> None:
    """Print summary statistics for all saved indexes.

    Args:
        output_dir: Directory containing JSON index files.
    """
    output_path = Path(output_dir)
    if not output_path.exists():
        print("No index data found. Run scraping first.")
        return

    total_all = 0
    print(f"\n{'Court':<25} {'Total':>8}  Year range")
    print("-" * 60)

    for json_file in sorted(output_path.glob("*.json")):
        data = json.loads(json_file.read_text(encoding="utf-8"))
        court = data.get("court", data.get("source", json_file.stem))
        total = data.get("total", 0)
        by_year = data.get("by_year", {})
        years = sorted(by_year.keys())
        year_range = f"{years[0]}–{years[-1]}" if years else "—"
        print(f"{court:<25} {total:>8}  {year_range}")
        total_all += total

    print("-" * 60)
    print(f"{'TOTAL':<25} {total_all:>8}")
    print()


def main() -> None:
    """Main CLI entrypoint."""
    parser = argparse.ArgumentParser(
        description="CyLaw Index Scraper — extract court case indexes"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--court",
        type=str,
        help="Scrape a single court by ID (e.g., 'supreme', 'courtOfAppeal')",
    )
    group.add_argument(
        "--all",
        action="store_true",
        help="Scrape all courts",
    )
    group.add_argument(
        "--updates",
        action="store_true",
        help="Scrape the updates.html page only",
    )
    group.add_argument(
        "--stats",
        action="store_true",
        help="Print summary statistics for saved indexes",
    )

    parser.add_argument(
        "--cache-dir",
        type=str,
        default=None,
        help=f"Cache directory (default: {CACHE_DIR})",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help=f"Output directory for JSON indexes (default: {INDEX_DIR})",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Disable disk caching of fetched pages",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    args = parser.parse_args()

    # Configure logging
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    # Resolve directories
    cache_dir = args.cache_dir or _resolve_dir(CACHE_DIR)
    output_dir = args.output_dir or _resolve_dir(INDEX_DIR)

    if args.no_cache:
        cache_dir = None

    if args.stats:
        print_stats(output_dir)
        return

    fetcher = Fetcher(cache_dir=cache_dir if not args.no_cache else None)

    if args.court:
        try:
            count = scrape_court(args.court, fetcher, output_dir)
            print(f"\nDone: {count} cases found for court '{args.court}'.")
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            sys.exit(1)

    elif args.all:
        grand_total = 0
        for court in tqdm(COURTS, desc="Courts"):
            count = scrape_court(court.court_id, fetcher, output_dir)
            grand_total += count
        print(f"\nDone: {grand_total} total cases across all courts.")

    elif args.updates:
        count = scrape_updates(fetcher, output_dir)
        print(f"\nDone: {count} cases from updates page.")


if __name__ == "__main__":
    main()
