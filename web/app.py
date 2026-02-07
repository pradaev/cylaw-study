"""FastAPI web application for CyLaw Chat.

Chat interface with agentic LLM that searches the court case database
via function calling. Supports streaming, document viewer, and auth.
"""

import json
import logging
import os
from pathlib import Path

import markdown
from dotenv import load_dotenv
from fastapi import Cookie, FastAPI, Form, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.templating import Jinja2Templates

load_dotenv()

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
CASES_PARSED_DIR = PROJECT_ROOT / "data" / "cases_parsed"

APP_PASSWORD = os.environ.get("APP_PASSWORD", "cylaw2026")
AUTH_COOKIE = "cylaw_auth"

app = FastAPI(title="CyLaw Chat")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

COURT_NAMES = {
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

# Lazy-loaded retriever
_retriever = None


def _get_retriever():
    global _retriever
    if _retriever is None:
        from rag.retriever import Retriever
        _retriever = Retriever()
    return _retriever


def _check_auth(cylaw_auth: str = Cookie(None)) -> bool:
    return cylaw_auth == APP_PASSWORD


# ── Auth ───────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index(request: Request, cylaw_auth: str = Cookie(None)):
    if not _check_auth(cylaw_auth):
        return templates.TemplateResponse("login.html", {"request": request})
    from rag.llm_client import MODELS
    return templates.TemplateResponse("chat.html", {
        "request": request,
        "courts": COURT_NAMES,
        "models": {k: v["label"] for k, v in MODELS.items()},
    })


@app.post("/auth")
async def auth(password: str = Form(...)):
    if password == APP_PASSWORD:
        response = RedirectResponse("/", status_code=303)
        response.set_cookie(AUTH_COOKIE, APP_PASSWORD, httponly=True, max_age=86400 * 30)
        return response
    return templates.TemplateResponse("login.html", {
        "request": Request,
        "error": "Wrong password",
    })


@app.get("/logout")
async def logout():
    response = RedirectResponse("/", status_code=303)
    response.delete_cookie(AUTH_COOKIE)
    return response


# ── Chat ───────────────────────────────────────────────

@app.post("/chat")
async def chat(
    request: Request,
    cylaw_auth: str = Cookie(None),
):
    """Main chat endpoint. Accepts JSON, returns SSE stream."""
    if not _check_auth(cylaw_auth):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    body = await request.json()
    messages = body.get("messages", [])
    model = body.get("model", "gpt-4o")
    translate = body.get("translate", False)

    if not messages:
        return JSONResponse({"error": "No messages"}, status_code=400)

    from rag.llm_client import chat_stream

    retriever = _get_retriever()

    def search_fn(query, court=None, year_from=None, year_to=None):
        return retriever.search(
            query=query,
            n_results=10,
            court=court,
            year_from=year_from,
            year_to=year_to,
        )

    async def event_generator():
        async for event in chat_stream(
            messages=messages,
            model_key=model,
            translate=translate,
            search_fn=search_fn,
        ):
            evt_type = event["event"]
            data = event["data"]
            if isinstance(data, (dict, list)):
                data_str = json.dumps(data, ensure_ascii=False)
            else:
                data_str = str(data).replace("\n", "\\n")
            yield f"event: {evt_type}\ndata: {data_str}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Document Viewer ────────────────────────────────────

@app.get("/doc")
async def view_document(
    doc_id: str = Query(...),
    cylaw_auth: str = Cookie(None),
):
    """Return rendered HTML of a full case document."""
    if not _check_auth(cylaw_auth):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    # Sanitize path to prevent directory traversal
    doc_path = CASES_PARSED_DIR / doc_id
    try:
        doc_path = doc_path.resolve()
        if not str(doc_path).startswith(str(CASES_PARSED_DIR.resolve())):
            return JSONResponse({"error": "Invalid path"}, status_code=400)
    except Exception:
        return JSONResponse({"error": "Invalid path"}, status_code=400)

    if not doc_path.exists():
        return JSONResponse({"error": "Document not found"}, status_code=404)

    md_text = doc_path.read_text(encoding="utf-8")
    html_content = markdown.markdown(md_text, extensions=["tables"])

    return JSONResponse({
        "doc_id": doc_id,
        "html": html_content,
        "title": md_text.split("\n")[0].lstrip("# ").strip()[:200] if md_text else "",
    })


# ── Health ─────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}
