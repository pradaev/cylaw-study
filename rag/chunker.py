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
# IMPORTANT: longer/more-specific prefixes MUST come before shorter ones
# ("supremeAdministrative" before "supreme", "administrativeIP" before "administrative")
_PATH_TO_COURT: dict[str, str] = {
    "apofaseis/aad": "aad",
    "apofaseis/epa": "epa",
    "apofaseis/aap": "aap",
    "apofaseis/dioikitiko": "dioikitiko",
    "courtOfAppeal": "courtOfAppeal",
    "administrativeCourtOfAppeal": "administrativeCourtOfAppeal",
    "supremeAdministrative": "supremeAdministrative",
    "supreme": "supreme",
    "administrativeIP": "administrativeIP",
    "administrative": "administrative",
    "juvenileCourt": "juvenileCourt",
    "areiospagos": "areiospagos",
    "clr": "clr",
    "jsc": "jsc",
    "rscc": "rscc",
}

# Court → court_level mapping
_COURT_LEVEL: dict[str, str] = {
    "aad": "supreme",              # old Supreme Court
    "supreme": "supreme",          # new Supreme Court
    "supremeAdministrative": "supreme",  # Supreme Constitutional Court
    "areiospagos": "foreign",      # Areios Pagos (Greek Supreme Court — not Cypriot)
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

# Court display names for contextual chunk headers (Greek)
_COURT_DISPLAY_NAME: dict[str, str] = {
    "aad": "Ανώτατο Δικαστήριο",
    "supreme": "Ανώτατο Δικαστήριο (νέο)",
    "supremeAdministrative": "Ανώτατο Συνταγματικό Δικαστήριο",
    "areiospagos": "Άρειος Πάγος (Ελλάδα)",
    "courtOfAppeal": "Εφετείο",
    "administrativeCourtOfAppeal": "Διοικητικό Εφετείο",
    "apofaseised": "Επαρχιακό Δικαστήριο",
    "administrative": "Διοικητικό Δικαστήριο",
    "administrativeIP": "Διοικητικό Δικαστήριο Διεθνούς Προστασίας",
    "juvenileCourt": "Δικαστήριο Παίδων",
    "epa": "Επιτροπή Προστασίας Ανταγωνισμού",
    "aap": "Αναθεωρητική Αρχή Προσφορών",
    "jsc": "Supreme Court of Cyprus",
    "rscc": "Supreme Constitutional Court",
    "clr": "Cyprus Law Reports",
    "dioikitiko": "Διοικητικό Δικαστήριο",
}

# Jurisdiction fallback: derive from file path when ΔΙΚΑΙΟΔΟΣΙΑ not found in document
_JURISDICTION_FALLBACK: dict[str, str] = {
    # Subcourts (apofaseised) — detected from doc_id containing these path segments
    "pol": "ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "poin": "ΠΟΙΝΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "oik": "ΟΙΚΟΓΕΝΕΙΑΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "enoik": "ΔΙΚΑΙΟΔΟΣΙΑ ΕΝΟΙΚΙΟΣΤΑΣΙΟΥ",
    "erg": "ΕΡΓΑΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    # AAD meros — detected from doc_id containing meros_N/
    "meros_1": "ΠΟΙΝΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "meros_2": "ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "meros_3": "ΕΡΓΑΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "meros_4": "ΔΙΟΙΚΗΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
}


@dataclass
class Chunk:
    """A single text chunk from a court case document."""

    text: str
    doc_id: str
    title: str
    court: str
    year: str
    chunk_index: int
    court_level: str = ""       # supreme | appeal | first_instance | administrative | foreign | other
    subcourt: str = ""          # pol | poin | oik | enoik | erg (only for apofaseised)
    jurisdiction: str = ""      # extracted ΔΙΚΑΙΟΔΟΣΙΑ or path-based fallback
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
    """Extract 4-digit year from a file path.

    Tries /YYYY/ directory first, then YYYY_ prefix in filename
    (for rscc/jsc paths like rscc/files/1961_1_0001.md).
    """
    m = re.search(r"/(\d{4})/", rel_path)
    if m:
        return m.group(1)
    m = re.search(r"/(\d{4})_", rel_path)
    return m.group(1) if m else ""


def _extract_title(text: str) -> str:
    """Extract the case title from the first Markdown heading.

    Cleans markdown artifacts and C1 control chars from the title.
    """
    raw = ""
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            raw = line[2:].strip()
            break
    if not raw:
        # Fallback: first non-empty line
        for line in text.split("\n"):
            line = line.strip()
            if line and not line.startswith("---"):
                raw = line[:200]
                break
    if not raw:
        return ""
    # Clean markdown and C1 control chars
    cleaned = _clean_markdown(raw)
    cleaned = re.sub(r"[\x80-\x9f]", "", cleaned)
    return cleaned


def _clean_markdown(line: str) -> str:
    """Remove Markdown formatting artifacts from a line.

    Used for jurisdiction extraction and title cleaning.
    Strips: *, #, markdown links, C1 control chars, extra whitespace.
    """
    cleaned = line.replace("*", "").replace("#", "")
    # Strip markdown links: [text](url) → text
    cleaned = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", cleaned)
    cleaned = re.sub(r"[\x80-\x9f]", "-", cleaned)  # C1 control chars → dash (often broken en-dash)
    cleaned = cleaned.replace("\u2011", "-")  # non-breaking hyphen
    cleaned = re.sub(r"-{2,}", "-", cleaned)  # collapse multiple dashes
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _extract_jurisdiction(text: str, doc_id: str) -> str:
    """Extract jurisdiction line from document body.

    Looks for line containing ΔΙΚΑΙΟΔΟΣΙΑ in the first 30 lines
    after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ. Returns the original text cleaned
    only of Markdown artifacts. No semantic transformation.

    Falls back to path-based jurisdiction when not found in text.
    """
    parts = re.split(r"\*{0,4}ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ\*{0,4}", text, maxsplit=1)
    if len(parts) >= 2:
        for line in parts[1].split("\n")[:30]:
            cleaned = _clean_markdown(line)
            if "ΔΙΚΑΙΟΔΟΣΙΑ" in cleaned:
                return cleaned

    # Fallback: derive from file path (subcourt or meros)
    for key, value in _JURISDICTION_FALLBACK.items():
        if f"/{key}/" in doc_id:
            return value

    return ""


def _strip_references(text: str) -> str:
    """Strip ΑΝΑΦΟΡΕΣ section from document text.

    Removes everything between ΑΝΑΦΟΡΕΣ and ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ markers,
    keeping the title (before ΑΝΑΦΟΡΕΣ) and decision text (after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ).
    Returns text unchanged if markers not found.
    """
    refs_match = re.search(r"\*{0,4}ΑΝΑΦΟΡΕΣ\*{0,4}", text)
    body_match = re.search(r"\*{0,4}ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ\*{0,4}:?", text)

    if not refs_match:
        # No ΑΝΑΦΟΡΕΣ section — just strip the ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ marker if present
        if body_match:
            return text[:body_match.start()] + text[body_match.end():]
        return text

    before_refs = text[: refs_match.start()].rstrip()
    if body_match and body_match.start() > refs_match.start():
        after_body = text[body_match.end():].lstrip()
        return before_refs + "\n\n" + after_body if before_refs else after_body
    else:
        # ΑΝΑΦΟΡΕΣ found but no ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ after it — strip from ΑΝΑΦΟΡΕΣ to end
        return before_refs


def _extract_cross_refs(text: str) -> list[str]:
    """Extract cross-reference file paths from Markdown links.

    Finds patterns like [case name](/path/to/case.md) and returns
    the unique list of referenced paths.
    """
    refs = re.findall(r"\]\(([^)]*\.md)\)", text)
    return list(dict.fromkeys(refs))  # dedupe, preserve order


def _clean_chunk_text(text: str) -> str:
    """Clean formatting/encoding noise from document text.

    Only removes noise. Never touches legal content or terminology.
    Called AFTER _strip_references(), BEFORE text splitting.
    """
    # 1. Remove markdown formatting FIRST (before link stripping)
    #    Nested bold+links like ***[***[text](url)***](url) create new links
    #    after * removal, so * must go first.
    text = text.replace("*", "").replace("#", "")

    # 2. Strip markdown link syntax: [text](/path) -> text
    #    Loop handles nested links exposed after * removal.
    _link_re = re.compile(r"\[([^\]]*)\]\([^)]*\)")
    while _link_re.search(text):
        text = _link_re.sub(r"\1", text)

    # 3. Remove C1 control chars (broken encoding artifacts: €, quotes, dashes)
    text = re.sub(r"[\x80-\x9f]", "", text)

    # 4. Normalize invisible unicode
    text = text.replace("\u00a0", " ")   # NBSP → regular space
    text = text.replace("\u2011", "-")   # non-breaking hyphen → regular hyphen
    text = text.replace("\u00ad", "")    # soft hyphen → remove
    text = text.replace("\u0358", "")    # combining dot → remove

    # 5. Remove horizontal rules (3+ dashes or underscores on a line)
    text = re.sub(r"^[-_]{3,}$", "", text, flags=re.MULTILINE)

    # 6. Collapse whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r" {2,}", " ", text)

    return text.strip()


def _build_chunk_header(court_name: str, jurisdiction: str, year: str, title: str) -> str:
    """Build contextual header for a chunk (prepended to chunk text for embedding)."""
    parts = [f"Δικαστήριο: {court_name}"]
    if jurisdiction:
        parts.append(jurisdiction)
    if year:
        parts.append(f"Έτος: {year}")
    if title:
        parts.append(title[:120])
    return " | ".join(parts)


_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE_CHARS,
    chunk_overlap=CHUNK_OVERLAP_CHARS,
    separators=SEPARATORS,
    length_function=len,
    is_separator_regex=False,
)


def chunk_document(text: str, doc_id: str) -> list[Chunk]:
    """Split a single Markdown document into chunks with metadata.

    Pipeline: extract metadata → extract cross-refs & jurisdiction →
    strip ΑΝΑΦΟΡΕΣ → clean text → split → merge tail → prepend header.

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

    # Extract metadata BEFORE stripping references
    cross_refs = _extract_cross_refs(text)
    jurisdiction = _extract_jurisdiction(text, doc_id)

    # Strip ΑΝΑΦΟΡΕΣ section, then clean text
    cleaned_text = _strip_references(text)
    cleaned_text = _clean_chunk_text(cleaned_text)

    # Split into chunks
    raw_chunks = _splitter.split_text(cleaned_text)

    # Merge small tail chunks (<500 chars) with previous — loop until stable
    while len(raw_chunks) >= 2 and len(raw_chunks[-1]) < 500:
        raw_chunks[-2] = raw_chunks[-2] + "\n\n" + raw_chunks[-1]
        raw_chunks.pop()

    # Build contextual header
    court_display = _COURT_DISPLAY_NAME.get(court, court)
    header = _build_chunk_header(court_display, jurisdiction, year, title)

    chunks: list[Chunk] = []
    for i, chunk_text in enumerate(raw_chunks):
        full_text = header + "\n\n" + chunk_text
        chunks.append(
            Chunk(
                text=full_text,
                doc_id=doc_id,
                title=title,
                court=court,
                year=year,
                chunk_index=i,
                court_level=court_level,
                subcourt=subcourt,
                jurisdiction=jurisdiction,
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
