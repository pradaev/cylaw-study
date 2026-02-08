"""Split parsed Markdown court case files into overlapping chunks with metadata.

Each chunk carries enough metadata (title, court, year, cross-references)
to be independently useful for retrieval and citation.
"""

import logging
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from langchain_text_splitters import RecursiveCharacterTextSplitter

logger = logging.getLogger(__name__)

# Chunk parameters tuned for Greek legal text (~7 chars/word average)
CHUNK_SIZE_CHARS = 2000
CHUNK_OVERLAP_CHARS = 400
SEPARATORS = ["\n\n", "\n", ". ", " "]

# Path-prefix to court-id mapping
_PATH_TO_COURT: dict[str, str] = {
    "apofaseis/aad": "aad",
    "apofaseis/epa": "epa",
    "apofaseis/aap": "aap",
    "apofaseis/dioikitiko": "dioikitiko",
    "courtOfAppeal": "courtOfAppeal",
    "supreme": "supreme",
    "supremeAdministrative": "supremeAdministrative",
    "administrative": "administrative",
    "administrativeIP": "administrativeIP",
    "clr": "clr",
}

# Court → court_level mapping
_COURT_LEVEL: dict[str, str] = {
    "aad": "supreme",              # old Supreme Court
    "supreme": "supreme",          # new Supreme Court
    "supremeAdministrative": "supreme",  # Supreme Constitutional Court
    "areiospagos": "supreme",      # Areios Pagos (Greek Supreme Court cases)
    "courtOfAppeal": "appeal",     # Court of Appeal
    "administrativeCourtOfAppeal": "appeal",  # Administrative Court of Appeal
    "apofaseised": "first_instance",  # First Instance Courts
    "administrative": "administrative",  # Administrative Court
    "administrativeIP": "administrative",  # Administrative Court (Int'l Protection)
    "juvenileCourt": "first_instance",    # Juvenile Court
    "epa": "other",                # Competition Commission
    "aap": "other",                # Tender Review Authority
    "jsc": "supreme",             # Judgments of Supreme Court (English)
    "rscc": "supreme",            # Supreme Constitutional Court 1960-63
    "clr": "supreme",             # Cyprus Law Reports
    "dioikitiko": "administrative",
}

# Subcourt codes for apofaseised (First Instance) courts
_SUBCOURT_CODES = {"pol", "poin", "oik", "enoik", "erg"}


@dataclass
class Chunk:
    """A single text chunk from a court case document."""

    text: str
    doc_id: str
    title: str
    court: str
    year: str
    chunk_index: int
    court_level: str = ""       # supreme | appeal | first_instance | administrative | other
    subcourt: str = ""          # pol | poin | oik | enoik | erg (only for apofaseised)
    cross_refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _detect_court(rel_path: str) -> str:
    """Detect court identifier from a relative file path."""
    for prefix, court_id in _PATH_TO_COURT.items():
        if prefix in rel_path:
            return court_id
    parts = Path(rel_path).parts
    return parts[0] if parts else "unknown"


def _detect_court_level(court: str) -> str:
    """Map court identifier to hierarchical level."""
    return _COURT_LEVEL.get(court, "other")


def _detect_subcourt(doc_id: str, court: str) -> str:
    """Extract subcourt code from doc_id for First Instance courts.

    Example: 'apofaseised/oik/2024/file.md' → 'oik'
    """
    if court != "apofaseised":
        return ""
    parts = doc_id.split("/")
    if len(parts) >= 2 and parts[1] in _SUBCOURT_CODES:
        return parts[1]
    return ""


def _detect_year(rel_path: str) -> str:
    """Extract 4-digit year from a file path."""
    m = re.search(r"/(\d{4})/", rel_path)
    return m.group(1) if m else ""


def _extract_title(text: str) -> str:
    """Extract the case title from the first Markdown heading."""
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    # Fallback: first non-empty line
    for line in text.split("\n"):
        line = line.strip()
        if line and not line.startswith("---"):
            return line[:200]
    return ""


def _extract_cross_refs(text: str) -> list[str]:
    """Extract cross-reference file paths from Markdown links.

    Finds patterns like [case name](/path/to/case.md) and returns
    the unique list of referenced paths.
    """
    refs = re.findall(r"\]\(([^)]*\.md)\)", text)
    return list(dict.fromkeys(refs))  # dedupe, preserve order


_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE_CHARS,
    chunk_overlap=CHUNK_OVERLAP_CHARS,
    separators=SEPARATORS,
    length_function=len,
    is_separator_regex=False,
)


def chunk_document(text: str, doc_id: str) -> list[Chunk]:
    """Split a single Markdown document into chunks with metadata.

    Args:
        text: Full Markdown text of the document.
        doc_id: Relative path serving as unique document identifier.

    Returns:
        List of Chunk objects.
    """
    if not text or len(text.strip()) < 50:
        return []

    title = _extract_title(text)
    court = _detect_court(doc_id)
    year = _detect_year(doc_id)
    court_level = _detect_court_level(court)
    subcourt = _detect_subcourt(doc_id, court)

    raw_chunks = _splitter.split_text(text)
    chunks: list[Chunk] = []

    for i, chunk_text in enumerate(raw_chunks):
        cross_refs = _extract_cross_refs(chunk_text)
        chunks.append(
            Chunk(
                text=chunk_text,
                doc_id=doc_id,
                title=title,
                court=court,
                year=year,
                chunk_index=i,
                court_level=court_level,
                subcourt=subcourt,
                cross_refs=cross_refs,
            )
        )

    return chunks


def chunk_directory(
    input_dir: Path,
    court: Optional[str] = None,
    limit: Optional[int] = None,
) -> list[Chunk]:
    """Chunk all Markdown files in a directory tree.

    Args:
        input_dir: Base directory containing .md files.
        court: If set, only process files from this court.
        limit: If set, only process the first N files.

    Returns:
        List of all Chunk objects across all documents.
    """
    md_files = sorted(input_dir.rglob("*.md"))
    if court:
        md_files = [
            f
            for f in md_files
            if _detect_court(str(f.relative_to(input_dir))) == court
        ]
    if limit:
        md_files = md_files[:limit]

    all_chunks: list[Chunk] = []
    for md_file in md_files:
        doc_id = str(md_file.relative_to(input_dir))
        text = md_file.read_text(encoding="utf-8")
        chunks = chunk_document(text, doc_id)
        all_chunks.extend(chunks)

    logger.info(
        "Chunked %d documents into %d chunks.", len(md_files), len(all_chunks)
    )
    return all_chunks
