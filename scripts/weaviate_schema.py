#!/usr/bin/env python3
"""Create Weaviate schema for CourtCase collection.

Run: python scripts/weaviate_schema.py
Requires: WEAVIATE_URL (default http://localhost:8080)
"""

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests

WEAVIATE_URL = os.environ.get("WEAVIATE_URL", "http://localhost:8080")
COLLECTION_NAME = "CourtCase"
VECTOR_DIMS = 3072  # text-embedding-3-large

SCHEMA = {
    "class": COLLECTION_NAME,
    "description": "Cypriot court cases (document-level, one vector per doc)",
    "vectorizer": "none",
    "vectorIndexConfig": {
        "distance": "cosine",
        "vectorCacheMaxObjects": 200000,
    },
    "properties": [
        {"name": "doc_id", "dataType": ["text"]},
        {"name": "content", "dataType": ["text"]},
        {"name": "title", "dataType": ["text"]},
        {"name": "court", "dataType": ["text"]},
        {"name": "year", "dataType": ["text"]},
        {"name": "court_level", "dataType": ["text"]},
        {"name": "subcourt", "dataType": ["text"]},
        {"name": "jurisdiction", "dataType": ["text"]},
    ],
}


def main() -> None:
    base = WEAVIATE_URL.rstrip("/")
    url = f"{base}/v1/schema"
    resp = requests.get(f"{base}/v1/schema/{COLLECTION_NAME}")
    if resp.status_code == 200:
        print(f"Collection {COLLECTION_NAME} already exists. Delete first to recreate.")
        return
    resp = requests.post(url, json=SCHEMA)
    resp.raise_for_status()
    print(f"Created collection {COLLECTION_NAME} (bring your own {VECTOR_DIMS}d vectors).")


if __name__ == "__main__":
    main()
