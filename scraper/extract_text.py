#!/usr/bin/env python3
"""Extract structured Markdown from downloaded court case files (HTML + PDF).

Converts each case to Markdown preserving:
- Document structure: title, headings, paragraphs
- Formatting: bold, italic, underline
- Cross-references: links to other cases as [case name](file_path.md)
- Legislation references: preserved as links
- Lists, tables, horizontal rules

Usage:
    python -m scraper.extract_text              # Process everything
    python -m scraper.extract_text --limit 50   # Test on first N files
    python -m scraper.extract_text --stats      # Count words in parsed files
    python -m scraper.extract_text --court aad  # Specific court only
"""

import argparse
import logging
import multiprocessing
import re
import sys
import threading
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

from bs4 import BeautifulSoup, NavigableString, Tag
from tqdm import tqdm

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_INPUT_DIR = "data/cases"
DEFAULT_OUTPUT_DIR = "data/cases_parsed"
DEFAULT_WORKERS = multiprocessing.cpu_count()

# Encodings to try for HTML files (cylaw uses Greek)
ENCODINGS = ("utf-8", "iso-8859-7", "windows-1253", "latin-1")

# Footer markers — stop converting at these
FOOTER_MARKERS = [
    "cylaw.org",
    "Από το ΚΙΝOΠ",
    "CyLii",
    "Παγκύπριο Δικηγορικό Σύλλογο",
    "Παγκύπριου Δικηγορικού Συλλόγου",
]


class ExtractionStats:
    """Thread-safe statistics for text extraction."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.processed = 0
        self.skipped = 0
        self.failed = 0
        self.total_words = 0
        self.total_chars = 0
        self.total_refs = 0
        self.words_by_court: dict[str, int] = defaultdict(int)
        self.files_by_court: dict[str, int] = defaultdict(int)
        self.refs_by_court: dict[str, int] = defaultdict(int)
        self.words_by_format: dict[str, int] = defaultdict(int)
        self.files_by_format: dict[str, int] = defaultdict(int)
        self.errors: list[tuple[str, str]] = []

    def record_success(
        self, court: str, fmt: str, word_count: int, char_count: int,
        ref_count: int = 0,
    ) -> None:
        with self._lock:
            self.processed += 1
            self.total_words += word_count
            self.total_chars += char_count
            self.total_refs += ref_count
            self.words_by_court[court] += word_count
            self.files_by_court[court] += 1
            self.refs_by_court[court] += ref_count
            self.words_by_format[fmt] += word_count
            self.files_by_format[fmt] += 1

    def record_skip(self) -> None:
        with self._lock:
            self.skipped += 1

    def record_failure(self, path: str, error: str) -> None:
        with self._lock:
            self.failed += 1
            self.errors.append((path, error))


def _read_html(path: Path) -> str:
    """Read an HTML file trying multiple encodings."""
    for enc in ENCODINGS:
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_bytes().decode("latin-1")


def _detect_court(rel_path: Path) -> str:
    """Detect court from relative path."""
    path_str = str(rel_path)
    if "apofaseis/aad" in path_str:
        return "aad"
    if "apofaseis/epa" in path_str:
        return "epa"
    if "apofaseis/aap" in path_str:
        return "aap"
    if "apofaseis/dioikitiko" in path_str:
        return "dioikitiko"
    if "clr" in path_str:
        return "clr"
    if rel_path.parts:
        return rel_path.parts[0]
    return "unknown"


def _extract_file_path_from_href(href: str) -> Optional[str]:
    """Extract file= parameter from an open.pl URL.

    Returns the local .md path that will correspond to the referenced case.
    """
    m = re.search(r"file=([^&\"'\s]+)", href)
    if m:
        fp = m.group(1)
        # Normalize: remove leading /apofaseis prefix duplication, etc.
        return fp
    return None


def _href_to_md_link(href: str) -> Optional[str]:
    """Convert an open.pl href to a relative path to the .md version."""
    fp = _extract_file_path_from_href(href)
    if fp:
        # Change extension to .md (handle .html, .htm, .pdf)
        fp = re.sub(r"\.(html?|htm|pdf)$", ".md", fp, flags=re.IGNORECASE)
        if not fp.endswith(".md"):
            fp += ".md"
        return fp
    return None


def _is_footer(text: str) -> bool:
    """Check if text contains a footer marker."""
    return any(marker in text for marker in FOOTER_MARKERS)


def _convert_element(el: Tag, depth: int = 0) -> str:
    """Recursively convert an HTML element to Markdown.

    Args:
        el: BeautifulSoup Tag or NavigableString.
        depth: Nesting depth (to prevent infinite recursion).

    Returns:
        Markdown string.
    """
    if depth > 50:
        return ""

    if isinstance(el, NavigableString):
        text = str(el)
        # Collapse whitespace in inline text
        text = re.sub(r"[ \t]+", " ", text)
        return text

    if not isinstance(el, Tag):
        return ""

    tag = el.name.lower() if el.name else ""

    # Skip these entirely
    if tag in ("script", "style", "meta", "link", "img"):
        return ""

    # Get inner content by recursing into children
    def inner() -> str:
        parts = []
        for child in el.children:
            if isinstance(child, NavigableString):
                t = str(child)
                t = re.sub(r"[ \t]+", " ", t)
                parts.append(t)
            elif isinstance(child, Tag):
                parts.append(_convert_element(child, depth + 1))
        return "".join(parts)

    content = inner().strip()
    if not content:
        return ""

    # Check for footer — stop processing
    if _is_footer(content):
        return ""

    # --- Block-level elements ---

    if tag in ("h1",):
        return f"\n\n# {content}\n\n"
    if tag in ("h2",):
        return f"\n\n## {content}\n\n"
    if tag in ("h3",):
        return f"\n\n### {content}\n\n"
    if tag in ("h4", "h5", "h6"):
        return f"\n\n#### {content}\n\n"

    if tag == "p":
        if not content.strip():
            return ""
        return f"\n\n{content}\n\n"

    if tag == "br":
        return "  \n"

    if tag == "hr":
        return "\n\n---\n\n"

    if tag == "div":
        return f"\n\n{content}\n\n"

    if tag == "blockquote":
        lines = content.split("\n")
        quoted = "\n".join(f"> {line}" for line in lines if line.strip())
        return f"\n\n{quoted}\n\n"

    # Lists
    if tag in ("ul", "dir"):
        items = []
        for li in el.find_all("li", recursive=False):
            li_text = _convert_element(li, depth + 1).strip()
            if li_text:
                items.append(f"- {li_text}")
        # If no <li> found, treat direct children as items
        if not items:
            return f"\n\n{content}\n\n"
        return "\n\n" + "\n".join(items) + "\n\n"

    if tag == "ol":
        items = []
        for i, li in enumerate(el.find_all("li", recursive=False), 1):
            li_text = _convert_element(li, depth + 1).strip()
            if li_text:
                items.append(f"{i}. {li_text}")
        if not items:
            return f"\n\n{content}\n\n"
        return "\n\n" + "\n".join(items) + "\n\n"

    if tag == "li":
        return content

    # Tables — preserve as simple Markdown
    if tag == "table":
        return _convert_table(el, depth)

    if tag in ("tr", "td", "th", "thead", "tbody", "tfoot"):
        return content

    # --- Inline elements ---

    if tag == "a":
        href = el.get("href", "")
        if not href or href.startswith("#"):
            return content

        # Case cross-reference
        if "open.pl" in href:
            md_path = _href_to_md_link(href)
            if md_path:
                return f"[{content}]({md_path})"

        # Legislation reference
        if "nomoi" in href or "nomothesia" in href:
            return f"[{content}]({href})"

        # Other external links
        if href.startswith("http"):
            return f"[{content}]({href})"

        return content

    if tag == "b" or tag == "strong":
        if content:
            return f"**{content}**"
        return ""

    if tag in ("i", "em"):
        if content:
            return f"*{content}*"
        return ""

    if tag == "u":
        # No native underline in Markdown, use emphasis
        if content:
            return f"*{content}*"
        return ""

    if tag == "sup":
        return content

    if tag == "sub":
        return content

    # Default: just return inner content
    return content


def _convert_table(table: Tag, depth: int) -> str:
    """Convert an HTML table to Markdown table format."""
    rows = table.find_all("tr")
    if not rows:
        return ""

    md_rows: list[list[str]] = []
    for row in rows:
        cells = row.find_all(["td", "th"])
        md_cells = []
        for cell in cells:
            cell_text = _convert_element(cell, depth + 1).strip()
            cell_text = cell_text.replace("|", "\\|")
            cell_text = re.sub(r"\s+", " ", cell_text)
            md_cells.append(cell_text)
        if md_cells:
            md_rows.append(md_cells)

    if not md_rows:
        return ""

    # Normalize column count
    max_cols = max(len(r) for r in md_rows)
    for row in md_rows:
        while len(row) < max_cols:
            row.append("")

    lines = []
    # Header row
    lines.append("| " + " | ".join(md_rows[0]) + " |")
    lines.append("| " + " | ".join("---" for _ in md_rows[0]) + " |")
    # Data rows
    for row in md_rows[1:]:
        lines.append("| " + " | ".join(row) + " |")

    return "\n\n" + "\n".join(lines) + "\n\n"


def _normalize_markdown(md: str) -> str:
    """Clean up generated Markdown: fix excessive whitespace."""
    # Collapse multiple blank lines to max 2
    md = re.sub(r"\n{3,}", "\n\n", md)
    # Remove trailing whitespace per line
    lines = [line.rstrip() for line in md.split("\n")]
    md = "\n".join(lines)
    # Remove leading/trailing whitespace
    return md.strip() + "\n"


def _count_refs(md: str) -> int:
    """Count case cross-references in Markdown text."""
    return len(re.findall(r"\]\([^)]*\.md\)", md))


def _strip_metadata_sections(html: str) -> str:
    """Remove ECLI metadata sections between sections_start and sections_end.

    These are HTML comments like:
        <!--sections_start-->
        <!--sino section ecliaccessRights-->
        public
        ...
        <!--sections_end-->

    The content between these markers is technical metadata, not case text.
    """
    # Remove the sections block (ECLI metadata)
    html = re.sub(
        r"<!---?sections_start-?--?>.*?<!---?sections_end-?--?>",
        "",
        html,
        flags=re.DOTALL,
    )
    # Remove any remaining sino comments
    html = re.sub(r"<!--sino\s+[^>]+-->", "", html)
    # Remove noteup markers (but keep the content between them)
    html = html.replace("<!---noteup_start--->", "")
    html = html.replace("<!---noteup_end--->", "")
    html = html.replace("<!--noteup_start-->", "")
    html = html.replace("<!--noteup_end-->", "")
    return html


def extract_markdown_from_html(path: Path) -> str:
    """Convert an HTML court case file to Markdown.

    Strips ECLI metadata sections, preserves case references and
    legislation links, converts formatting to Markdown.

    Args:
        path: Path to the HTML file.

    Returns:
        Markdown string with preserved structure and links.
    """
    raw = _read_html(path)

    # Handle server error artifacts
    if raw.startswith("Content-type:"):
        raw = raw.split("\n", 2)[-1]

    # Strip technical metadata before parsing
    raw = _strip_metadata_sections(raw)

    soup = BeautifulSoup(raw, "html.parser")

    # Remove script/style
    for tag in soup(["script", "style"]):
        tag.decompose()

    # Extract title
    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else ""

    # Convert body
    body = soup.find("body")
    if not body:
        body = soup

    md_parts: list[str] = []

    # Add title as H1 if present
    if title:
        md_parts.append(f"# {title}\n\n")

    # Convert body content
    for child in body.children:
        if isinstance(child, NavigableString):
            text = str(child).strip()
            if text and not _is_footer(text):
                md_parts.append(text)
        elif isinstance(child, Tag):
            converted = _convert_element(child)
            if converted:
                md_parts.append(converted)

    md = "".join(md_parts)
    return _normalize_markdown(md)


def extract_markdown_from_pdf(path: Path) -> str:
    """Extract text from a PDF and format as Markdown.

    Args:
        path: Path to the PDF file.

    Returns:
        Markdown string with basic structure.
    """
    import pdfplumber

    text_parts: list[str] = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            page_text = page.extract_text()
            if page_text:
                if i > 0:
                    text_parts.append("\n\n---\n\n")
                text_parts.append(page_text)

    text = "".join(text_parts)

    # Add title from filename
    stem = path.stem.replace("_", " ")
    md = f"# {stem}\n\n{text}\n"

    return _normalize_markdown(md)


def _process_single(args: tuple) -> tuple:
    """Process a single file (designed for multiprocessing).

    Args:
        args: Tuple of (input_path_str, input_dir_str, output_dir_str).

    Returns:
        Tuple of (status, court, fmt, word_count, char_count, ref_count, error).
        status is one of: "ok", "skip", "fail".
    """
    input_path_str, input_dir_str, output_dir_str = args
    input_path = Path(input_path_str)
    input_dir = Path(input_dir_str)
    output_dir = Path(output_dir_str)

    rel_path = input_path.relative_to(input_dir)
    court = _detect_court(rel_path)
    suffix = input_path.suffix.lower()

    # Output path: same structure, .md extension
    out_path = output_dir / rel_path.with_suffix(".md")

    # Skip if already processed
    if out_path.exists() and out_path.stat().st_size > 0:
        return ("skip", court, "", 0, 0, 0, "")

    try:
        if suffix in (".htm", ".html", ""):
            md = extract_markdown_from_html(input_path)
            fmt = "html"
        elif suffix == ".pdf":
            md = extract_markdown_from_pdf(input_path)
            fmt = "pdf"
        else:
            return ("skip", court, "", 0, 0, 0, "")

        if not md or len(md.strip()) < 10:
            return ("fail", court, "", 0, 0, 0, "Empty or too short")

        # Strip Markdown syntax for word count
        plain = re.sub(r"[#*_\[\]\(\)|>-]", " ", md)
        word_count = len(plain.split())
        char_count = len(md)
        ref_count = _count_refs(md)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(md, encoding="utf-8")

        return ("ok", court, fmt, word_count, char_count, ref_count, "")

    except Exception as exc:
        return ("fail", court, "", 0, 0, 0, str(exc)[:200])


def collect_files(
    input_dir: Path, court: Optional[str] = None
) -> list[Path]:
    """Collect all processable files from the input directory."""
    all_files: list[Path] = []
    for f in input_dir.rglob("*"):
        if not f.is_file():
            continue
        if f.name == ".DS_Store":
            continue
        suffix = f.suffix.lower()
        if suffix in (".htm", ".html", ".pdf", ""):
            if f.stat().st_size < 100:
                continue
            if court:
                rel = f.relative_to(input_dir)
                file_court = _detect_court(rel)
                if file_court != court:
                    continue
            all_files.append(f)
    return sorted(all_files)


def print_stats(stats: ExtractionStats) -> None:
    """Print formatted extraction statistics."""
    print(f"\n{'=' * 70}")
    print("MARKDOWN EXTRACTION SUMMARY")
    print(f"{'=' * 70}")
    print(f"  Processed: {stats.processed:>10,}")
    print(f"  Skipped:   {stats.skipped:>10,}  (already done)")
    print(f"  Failed:    {stats.failed:>10,}")
    print(f"  {'─' * 35}")
    print(f"  Total words:          {stats.total_words:>12,}")
    print(f"  Total chars:          {stats.total_chars:>12,}")
    print(f"  Cross-references:     {stats.total_refs:>12,}")
    avg_words = (
        stats.total_words // stats.processed if stats.processed else 0
    )
    print(f"  Avg words/doc:        {avg_words:>12,}")

    print(f"\n{'─' * 70}")
    print(
        f"  {'Court':<25} {'Files':>8} {'Words':>12}"
        f" {'Refs':>8} {'Avg w/doc':>10}"
    )
    print(f"  {'─' * 63}")
    for court in sorted(
        stats.files_by_court,
        key=lambda c: stats.words_by_court[c],
        reverse=True,
    ):
        files = stats.files_by_court[court]
        words = stats.words_by_court[court]
        refs = stats.refs_by_court[court]
        avg = words // files if files else 0
        print(
            f"  {court:<25} {files:>8,} {words:>12,}"
            f" {refs:>8,} {avg:>10,}"
        )

    print(f"\n{'─' * 70}")
    print(f"  {'Format':<25} {'Files':>8} {'Words':>12}")
    print(f"  {'─' * 45}")
    for fmt in sorted(stats.files_by_format):
        files = stats.files_by_format[fmt]
        words = stats.words_by_format[fmt]
        print(f"  {fmt:<25} {files:>8,} {words:>12,}")

    if stats.errors:
        print(f"\n{'─' * 70}")
        print(f"  Errors ({len(stats.errors)} total):")
        for fp, err in stats.errors[:10]:
            print(f"    {fp}: {err[:80]}")

    print(f"{'=' * 70}")


def main() -> None:
    """CLI entrypoint."""
    parser = argparse.ArgumentParser(
        description="Extract Markdown from CyLaw court case files"
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Process only first N files (for testing)",
    )
    parser.add_argument(
        "--workers", type=int, default=DEFAULT_WORKERS,
        help=f"Parallel worker processes (default: {DEFAULT_WORKERS})",
    )
    parser.add_argument(
        "--court", type=str, default=None,
        help="Process only this court",
    )
    parser.add_argument(
        "--stats", action="store_true",
        help="Only count words in already-parsed files",
    )
    parser.add_argument(
        "--input-dir", type=str, default=None,
    )
    parser.add_argument(
        "--output-dir", type=str, default=None,
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true",
    )
    args = parser.parse_args()

    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    input_dir = Path(args.input_dir or (PROJECT_ROOT / DEFAULT_INPUT_DIR))
    output_dir = Path(args.output_dir or (PROJECT_ROOT / DEFAULT_OUTPUT_DIR))

    if not input_dir.exists():
        print(f"Input directory not found: {input_dir}", file=sys.stderr)
        sys.exit(1)

    # Stats-only mode
    if args.stats:
        stats = ExtractionStats()
        md_files = sorted(output_dir.rglob("*.md"))
        if not md_files:
            print("No parsed files found. Run extraction first.")
            sys.exit(0)
        for f in tqdm(md_files, desc="Counting"):
            rel = f.relative_to(output_dir)
            court = _detect_court(rel)
            text = f.read_text(encoding="utf-8")
            plain = re.sub(r"[#*_\[\]\(\)|>-]", " ", text)
            words = len(plain.split())
            refs = _count_refs(text)
            stats.record_success(court, "md", words, len(text), refs)
        print_stats(stats)
        return

    # Extract
    logger.info("Scanning files in %s ...", input_dir)
    files = collect_files(input_dir, court=args.court)
    logger.info("Found %d files to process.", len(files))

    if args.limit:
        files = files[: args.limit]

    output_dir.mkdir(parents=True, exist_ok=True)
    stats = ExtractionStats()

    # Prepare arguments for multiprocessing
    work_args = [
        (str(f), str(input_dir), str(output_dir)) for f in files
    ]

    workers = args.workers
    logger.info("Using %d worker processes.", workers)

    with ProcessPoolExecutor(max_workers=workers) as executor:
        with tqdm(total=len(work_args), desc="Extracting", unit="files") as pbar:
            for result in executor.map(
                _process_single, work_args, chunksize=64
            ):
                status, court, fmt, wc, cc, rc, err = result
                if status == "ok":
                    stats.record_success(court, fmt, wc, cc, rc)
                elif status == "skip":
                    stats.record_skip()
                else:
                    stats.record_failure(court, err)
                pbar.update(1)
                pbar.set_postfix(
                    ok=stats.processed,
                    skip=stats.skipped,
                    fail=stats.failed,
                    refresh=False,
                )

    print_stats(stats)


if __name__ == "__main__":
    main()
