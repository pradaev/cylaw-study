"""HTML parser for CyLaw index pages.

Extracts case links from three page formats:
1. Court main index → list of year-index URLs
2. Year-specific index → list of CaseEntry
3. Updates page → list of CaseEntry (cross-court)
"""

import re
from dataclasses import dataclass, asdict

from bs4 import BeautifulSoup

from scraper.config import BASE_URL


@dataclass
class CaseEntry:
    """A single court case extracted from an index page."""

    url: str
    file_path: str
    title: str
    court: str
    year: str
    date: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# Maps file_path prefixes to court IDs for the updates parser.
_PATH_TO_COURT = {
    "/courtOfAppeal/": "courtOfAppeal",
    "/supreme/": "supreme",
    "/supremeAdministrative/": "supremeAdministrative",
    "/administrative/": "administrative",
    "/administrativeIP/": "administrativeIP",
    "/apofaseis/aad/": "aad",
    "/apofaseis/epa/": "epa",
    "/apofaseis/aap/": "aap",
    "/apofaseis/dioikitiko/": "dioikitiko",
    "/areiospagos/": "areiospagos",
    "/apofaseised/": "apofaseised",
    "/jsc/": "jsc",
    "/rscc/": "rscc",
    "/administrativeCourtOfAppeal/": "administrativeCourtOfAppeal",
    "/juvenileCourt/": "juvenileCourt",
}


def _detect_court(file_path: str) -> str:
    """Detect court ID from a file path."""
    for prefix, court_id in _PATH_TO_COURT.items():
        if file_path.startswith(prefix):
            return court_id
    return "unknown"


def _detect_year(file_path: str) -> str:
    """Extract year from a file path like /courtOfAppeal/2026/..."""
    m = re.search(r"/(\d{4})/", file_path)
    if m:
        return m.group(1)
    return ""


def _extract_file_path(href: str) -> str:
    """Extract the file= parameter from an open.pl URL."""
    m = re.search(r"file=([^\s&\"']+)", href)
    if m:
        return m.group(1)
    return ""


def _make_absolute_url(href: str) -> str:
    """Convert a relative href to an absolute URL."""
    if href.startswith("http"):
        return href
    return BASE_URL + href


def parse_court_main_index(html: str, court_id: str) -> list[str]:
    """Parse a court's main index page and return year-index URLs.

    Args:
        html: Raw HTML of the court's main index page.
        court_id: The court identifier (used for logging, not parsing).

    Returns:
        List of relative URLs to year-specific index pages.
    """
    soup = BeautifulSoup(html, "html.parser")
    urls: list[str] = []
    seen: set[str] = set()

    for a in soup.find_all("a", href=True):
        href = a["href"]
        # Match patterns:
        #   index_2026.html          — standard year index
        #   index_pol_2005.html      — apofaseised category+year index
        #   index_1.html             — rscc volume index
        #   2025/index.html          — epa/aap year subdirectory
        if re.search(r"index_\w*\d+\.html", href) or re.search(
            r"/\d{4}/index\.html", href
        ):
            if href not in seen:
                seen.add(href)
                urls.append(href)

    return urls


def parse_year_index(
    html: str, court_id: str, year: str
) -> list[CaseEntry]:
    """Parse a year-specific index page and return case entries.

    Args:
        html: Raw HTML of the year index page.
        court_id: The court identifier.
        year: The year string (e.g., "2026").

    Returns:
        List of CaseEntry objects, one per case link found.
    """
    soup = BeautifulSoup(html, "html.parser")
    entries: list[CaseEntry] = []
    seen_paths: set[str] = set()

    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "open.pl" not in href:
            continue

        file_path = _extract_file_path(href)
        if not file_path:
            continue

        if file_path in seen_paths:
            continue
        seen_paths.add(file_path)

        title = a.get_text(strip=True)
        url = _make_absolute_url(href)

        entries.append(
            CaseEntry(
                url=url,
                file_path=file_path,
                title=title,
                court=court_id,
                year=year,
            )
        )

    return entries


def parse_updates_page(html: str) -> list[CaseEntry]:
    """Parse the updates.html page and return case entries.

    Detects the court from each link's file_path and extracts
    year from the path structure.

    Args:
        html: Raw HTML of the updates page.

    Returns:
        List of CaseEntry objects from all courts.
    """
    soup = BeautifulSoup(html, "html.parser")
    entries: list[CaseEntry] = []
    seen_paths: set[str] = set()

    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "open.pl" not in href:
            continue

        file_path = _extract_file_path(href)
        if not file_path:
            continue

        if file_path in seen_paths:
            continue
        seen_paths.add(file_path)

        title = a.get_text(strip=True)
        url = _make_absolute_url(href)
        court = _detect_court(file_path)
        year = _detect_year(file_path)

        entries.append(
            CaseEntry(
                url=url,
                file_path=file_path,
                title=title,
                court=court,
                year=year,
            )
        )

    return entries
