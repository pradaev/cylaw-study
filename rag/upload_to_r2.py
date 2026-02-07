"""Upload parsed case documents to Cloudflare R2.

Walks data/cases_parsed/ and uploads all .md files to the 'cylaw-docs'
R2 bucket using the S3-compatible API. Tracks progress and supports
resuming interrupted uploads.

Required env vars:
    CLOUDFLARE_ACCOUNT_ID
    CLOUDFLARE_R2_ACCESS_KEY_ID
    CLOUDFLARE_R2_SECRET_ACCESS_KEY

Usage:
    python -m rag.upload_to_r2
    python -m rag.upload_to_r2 --limit 100        # test with first 100 files
    python -m rag.upload_to_r2 --workers 20        # parallel uploads
    python -m rag.upload_to_r2 --stats             # show progress stats
"""

import argparse
import json
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
from botocore.config import Config
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CASES_DIR = PROJECT_ROOT / "data" / "cases_parsed"
PROGRESS_FILE = PROJECT_ROOT / "data" / "r2_upload_progress.json"
BUCKET_NAME = "cylaw-docs"

DEFAULT_WORKERS = 10
CONTENT_TYPE = "text/markdown; charset=utf-8"


def get_s3_client():
    """Create an S3 client configured for Cloudflare R2."""
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    access_key = os.environ.get("CLOUDFLARE_R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("CLOUDFLARE_R2_SECRET_ACCESS_KEY")

    if not all([account_id, access_key, secret_key]):
        logger.error(
            "Missing R2 credentials. Set CLOUDFLARE_ACCOUNT_ID, "
            "CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY in .env"
        )
        sys.exit(1)

    endpoint_url = f"https://{account_id}.r2.cloudflarestorage.com"

    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(
            retries={"max_attempts": 3, "mode": "adaptive"},
            max_pool_connections=50,
        ),
    )


def discover_files() -> list[Path]:
    """Find all .md files in data/cases_parsed/."""
    if not CASES_DIR.exists():
        logger.error("Directory not found: %s", CASES_DIR)
        sys.exit(1)

    files = sorted(CASES_DIR.rglob("*.md"))
    logger.info("Found %d .md files in %s", len(files), CASES_DIR)
    return files


def load_progress() -> set[str]:
    """Load set of already-uploaded R2 keys."""
    if PROGRESS_FILE.exists():
        data = json.loads(PROGRESS_FILE.read_text())
        return set(data.get("uploaded", []))
    return set()


def save_progress(uploaded: set[str]) -> None:
    """Save uploaded keys to progress file."""
    PROGRESS_FILE.write_text(
        json.dumps({"uploaded": sorted(uploaded), "count": len(uploaded)}, indent=0)
    )


def file_to_key(filepath: Path) -> str:
    """Convert absolute file path to R2 object key (relative path)."""
    return str(filepath.relative_to(CASES_DIR))


def upload_file(s3_client, filepath: Path, key: str) -> tuple[str, bool, str]:
    """Upload a single file to R2. Returns (key, success, error_msg)."""
    try:
        content = filepath.read_bytes()
        s3_client.put_object(
            Bucket=BUCKET_NAME,
            Key=key,
            Body=content,
            ContentType=CONTENT_TYPE,
        )
        return key, True, ""
    except Exception as exc:
        return key, False, str(exc)[:200]


def upload_all(
    files: list[Path],
    workers: int = DEFAULT_WORKERS,
    limit: int | None = None,
) -> None:
    """Upload files to R2 in parallel with progress tracking."""
    uploaded = load_progress()
    logger.info("Progress: %d files already uploaded", len(uploaded))

    # Filter out already-uploaded files
    pending = []
    for f in files:
        key = file_to_key(f)
        if key not in uploaded:
            pending.append((f, key))

    if limit:
        pending = pending[:limit]

    if not pending:
        logger.info("All files already uploaded. Nothing to do.")
        return

    logger.info(
        "Uploading %d files with %d workers (skipping %d already done)",
        len(pending), workers, len(uploaded),
    )

    s3_client = get_s3_client()
    total = len(pending)
    done = 0
    errors = 0
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(upload_file, s3_client, filepath, key): key
            for filepath, key in pending
        }

        for future in as_completed(futures):
            key, success, error_msg = future.result()
            done += 1

            if success:
                uploaded.add(key)
            else:
                errors += 1
                logger.warning("Failed to upload %s: %s", key, error_msg)

            # Progress report every 1000 files
            if done % 1000 == 0 or done == total:
                elapsed = time.time() - start_time
                rate = done / elapsed if elapsed > 0 else 0
                eta = (total - done) / rate if rate > 0 else 0
                logger.info(
                    "Progress: %d/%d (%.1f%%) | %.0f files/s | ETA: %.0fs | Errors: %d",
                    done, total, done / total * 100, rate, eta, errors,
                )
                # Save progress periodically
                save_progress(uploaded)

    save_progress(uploaded)

    elapsed = time.time() - start_time
    logger.info(
        "Upload complete: %d/%d files in %.1fs (%.0f files/s). Errors: %d",
        done - errors, total, elapsed, (done - errors) / elapsed if elapsed > 0 else 0, errors,
    )


def show_stats() -> None:
    """Show upload progress statistics."""
    files = discover_files()
    uploaded = load_progress()

    total = len(files)
    done = len(uploaded)
    remaining = total - done

    print(f"\nR2 Upload Statistics")
    print(f"{'─' * 40}")
    print(f"Total .md files:    {total:>10,}")
    print(f"Already uploaded:   {done:>10,}")
    print(f"Remaining:          {remaining:>10,}")
    print(f"Progress:           {done/total*100:>9.1f}%" if total > 0 else "")
    print(f"Progress file:      {PROGRESS_FILE}")


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Upload parsed cases to Cloudflare R2")
    parser.add_argument("--limit", type=int, help="Upload only N files (for testing)")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="Parallel upload threads")
    parser.add_argument("--stats", action="store_true", help="Show progress stats and exit")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.stats:
        show_stats()
        return

    files = discover_files()
    upload_all(files, workers=args.workers, limit=args.limit)


if __name__ == "__main__":
    main()
