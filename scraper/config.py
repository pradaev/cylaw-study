"""Configuration for the CyLaw index scraper."""

from dataclasses import dataclass


BASE_URL = "https://www.cylaw.org"

# Seconds between HTTP requests (rate limiting)
REQUEST_DELAY = 0.75

# HTTP request timeout in seconds
REQUEST_TIMEOUT = 30

# Maximum retry attempts on server errors
MAX_RETRIES = 3

# Polite User-Agent identifying this as a research tool
USER_AGENT = (
    "CyLawIndexScraper/1.0 "
    "(Legal research tool; contact: research@example.com)"
)

# Default directories relative to project root
CACHE_DIR = "data/cache"
INDEX_DIR = "data/indexes"


@dataclass(frozen=True)
class CourtConfig:
    """Configuration for a single court's index structure."""

    court_id: str
    base_index_url: str
    year_index_pattern: str  # "index_{year}" or "{year}/index"
    year_start: int
    year_end: int = 2026

    def main_index_url(self) -> str:
        """Full URL to the court's main index page."""
        return f"{BASE_URL}{self.base_index_url}"

    def year_index_url(self, year: int) -> str:
        """Full URL to a specific year's index page."""
        if self.year_index_pattern == "index_{year}":
            return f"{BASE_URL}{self.base_index_url}index_{year}.html"
        elif self.year_index_pattern == "{year}/index":
            return f"{BASE_URL}{self.base_index_url}{year}/index.html"
        raise ValueError(
            f"Unknown year pattern: {self.year_index_pattern}"
        )


# All courts on cylaw.org with their index structures.
# Year ranges are based on what the site actually has (from our inventory).
COURTS: list[CourtConfig] = [
    # === Originally scraped courts ===
    CourtConfig(
        court_id="aad",
        base_index_url="/apofaseis/aad/",
        year_index_pattern="index_{year}",
        year_start=1961,
        year_end=2024,
    ),
    CourtConfig(
        court_id="supreme",
        base_index_url="/supreme/",
        year_index_pattern="index_{year}",
        year_start=2023,
    ),
    CourtConfig(
        court_id="courtOfAppeal",
        base_index_url="/courtOfAppeal/",
        year_index_pattern="index_{year}",
        year_start=2004,
    ),
    CourtConfig(
        court_id="supremeAdministrative",
        base_index_url="/supremeAdministrative/",
        year_index_pattern="index_{year}",
        year_start=2023,
    ),
    CourtConfig(
        court_id="administrative",
        base_index_url="/administrative/",
        year_index_pattern="index_{year}",
        year_start=2016,
    ),
    CourtConfig(
        court_id="administrativeIP",
        base_index_url="/administrativeIP/",
        year_index_pattern="index_{year}",
        year_start=2018,
    ),
    CourtConfig(
        court_id="epa",
        base_index_url="/apofaseis/epa/",
        year_index_pattern="{year}/index",
        year_start=2002,
    ),
    CourtConfig(
        court_id="aap",
        base_index_url="/apofaseis/aap/",
        year_index_pattern="{year}/index",
        year_start=2004,
    ),
    CourtConfig(
        court_id="dioikitiko",
        base_index_url="/apofaseis/dioikitiko/",
        year_index_pattern="index_{year}",
        year_start=2023,
        year_end=2023,
    ),
    # === Added 2026-02-07: previously missing courts ===
    CourtConfig(
        court_id="areiospagos",
        base_index_url="/areiospagos/",
        year_index_pattern="index_{year}",
        year_start=1968,
    ),
    CourtConfig(
        court_id="apofaseised",
        base_index_url="/apofaseised/",
        year_index_pattern="index_{year}",
        year_start=2005,
    ),
    CourtConfig(
        court_id="jsc",
        base_index_url="/jsc/",
        year_index_pattern="index_{year}",
        year_start=1964,
        year_end=1988,
    ),
    CourtConfig(
        court_id="rscc",
        base_index_url="/rscc/",
        year_index_pattern="index_{year}",
        year_start=1,
        year_end=5,
    ),
    CourtConfig(
        court_id="administrativeCourtOfAppeal",
        base_index_url="/administrativeCourtOfAppeal/",
        year_index_pattern="index_{year}",
        year_start=2025,
    ),
    CourtConfig(
        court_id="juvenileCourt",
        base_index_url="/juvenileCourt/",
        year_index_pattern="index_{year}",
        year_start=2023,
        year_end=2025,
    ),
]

UPDATES_URL = f"{BASE_URL}/updates.html"


def get_court(court_id: str) -> CourtConfig:
    """Look up a court by its ID. Raises ValueError if not found."""
    for court in COURTS:
        if court.court_id == court_id:
            return court
    valid_ids = [c.court_id for c in COURTS]
    raise ValueError(
        f"Unknown court_id '{court_id}'. Valid IDs: {valid_ids}"
    )
