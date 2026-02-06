#!/usr/bin/env python3
"""Bulk downloader for CyLaw court case HTML documents.

Downloads all case files listed in the JSON indexes using parallel threads.
Supports resume: skips already-downloaded files automatically.

Usage:
    # Test on first 20 files:
    python -m scraper.downloader --limit 20

    # Download everything (30 threads, 0.5s delay):
    python -m scraper.downloader

    # Custom settings:
    python -m scraper.downloader --threads 50 --delay 0.3
"""

import argparse
import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

import requests
from tqdm import tqdm

from scraper.config import BASE_URL, USER_AGENT

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Default settings
DEFAULT_THREADS = 30
DEFAULT_DELAY = 0.5  # seconds between requests per thread
DEFAULT_TIMEOUT = 30
DEFAULT_MAX_RETRIES = 3
DEFAULT_OUTPUT_DIR = "data/cases"
DEFAULT_INDEX_DIR = "data/indexes"
PROGRESS_FILE = "data/download_progress.txt"

# Encoding handling — site uses Greek ISO-8859-7
ENCODINGS_TO_TRY = ("utf-8", "iso-8859-7", "windows-1253")


class DownloadStats:
    """Thread-safe download statistics."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.downloaded = 0
        self.skipped = 0
        self.failed = 0
        self.total_bytes = 0
        self.errors: list[tuple[str, str]] = []

    def record_download(self, size: int) -> None:
        with self._lock:
            self.downloaded += 1
            self.total_bytes += size

    def record_skip(self) -> None:
        with self._lock:
            self.skipped += 1

    def record_failure(self, file_path: str, error: str) -> None:
        with self._lock:
            self.failed += 1
            self.errors.append((file_path, error))


class ProgressTracker:
    """Thread-safe progress tracker that persists to disk.

    Records successfully downloaded file_paths so that the download
    can be resumed after interruption.
    """

    def __init__(self, progress_file: str) -> None:
        self._path = Path(progress_file)
        self._lock = threading.Lock()
        self._downloaded: set[str] = set()
        self._load()

    def _load(self) -> None:
        """Load previously downloaded paths from disk."""
        if self._path.exists():
            with open(self._path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        self._downloaded.add(line)
            logger.info(
                "Resumed: %d files already downloaded.", len(self._downloaded)
            )

    def is_done(self, file_path: str) -> bool:
        """Check if a file has already been downloaded."""
        return file_path in self._downloaded

    def mark_done(self, file_path: str) -> None:
        """Record a successful download."""
        with self._lock:
            self._downloaded.add(file_path)
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(file_path + "\n")

    @property
    def count(self) -> int:
        return len(self._downloaded)


def collect_unique_file_paths(index_dir: str) -> list[dict]:
    """Read all JSON indexes and collect unique file entries.

    Returns:
        List of dicts with 'file_path', 'url', 'title', 'court'.
    """
    index_path = Path(index_dir)
    seen: set[str] = set()
    entries: list[dict] = []

    for json_file in sorted(index_path.glob("*.json")):
        data = json.loads(json_file.read_text(encoding="utf-8"))
        for year_entries in data.get("by_year", {}).values():
            for entry in year_entries:
                fp = entry["file_path"]
                if fp not in seen:
                    seen.add(fp)
                    entries.append(entry)

    return entries


def download_one(
    entry: dict,
    output_dir: Path,
    session: requests.Session,
    delay: float,
    max_retries: int,
    timeout: int,
    stats: DownloadStats,
    progress: ProgressTracker,
) -> bool:
    """Download a single case file.

    Args:
        entry: Dict with 'file_path' and 'url'.
        output_dir: Base directory for saving files.
        session: requests.Session (thread-local recommended).
        delay: Seconds to sleep after each request.
        max_retries: Max retry attempts on failure.
        timeout: HTTP timeout in seconds.
        stats: Shared statistics tracker.
        progress: Shared progress tracker.

    Returns:
        True if downloaded or already existed, False on failure.
    """
    file_path = entry["file_path"]

    # Skip if already downloaded (resume support)
    if progress.is_done(file_path):
        stats.record_skip()
        return True

    # Also skip if file exists on disk (belt-and-suspenders)
    local_path = output_dir / file_path.lstrip("/")
    if local_path.exists() and local_path.stat().st_size > 0:
        progress.mark_done(file_path)
        stats.record_skip()
        return True

    # Build download URL — use direct file access (faster than CGI)
    url = f"{BASE_URL}{file_path}"

    for attempt in range(1, max_retries + 1):
        try:
            resp = session.get(url, timeout=timeout)

            if resp.status_code == 404:
                # Try the CGI gateway as fallback
                url_cgi = entry.get("url", "")
                if url_cgi and "open.pl" in url_cgi:
                    resp = session.get(url_cgi, timeout=timeout)

            if resp.status_code == 200:
                # Ensure directory exists
                local_path.parent.mkdir(parents=True, exist_ok=True)

                # Handle encoding
                content = resp.content
                local_path.write_bytes(content)

                progress.mark_done(file_path)
                stats.record_download(len(content))

                if delay > 0:
                    time.sleep(delay)
                return True

            if resp.status_code >= 500:
                logger.debug(
                    "Server error %d for %s (attempt %d/%d)",
                    resp.status_code,
                    file_path,
                    attempt,
                    max_retries,
                )
                time.sleep(2 ** attempt)
                continue

            # 4xx error — don't retry
            stats.record_failure(
                file_path, f"HTTP {resp.status_code}"
            )
            if delay > 0:
                time.sleep(delay)
            return False

        except requests.RequestException as exc:
            logger.debug(
                "Error downloading %s (attempt %d/%d): %s",
                file_path,
                attempt,
                max_retries,
                exc,
            )
            if attempt < max_retries:
                time.sleep(2 ** attempt)

    stats.record_failure(file_path, "Max retries exceeded")
    return False


def _make_session() -> requests.Session:
    """Create a configured requests session."""
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT})
    # Reuse TCP connections
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=50,
        pool_maxsize=50,
        max_retries=0,  # we handle retries ourselves
    )
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def run_download(
    entries: list[dict],
    output_dir: str,
    threads: int = DEFAULT_THREADS,
    delay: float = DEFAULT_DELAY,
    max_retries: int = DEFAULT_MAX_RETRIES,
    timeout: int = DEFAULT_TIMEOUT,
    progress_file: str = PROGRESS_FILE,
    limit: Optional[int] = None,
) -> DownloadStats:
    """Download case files in parallel.

    Args:
        entries: List of entry dicts from the indexes.
        output_dir: Base directory for saving files.
        threads: Number of parallel download threads.
        delay: Seconds between requests per thread.
        max_retries: Max retries per file.
        timeout: HTTP timeout.
        progress_file: Path to the progress tracking file.
        limit: If set, only download this many files (for testing).

    Returns:
        DownloadStats with results.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    progress = ProgressTracker(progress_file)
    stats = DownloadStats()

    if limit:
        entries = entries[:limit]

    total = len(entries)
    logger.info(
        "Starting download: %d files, %d threads, %.1fs delay",
        total,
        threads,
        delay,
    )

    # Thread-local sessions for connection reuse
    thread_local = threading.local()

    def get_session() -> requests.Session:
        if not hasattr(thread_local, "session"):
            thread_local.session = _make_session()
        return thread_local.session

    with ThreadPoolExecutor(max_workers=threads) as executor:
        futures = {}
        for entry in entries:
            future = executor.submit(
                download_one,
                entry=entry,
                output_dir=output_path,
                session=get_session(),
                delay=delay,
                max_retries=max_retries,
                timeout=timeout,
                stats=stats,
                progress=progress,
            )
            futures[future] = entry["file_path"]

        with tqdm(
            total=total,
            desc="Downloading",
            unit="files",
            dynamic_ncols=True,
        ) as pbar:
            for future in as_completed(futures):
                pbar.update(1)
                pbar.set_postfix(
                    ok=stats.downloaded,
                    skip=stats.skipped,
                    fail=stats.failed,
                    refresh=False,
                )

    return stats


def main() -> None:
    """CLI entrypoint for the bulk downloader."""
    parser = argparse.ArgumentParser(
        description="Bulk download CyLaw court case documents"
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=DEFAULT_THREADS,
        help=f"Number of parallel download threads (default: {DEFAULT_THREADS})",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY,
        help=f"Delay between requests per thread in seconds (default: {DEFAULT_DELAY})",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Download only first N files (for testing)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help=f"Output directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--index-dir",
        type=str,
        default=None,
        help=f"Index directory (default: {DEFAULT_INDEX_DIR})",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )
    args = parser.parse_args()

    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    index_dir = args.index_dir or str(PROJECT_ROOT / DEFAULT_INDEX_DIR)
    output_dir = args.output_dir or str(PROJECT_ROOT / DEFAULT_OUTPUT_DIR)
    progress_file = str(PROJECT_ROOT / PROGRESS_FILE)

    # Collect all unique entries
    logger.info("Reading indexes from %s ...", index_dir)
    entries = collect_unique_file_paths(index_dir)
    logger.info("Found %d unique documents to download.", len(entries))

    stats = run_download(
        entries=entries,
        output_dir=output_dir,
        threads=args.threads,
        delay=args.delay,
        progress_file=progress_file,
        limit=args.limit,
    )

    # Summary
    print(f"\n{'=' * 50}")
    print(f"Download complete!")
    print(f"  Downloaded: {stats.downloaded:>8}")
    print(f"  Skipped:    {stats.skipped:>8}  (already existed)")
    print(f"  Failed:     {stats.failed:>8}")
    print(f"  Total size: {stats.total_bytes / (1024*1024):.1f} MB")
    print(f"{'=' * 50}")

    if stats.errors:
        error_log = PROJECT_ROOT / "data" / "download_errors.log"
        with open(error_log, "w", encoding="utf-8") as f:
            for fp, err in stats.errors:
                f.write(f"{fp}\t{err}\n")
        print(f"\nFailed downloads logged to: {error_log}")
        # Show first few errors
        print("First errors:")
        for fp, err in stats.errors[:5]:
            print(f"  {fp}: {err}")


if __name__ == "__main__":
    main()
