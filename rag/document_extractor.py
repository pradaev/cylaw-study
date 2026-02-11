"""Extract document-level text for embedding (one vector per document).

Uses ΝΟΜΙΚΗ ΠΤΥΧΗ (legal analysis) when present, else ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ.
Output: title + subject + body (legal analysis → conclusion).
Max ~8K chars to stay within embedding token limit.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from rag.chunker import (
    _clean_chunk_text,
    _detect_court,
    _detect_court_level,
    _detect_subcourt,
    _detect_year,
    _extract_jurisdiction,
    _extract_title,
    _strip_references,
)

LEGAL_ANALYSIS_MARKER = "ΝΟΜΙΚΗ ΠΤΥΧΗ"
DECISION_MARKER = "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ"
MAX_CONTENT_CHARS = 3500  # ~900 tokens (Greek ~0.4 chars/token), safe for text-embedding-3-large (8191 limit)


@dataclass
class DocumentRecord:
    """Single document ready for embedding + Weaviate upsert."""

    doc_id: str
    content: str      # text for embedding + BM25
    title: str
    court: str
    year: str
    court_level: str
    subcourt: str
    jurisdiction: str

    def to_dict(self) -> dict:
        return {
            "doc_id": self.doc_id,
            "content": self.content,
            "title": self.title,
            "court": self.court,
            "year": self.year,
            "court_level": self.court_level,
            "subcourt": self.subcourt,
            "jurisdiction": self.jurisdiction,
        }


def _extract_subject(text: str) -> str:
    """Extract Subject line if present (~5800 docs have it)."""
    m = re.search(r"Subject:\s*(.+?)(?:\n|$)", text)
    return m.group(1).strip()[:200] if m else ""


def _extract_body_for_embedding(text: str) -> str:
    """Extract body: from ΝΟΜΙΚΗ ΠΤΥΧΗ (or ΚΕΙΜΕΝΟ) to end. Strip ΑΝΑΦΟΡΕΣ first."""
    stripped = _strip_references(text)
    cleaned = _clean_chunk_text(stripped)

    legal_idx = cleaned.find(LEGAL_ANALYSIS_MARKER)
    keimeno_idx = cleaned.find(DECISION_MARKER)

    if legal_idx != -1:
        body = cleaned[legal_idx + len(LEGAL_ANALYSIS_MARKER) :].lstrip()
        # Skip optional punctuation (:, *, digits, etc.)
        while body and body[0] in ":* \t\n":
            body = body[1:].lstrip()
    elif keimeno_idx != -1:
        after = cleaned[keimeno_idx + len(DECISION_MARKER) :].lstrip()
        while after and after[0] in ":* \t\n":
            after = after[1:].lstrip()
        body = after
    else:
        body = cleaned

    return body


def extract_document(text: str, doc_id: str) -> DocumentRecord | None:
    """Extract document-level record for embedding and search.

    Returns None if document is too short or invalid.
    """
    if not text or len(text.strip()) < 50:
        return None

    title = _extract_title(text)
    subject = _extract_subject(text)
    body = _extract_body_for_embedding(text)

    if not body.strip():
        return None

    # Build content: title + subject + body (truncate if needed)
    parts = []
    if title:
        parts.append(title)
    if subject:
        parts.append(f"[Subject: {subject}]")
    parts.append(body)

    content = "\n\n".join(parts)
    if len(content) > MAX_CONTENT_CHARS:
        content = content[: MAX_CONTENT_CHARS - 100] + "\n[...truncated]"

    court = _detect_court(doc_id)
    year = _detect_year(doc_id)
    court_level = _detect_court_level(court)
    subcourt = _detect_subcourt(doc_id, court)
    jurisdiction = _extract_jurisdiction(text, doc_id)

    return DocumentRecord(
        doc_id=doc_id,
        content=content,
        title=title[:200] if title else "",
        court=court,
        year=year,
        court_level=court_level,
        subcourt=subcourt,
        jurisdiction=jurisdiction,
    )
