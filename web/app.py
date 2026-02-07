"""FastAPI web application for CyLaw legal search.

Provides a search UI with streaming LLM responses,
court/year filters, translation toggle, and LLM provider selection.
"""

import json
import logging
import os
import time as _time
import uuid
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Form, Query, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.templating import Jinja2Templates

load_dotenv()

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

app = FastAPI(title="CyLaw Search", description="Cypriot Court Case Search")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

COURT_NAMES = {
    "": "All courts",
    "aad": "Ανώτατο (old Supreme)",
    "supreme": "Ανώτατο (new Supreme)",
    "courtOfAppeal": "Εφετείο (Court of Appeal)",
    "supremeAdministrative": "Ανώτατο Συνταγματικό",
    "administrative": "Διοικητικό (Administrative)",
    "administrativeIP": "Διοικ. Πρωτοδικείο (Admin First Inst.)",
    "epa": "Επαρχιακά (District)",
    "aap": "Αρχή Ανταγωνισμού (Competition)",
    "dioikitiko": "Εφ. Διοικ. Δικαστηρίου",
    "clr": "CLR (Cyprus Law Reports)",
}

_retriever = None
_search_contexts: dict[str, list] = {}


def _get_retriever():
    """Lazy-init retriever using EMBEDDING_PROVIDER from config/env."""
    global _retriever
    if _retriever is None:
        from rag.retriever import Retriever
        _retriever = Retriever()  # reads provider from rag.config
    return _retriever


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "courts": COURT_NAMES},
    )


@app.post("/search", response_class=HTMLResponse)
async def search(
    request: Request,
    query: str = Form(...),
    court: str = Form(""),
    year_from: str = Form(""),
    year_to: str = Form(""),
    provider: str = Form("openai"),
    translate: str = Form(""),
):
    """Step 1: Retrieve sources (fast, ~0.5s). Returns HTML with sources
    and a JS snippet that starts streaming the LLM answer."""
    if not query.strip():
        return templates.TemplateResponse(
            "results.html",
            {"request": request, "error": "Please enter a question."},
        )

    try:
        t0 = _time.perf_counter()
        retriever = _get_retriever()

        yr_from = int(year_from) if year_from.strip() else None
        yr_to = int(year_to) if year_to.strip() else None
        court_filter = court if court.strip() else None

        grouped = retriever.search_grouped(
            query=query, n_results=20, max_docs=5,
            court=court_filter, year_from=yr_from, year_to=yr_to,
        )
        t1 = _time.perf_counter()
        print(f"TIMING: search={t1 - t0:.2f}s")

        if not grouped:
            return templates.TemplateResponse(
                "results.html",
                {"request": request, "error": "No relevant cases found."},
            )

        # Collect context chunks and store for the stream endpoint
        context_chunks = []
        for group in grouped:
            for chunk in group.chunks[:2]:
                context_chunks.append(chunk)

        search_id = uuid.uuid4().hex[:12]
        _search_contexts[search_id] = context_chunks

        return templates.TemplateResponse(
            "results.html",
            {
                "request": request,
                "sources": grouped,
                "search_id": search_id,
                "query": query,
                "provider": provider,
                "translate": translate,
                "court_names": COURT_NAMES,
            },
        )

    except Exception as exc:
        logger.exception("Search error")
        return templates.TemplateResponse(
            "results.html",
            {"request": request, "error": f"Error: {str(exc)[:200]}"},
        )


@app.get("/stream")
async def stream_answer(
    search_id: str = Query(...),
    query: str = Query(...),
    provider: str = Query("openai"),
    translate: str = Query(""),
):
    """Step 2: Stream the LLM answer as Server-Sent Events."""
    from rag.llm_client import stream_answer as _stream

    context_chunks = _search_contexts.pop(search_id, None)
    if context_chunks is None:
        async def error_gen():
            yield f"data: Search expired. Please search again.\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(error_gen(), media_type="text/event-stream")

    do_translate = translate == "on"

    async def event_generator():
        try:
            async for token in _stream(
                question=query,
                context_chunks=context_chunks,
                provider=provider,
                translate_to_english=do_translate,
            ):
                # SSE format: escape newlines
                escaped = token.replace("\n", "\\n")
                yield f"data: {escaped}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:
            yield f"data: Error: {str(exc)[:200]}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/health")
async def health():
    return {"status": "ok"}
