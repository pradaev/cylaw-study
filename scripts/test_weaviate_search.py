#!/usr/bin/env python3
"""Quick smoke test: embed query → Weaviate nearVector → verify results."""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
import requests

load_dotenv()
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

WEAVIATE_URL = os.environ.get("WEAVIATE_URL", "http://localhost:8080")
MODEL = "text-embedding-3-large"


def main() -> None:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("OPENAI_API_KEY required")
        sys.exit(1)

    client = OpenAI(api_key=api_key)
    query = "αστικός γάμος Κύπρος"
    emb = client.embeddings.create(model=MODEL, input=query)
    vector = emb.data[0].embedding

    # Full vector for GraphQL
    vec_str = ",".join(str(x) for x in vector)
    query_gql = """
    {
      Get {
        CourtCase(
          limit: 5
          nearVector: { vector: [%s] }
        ) {
          doc_id
          title
          court
          year
          _additional { distance }
        }
      }
    }
    """ % vec_str

    base = WEAVIATE_URL.rstrip("/")
    r = requests.post(
        f"{base}/v1/graphql",
        json={"query": query_gql},
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if data.get("errors"):
        print("GraphQL errors:", data["errors"])
        sys.exit(1)

    items = data.get("data", {}).get("Get", {}).get("CourtCase", [])
    print(f"Query: {query}")
    print(f"Results: {len(items)}")
    for i, o in enumerate(items, 1):
        print(f"  {i}. {o.get('doc_id', '?')} | {o.get('title', '')[:50]}... | court={o.get('court')} year={o.get('year')} dist={o.get('_additional', {}).get('distance')}")
    if items:
        print("OK — Weaviate search works")
    else:
        print("WARN — No results (check schema / ingest)")
        sys.exit(1)


if __name__ == "__main__":
    main()
