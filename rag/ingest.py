#!/usr/bin/env python3
"""Ingest court case documents into a vector store.

Supports two providers with separate databases:
    python -m rag.ingest --provider local     # ~50 min, free
    python -m rag.ingest --provider openai    # ~9 hours, rate-limited

Both can run in parallel — they write to different ChromaDB directories.
"""

import argparse
import logging
import multiprocessing
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
from tqdm import tqdm

load_dotenv()

logger = logging.getLogger(__name__)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT_DIR = "data/cases_parsed"


def _chunk_file(args: tuple) -> list[dict]:
    from rag.chunker import chunk_document

    fp, base = args
    doc_id = str(Path(fp).relative_to(base))
    try:
        text = Path(fp).read_text(encoding="utf-8")
        return [c.to_dict() for c in chunk_document(text, doc_id)]
    except Exception:
        return []


def run_ingest(
    input_dir: str,
    provider: str,
    court: str = None,
    limit: int = None,
    batch_size: int = None,
) -> None:
    from rag.chunker import Chunk, _detect_court
    from rag.embedder import Embedder

    input_path = Path(input_dir)
    if not input_path.exists():
        print(f"Not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    embedder = Embedder(provider=provider)
    backend = embedder.backend

    if batch_size is None:
        batch_size = 256 if provider == "local" else 100

    # Collect files
    md_files = sorted(input_path.rglob("*.md"))
    if court:
        md_files = [
            f for f in md_files
            if _detect_court(str(f.relative_to(input_path))) == court
        ]
    if limit:
        md_files = md_files[:limit]

    print(f"\n{'=' * 60}")
    print(f"CyLaw Ingestion — {backend.name.upper()}")
    print(f"  Model:    {backend.model}")
    print(f"  Dims:     {backend.dimensions}")
    print(f"  DB:       {backend.chromadb_dir}")
    print(f"  Docs:     {len(md_files):,}")
    print(f"  Batch:    {batch_size}")
    print(f"{'=' * 60}")

    # Step 1: Chunk
    ncpu = multiprocessing.cpu_count()
    print(f"\n[1/2] Chunking ({ncpu} cores)...")
    t0 = time.time()
    work = [(str(f), str(input_path)) for f in md_files]

    all_dicts: list[dict] = []
    with multiprocessing.Pool() as pool:
        for result in tqdm(
            pool.imap_unordered(_chunk_file, work, chunksize=100),
            total=len(md_files), desc="Chunking", unit="docs",
        ):
            all_dicts.extend(result)

    print(f"  {len(all_dicts):,} chunks in {time.time()-t0:.1f}s")

    # Step 2: Embed
    done_docs = embedder.get_done_docs()
    new_chunks = [Chunk(**d) for d in all_dicts if d["doc_id"] not in done_docs]
    skipped = len(all_dicts) - len(new_chunks)

    if skipped:
        print(f"  Resuming: {skipped:,} chunks already done")
    if not new_chunks:
        print("  All chunks already embedded!")
        _print_stats(embedder)
        return

    # Parallel threads for OpenAI, sequential for local
    n_threads = 5 if provider == "openai" else 1

    print(f"\n[2/2] Embedding {len(new_chunks):,} chunks ({n_threads} threads)...")
    t1 = time.time()

    # Build all batches upfront
    all_batches: list[tuple[list[str], list[Chunk]]] = []
    buf_texts: list[str] = []
    buf_objs: list[Chunk] = []
    for c in new_chunks:
        buf_texts.append(c.text)
        buf_objs.append(c)
        if len(buf_texts) >= batch_size:
            all_batches.append((list(buf_texts), list(buf_objs)))
            buf_texts, buf_objs = [], []
    if buf_texts:
        all_batches.append((list(buf_texts), list(buf_objs)))

    pbar = tqdm(
        total=len(new_chunks), desc="Embedding", unit="ch",
        bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}]",
    )

    total_embedded = 0
    all_done_docs: set[str] = set()

    def _process_batch(batch_data):
        texts, chunks = batch_data
        embedder.store_batch(texts, chunks)
        return {c.doc_id for c in chunks}, len(chunks)

    if n_threads > 1:
        with ThreadPoolExecutor(max_workers=n_threads) as executor:
            futures = {executor.submit(_process_batch, b): i for i, b in enumerate(all_batches)}
            for f in as_completed(futures):
                try:
                    doc_ids, count = f.result()
                    total_embedded += count
                    all_done_docs.update(doc_ids)
                    pbar.update(count)

                    if total_embedded % 5000 < batch_size:
                        embedder.mark_docs_done(list(all_done_docs), total_embedded)
                        all_done_docs = set()
                        total_embedded = 0
                except Exception as exc:
                    logger.error("Batch failed: %s", exc)
    else:
        for batch_data in all_batches:
            doc_ids, count = _process_batch(batch_data)
            total_embedded += count
            all_done_docs.update(doc_ids)
            pbar.update(count)

            if total_embedded % 5000 < batch_size:
                embedder.mark_docs_done(list(all_done_docs), total_embedded)
                all_done_docs = set()
                total_embedded = 0

    pbar.close()

    if all_done_docs:
        embedder.mark_docs_done(list(all_done_docs), total_embedded)

    elapsed = time.time() - t1
    rate = len(new_chunks) / elapsed if elapsed > 0 else 0
    print(f"  {len(new_chunks):,} chunks in {elapsed:.0f}s ({rate:.0f}/sec)")

    _print_stats(embedder)


def _print_stats(embedder):
    stats = embedder.get_stats()
    print(f"\n{'=' * 60}")
    print(f"  Provider:   {stats['provider']}")
    print(f"  Model:      {stats['model']}")
    print(f"  Dimensions: {stats['dimensions']}")
    print(f"  Chunks:     {stats['total_chunks']:,}")
    print(f"  Documents:  {stats['documents']:,}")
    print(f"  DB:         {stats['chromadb_dir']}")
    print(f"{'=' * 60}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest CyLaw cases")
    parser.add_argument("--provider", choices=["local", "openai"], default="local")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--court", type=str, default=None)
    parser.add_argument("--batch-size", type=int, default=None)
    parser.add_argument("--stats", action="store_true")
    parser.add_argument("--input-dir", type=str, default=None)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    input_dir = args.input_dir or str(PROJECT_ROOT / DEFAULT_INPUT_DIR)

    if args.stats:
        from rag.embedder import Embedder
        for prov in ["local", "openai"]:
            try:
                e = Embedder(provider=prov)
                s = e.get_stats()
                print(f"\n{prov.upper()}: {s['total_chunks']:,} chunks, {s['documents']:,} docs [{s['chromadb_dir']}]")
            except Exception as exc:
                print(f"\n{prov.upper()}: {exc}")
        return

    run_ingest(
        input_dir=input_dir,
        provider=args.provider,
        court=args.court,
        limit=args.limit,
        batch_size=args.batch_size,
    )


if __name__ == "__main__":
    main()
