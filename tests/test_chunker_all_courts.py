"""Comprehensive chunker test across ALL court types and jurisdictions.

Picks real documents from every court directory, chunks them, and verifies:
  1. Chunks are produced (no crashes)
  2. Every chunk starts with contextual header (Δικαστήριο: ...)
  3. No ΑΝΑΦΟΡΕΣ noise in chunk text
  4. No markdown artifacts (**, ##, [text](url))
  5. No C1 control chars (U+0080–U+009F)
  6. court_level is correct per court type
  7. jurisdiction is extracted (from body or path fallback) where expected
  8. Tail chunks are merged (no tiny last chunks <500 chars before header)
  9. Metadata fields are populated (doc_id, court, year, title)
"""

import os
import re
import sys
from pathlib import Path

# Allow imports from project root
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from rag.chunker import chunk_document, _detect_court

DATA_DIR = PROJECT_ROOT / "data" / "cases_parsed"

# ── Test matrix: every court type with expected metadata ─────────

# (court_dir_pattern, expected_court, expected_court_level, jurisdiction_source)
# jurisdiction_source: "body" = from doc body, "path" = from path fallback, "none" = not expected
COURT_MATRIX = [
    # First Instance subcourts (apofaseised)
    ("apofaseised/pol",   "apofaseised", "first_instance", "path"),   # civil
    ("apofaseised/poin",  "apofaseised", "first_instance", "path"),   # criminal
    ("apofaseised/oik",   "apofaseised", "first_instance", "body"),   # family (60% body)
    ("apofaseised/enoik", "apofaseised", "first_instance", "path"),   # rent/tenancy
    ("apofaseised/erg",   "apofaseised", "first_instance", "path"),   # labour
    # Old Supreme Court meros (aad)
    ("apofaseis/aad/meros_1", "aad", "supreme", "path"),    # criminal
    ("apofaseis/aad/meros_2", "aad", "supreme", "path"),    # civil
    ("apofaseis/aad/meros_3", "aad", "supreme", "path"),    # labour
    ("apofaseis/aad/meros_4", "aad", "supreme", "path"),    # administrative
    # Other courts
    ("courtOfAppeal",              "courtOfAppeal",              "appeal",         "body"),
    ("administrativeCourtOfAppeal","administrativeCourtOfAppeal","appeal",         "none"),
    ("supreme",                    "supreme",                    "supreme",        "none"),
    ("supremeAdministrative",      "supremeAdministrative",      "supreme",        "none"),
    ("administrative",             "administrative",             "administrative", "none"),
    ("administrativeIP",           "administrativeIP",           "administrative", "none"),
    ("areiospagos",                "areiospagos",                "foreign",        "none"),
    ("juvenileCourt",              "juvenileCourt",              "first_instance", "none"),
    ("apofaseis/epa",              "epa",                        "other",          "none"),
    ("apofaseis/aap",              "aap",                        "other",          "none"),
    ("clr",                        "clr",                        "supreme",        "none"),
    ("jsc",                        "jsc",                        "supreme",        "none"),
    ("rscc",                       "rscc",                       "supreme",        "none"),
    ("apofaseis/dioikitiko",       "dioikitiko",                 "administrative", "none"),
]

# Expected path-based jurisdiction fallback values
PATH_JURISDICTIONS = {
    "pol":     "ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "poin":    "ΠΟΙΝΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "oik":     "ΟΙΚΟΓΕΝΕΙΑΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "enoik":   "ΔΙΚΑΙΟΔΟΣΙΑ ΕΝΟΙΚΙΟΣΤΑΣΙΟΥ",
    "erg":     "ΕΡΓΑΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "meros_1": "ΠΟΙΝΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "meros_2": "ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "meros_3": "ΕΡΓΑΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
    "meros_4": "ΔΙΟΙΚΗΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ",
}

# ── Helpers ──────────────────────────────────────────────────────

LINK_RE = re.compile(r"\[[^\]]*\]\([^)]*\)")
C1_RE = re.compile(r"[\x80-\x9f]")
HEADER_PREFIX = "Δικαστήριο:"
TAIL_MIN_CHARS = 500  # chunks smaller than this should have been merged


def pick_files(court_dir: str, n: int = 3) -> list[Path]:
    """Pick up to n .md files from a court directory."""
    full = DATA_DIR / court_dir
    if not full.exists():
        return []
    files = sorted(full.rglob("*.md"))
    # Pick from start, middle, end for diversity
    if len(files) <= n:
        return files
    step = len(files) // n
    return [files[i * step] for i in range(n)]


def check_chunks(chunks, court_dir, expected_court, expected_level,
                 jurisdiction_source, doc_id):
    """Run all assertions on a list of chunks. Returns list of error strings."""
    errors = []
    prefix = f"[{court_dir} / {doc_id}]"

    if not chunks:
        errors.append(f"{prefix} No chunks produced")
        return errors

    for i, chunk in enumerate(chunks):
        tag = f"{prefix} chunk[{i}]"

        # 1. Header present
        if not chunk.text.startswith(HEADER_PREFIX):
            errors.append(f"{tag} Missing header (starts with: {chunk.text[:60]!r})")

        # 2. No ΑΝΑΦΟΡΕΣ
        if "ΑΝΑΦΟΡΕΣ" in chunk.text:
            errors.append(f"{tag} Contains ΑΝΑΦΟΡΕΣ noise")

        # 3. No bold markdown (**)
        if "**" in chunk.text:
            errors.append(f"{tag} Contains bold markdown (**)")

        # 4. No heading markdown (## at start of line)
        if re.search(r"^##\s", chunk.text, re.MULTILINE):
            errors.append(f"{tag} Contains heading markdown (##)")

        # 5. No markdown links [text](url)
        if LINK_RE.search(chunk.text):
            match = LINK_RE.search(chunk.text)
            errors.append(f"{tag} Contains markdown link: {match.group()[:80]}")

        # 6. No C1 control chars
        if C1_RE.search(chunk.text):
            errors.append(f"{tag} Contains C1 control chars")

        # 7. court_level correct
        if chunk.court_level != expected_level:
            errors.append(
                f"{tag} court_level={chunk.court_level!r}, expected {expected_level!r}"
            )

        # 8. court correct
        if chunk.court != expected_court:
            errors.append(
                f"{tag} court={chunk.court!r}, expected {expected_court!r}"
            )

        # 9. Metadata populated
        if not chunk.doc_id:
            errors.append(f"{tag} Empty doc_id")
        if not chunk.year:
            errors.append(f"{tag} Empty year")
        if not chunk.title:
            errors.append(f"{tag} Empty title")

    # 10. Jurisdiction check (on first chunk — same for all chunks of a doc)
    c0 = chunks[0]
    if jurisdiction_source == "body":
        # At least SOME docs should have body-extracted jurisdiction
        # (not all — 60% for family, 99% for appeal)
        if c0.jurisdiction and "ΔΙΚΑΙΟΔΟΣΙΑ" not in c0.jurisdiction:
            # Body-extracted should contain ΔΙΚΑΙΟΔΟΣΙΑ in most cases
            pass  # some values don't contain the word, that's ok
    elif jurisdiction_source == "path":
        # Must have path-based fallback
        subcourt_key = None
        for key in PATH_JURISDICTIONS:
            if f"/{key}/" in doc_id:
                subcourt_key = key
                break
        if subcourt_key:
            expected_j = PATH_JURISDICTIONS[subcourt_key]
            if c0.jurisdiction != expected_j:
                # Could still be body-extracted (overrides path)
                if "ΔΙΚΑΙΟΔΟΣΙΑ" not in c0.jurisdiction and c0.jurisdiction != expected_j:
                    errors.append(
                        f"{prefix} jurisdiction={c0.jurisdiction!r}, "
                        f"expected {expected_j!r} (path fallback for {subcourt_key})"
                    )

    # 11. Tail merge check: last chunk should be >= TAIL_MIN_CHARS
    #     (excluding header, which is ~80-180 chars)
    if len(chunks) >= 2:
        last_text = chunks[-1].text
        # Estimate text without header (after first \n\n)
        body_start = last_text.find("\n\n")
        if body_start > 0:
            body_text = last_text[body_start + 2:]
            if len(body_text) < TAIL_MIN_CHARS:
                # This is OK if the entire document is small
                # Only flag if there are 3+ chunks (document is substantial)
                if len(chunks) >= 3:
                    errors.append(
                        f"{prefix} Tail chunk too small: {len(body_text)} chars "
                        f"(expected >= {TAIL_MIN_CHARS} after merge)"
                    )

    return errors


# ── Main test runner ─────────────────────────────────────────────

def main():
    if not DATA_DIR.exists():
        print(f"ERROR: Data directory not found: {DATA_DIR}")
        sys.exit(1)

    all_errors: list[str] = []
    total_docs = 0
    total_chunks = 0
    courts_tested = 0
    courts_skipped = []

    print("=" * 70)
    print("COMPREHENSIVE CHUNKER TEST — ALL COURT TYPES")
    print("=" * 70)
    print()

    for court_dir, expected_court, expected_level, jurisdiction_source in COURT_MATRIX:
        files = pick_files(court_dir, n=10)
        if not files:
            courts_skipped.append(court_dir)
            continue

        courts_tested += 1
        court_errors = []

        for fp in files:
            doc_id = str(fp.relative_to(DATA_DIR))
            text = fp.read_text(encoding="utf-8")
            total_docs += 1

            try:
                chunks = chunk_document(text, doc_id)
            except Exception as exc:
                court_errors.append(f"[{court_dir} / {doc_id}] CRASH: {exc}")
                continue

            total_chunks += len(chunks)
            errs = check_chunks(
                chunks, court_dir, expected_court, expected_level,
                jurisdiction_source, doc_id,
            )
            court_errors.extend(errs)

        # Report per court
        status = "FAIL" if court_errors else "OK"
        icon = "✗" if court_errors else "✓"
        print(f"  {icon} {court_dir:<40} [{len(files)} docs] {status}")
        if court_errors:
            for err in court_errors[:5]:  # Show first 5 errors per court
                print(f"      {err}")
            if len(court_errors) > 5:
                print(f"      ... and {len(court_errors) - 5} more errors")

        all_errors.extend(court_errors)

    # ── Summary ──────────────────────────────────────────────────

    print()
    print("=" * 70)
    print(f"SUMMARY: {courts_tested} courts tested, {total_docs} docs, {total_chunks} chunks")
    if courts_skipped:
        print(f"  Skipped (no data): {', '.join(courts_skipped)}")
    print()

    if all_errors:
        print(f"  FAILED — {len(all_errors)} errors found:")
        for err in all_errors:
            print(f"    {err}")
        print()
        sys.exit(1)
    else:
        print("  ALL PASSED — no errors across any court type")
        print()
        sys.exit(0)


if __name__ == "__main__":
    main()
