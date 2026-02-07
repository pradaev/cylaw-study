"""Agentic LLM client with function calling for court case search.

The LLM decides when to search the case database using the search_cases
tool. Supports multi-step reasoning (search → analyze → search again).
Streams the final answer as SSE events.

Supported models:
    - GPT-4o (openai)
    - o3-mini (openai, reasoning)
    - Claude Sonnet 4 (anthropic)
"""

import json
import logging
import os
from dataclasses import dataclass
from typing import AsyncIterator, Optional

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are CyLaw Assistant — an expert legal research assistant specializing in Cypriot law and court cases. You are deeply knowledgeable about the Cypriot legal system, its courts, terminology, and procedures. You have access to a database of 63,000+ court decisions spanning 1961–2026.

CYPRIOT COURT SYSTEM (your knowledge base covers these courts):
- Ανώτατο Δικαστήριο (old Supreme Court, "aad") — 35,485 decisions (1961–2024). The largest collection. Divided into 4 parts: meros_1 (criminal), meros_2 (civil), meros_3 (labour/land), meros_4 (administrative law). Cases cited as "CLR" (Cyprus Law Reports) or "ΑΑΔ" (Αποφάσεις Ανωτάτου Δικαστηρίου).
- Νέο Ανώτατο Δικαστήριο (new Supreme Court, "supreme") — 1,028 decisions (2023–2026). Replaced the old Supreme Court after the 2022 judicial reform.
- Εφετείο (Court of Appeal, "courtOfAppeal") — 1,111 decisions (2004–2026). Handles civil and criminal appeals.
- Ανώτατο Συνταγματικό Δικαστήριο (Supreme Constitutional Court, "supremeAdministrative") — 420 decisions (2023–2026). Constitutional review.
- Διοικητικό Δικαστήριο (Administrative Court, "administrative") — 5,782 decisions (2016–2026). Reviews administrative acts under Article 146 of the Constitution.
- Διοικητικό Δικαστήριο Διεθνούς Προστασίας (Admin Court for International Protection, "administrativeIP") — 6,889 decisions (2018–2026). Asylum and refugee cases.
- Επιτροπή Προστασίας Ανταγωνισμού (Competition Commission, "epa") — 785 decisions (2002–2025).
- Αναθεωρητική Αρχή Προσφορών (Tender Review Authority, "aap") — 2,596 decisions (2004–2025). Public procurement disputes.

KEY LEGAL CONCEPTS you should know:
- Article 146 of the Constitution — basis for judicial review of administrative acts (προσφυγή). Most administrative court cases cite this.
- Αρχή της νομιμότητας — principle of legality
- Ακύρωση διοικητικής πράξης — annulment of administrative act
- Υπέρβαση εξουσίας — excess of power
- Αιτιολογία — reasoning/justification of administrative decisions
- Πολιτική Έφεση — civil appeal, Ποινική Έφεση — criminal appeal
- Εφεση κατά απόφασης — appeal against decision

SEARCH STRATEGY:
1. ALWAYS search in Greek legal terminology first — the vast majority of cases are in Greek. For example, if user asks about "unfair dismissal", search for "αδικαιολόγητη απόλυση" or "παράνομη απόλυση".
2. Then search in English if relevant (older Supreme Court cases have English text).
3. Use specific legal terms, article numbers, or case names when possible.
4. You may call search_cases multiple times with different queries to cover different angles.
5. Filter by court when the legal domain is clear (e.g., administrative law → court="administrative").

HOW TO HELP USERS FORMULATE QUERIES:
- If the user's request is vague or uses incorrect terminology, ask 1-2 clarifying questions BEFORE searching. For example:
  "You mentioned 'property dispute' — are you looking for (a) land registration disputes, (b) expropriation cases, or (c) co-ownership disputes?"
- Suggest the correct Greek legal terms when relevant: "This area of law is called 'ακύρωση διοικητικής πράξης' (annulment of administrative act) in Cypriot law."
- After providing an answer, suggest 2-3 follow-up questions the user might want to explore.

RESPONSE FORMAT:
1. Answer in the SAME LANGUAGE as the user's question.
2. Start with a direct, concise answer.
3. Support with specific case citations: *CASE_TITLE* (Court, Year).
4. Quote relevant passages in quotation marks.
5. End with a "Sources" section listing all cited cases.
6. If helpful, suggest follow-up questions: "You might also want to explore: ..."

WHEN NOT TO SEARCH:
- General legal knowledge questions ("what is Article 146?") — answer from your knowledge.
- Follow-up questions where the context already contains the answer.
- When the user is asking for clarification about your previous response.
- When the user asks about the structure of the legal system itself."""

TRANSLATE_SUFFIX = """

IMPORTANT: Write your ENTIRE answer in English. Translate all Greek case excerpts and quotes to English. Keep original Greek case titles in parentheses for reference."""

# Tool definition for search_cases
SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "search_cases",
        "description": "Search the Cypriot court case database by semantic similarity. Use Greek legal terms for best results. You can call this multiple times with different queries.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query — use specific legal terms, case names, or article references. Greek queries often yield better results for Greek case law.",
                },
                "court": {
                    "type": "string",
                    "description": "Filter by court ID",
                    "enum": [
                        "aad", "supreme", "courtOfAppeal",
                        "supremeAdministrative", "administrative",
                        "administrativeIP", "epa", "aap", "dioikitiko",
                    ],
                },
                "year_from": {
                    "type": "integer",
                    "description": "Filter: cases from this year onward",
                },
                "year_to": {
                    "type": "integer",
                    "description": "Filter: cases up to this year",
                },
            },
            "required": ["query"],
        },
    },
}

# Claude tool definition (different format)
CLAUDE_SEARCH_TOOL = {
    "name": "search_cases",
    "description": SEARCH_TOOL["function"]["description"],
    "input_schema": SEARCH_TOOL["function"]["parameters"],
}

# Model configurations
MODELS = {
    "gpt-4o": {"provider": "openai", "model_id": "gpt-4o", "label": "GPT-4o"},
    "o3-mini": {"provider": "openai", "model_id": "o3-mini", "label": "o3-mini"},
    "gpt-4o-mini": {"provider": "openai", "model_id": "gpt-4o-mini", "label": "GPT-4o-mini"},
    "claude": {"provider": "anthropic", "model_id": "claude-sonnet-4-20250514", "label": "Claude Sonnet 4"},
}

MAX_TOOL_ROUNDS = 5


def _get_system(translate: bool) -> str:
    prompt = SYSTEM_PROMPT
    if translate:
        prompt += TRANSLATE_SUFFIX
    return prompt


async def chat_stream(
    messages: list[dict],
    model_key: str,
    translate: bool,
    search_fn,
) -> AsyncIterator[dict]:
    """Stream a chat response with function calling.

    Yields SSE event dicts:
        {"event": "searching", "data": {"query": "...", "step": N}}
        {"event": "sources",   "data": [{doc_id, title, court, year, score, text}]}
        {"event": "token",     "data": "text chunk"}
        {"event": "done",      "data": {}}
        {"event": "error",     "data": "error message"}

    Args:
        messages: Conversation history [{role, content}, ...]
        model_key: Key from MODELS dict
        translate: Whether to translate answer to English
        search_fn: Callable(query, court, year_from, year_to) -> list[SearchResult]
    """
    model_cfg = MODELS.get(model_key)
    if not model_cfg:
        yield {"event": "error", "data": f"Unknown model: {model_key}"}
        return

    provider = model_cfg["provider"]
    system = _get_system(translate)

    try:
        if provider == "openai":
            async for event in _chat_openai(messages, model_cfg, system, search_fn):
                yield event
        elif provider == "anthropic":
            async for event in _chat_claude(messages, model_cfg, system, search_fn):
                yield event
    except Exception as exc:
        logger.exception("Chat error")
        yield {"event": "error", "data": str(exc)[:300]}


async def _chat_openai(
    messages: list[dict],
    model_cfg: dict,
    system: str,
    search_fn,
) -> AsyncIterator[dict]:
    """OpenAI chat with function calling and streaming."""
    from openai import OpenAI

    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    model_id = model_cfg["model_id"]

    # Build messages with system prompt
    api_messages = [{"role": "system", "content": system}] + messages

    all_sources = []
    search_step = 0

    for round_num in range(MAX_TOOL_ROUNDS):
        # Non-streaming call to check for tool use
        response = client.chat.completions.create(
            model=model_id,
            messages=api_messages,
            tools=[SEARCH_TOOL],
            temperature=0.1,
        )

        choice = response.choices[0]

        # If model wants to call tools
        if choice.finish_reason == "tool_calls" and choice.message.tool_calls:
            # Add assistant message with tool calls
            api_messages.append(choice.message.model_dump())

            for tool_call in choice.message.tool_calls:
                if tool_call.function.name == "search_cases":
                    args = json.loads(tool_call.function.arguments)
                    search_step += 1

                    yield {
                        "event": "searching",
                        "data": {"query": args.get("query", ""), "step": search_step},
                    }

                    # Execute search
                    results = search_fn(
                        query=args.get("query", ""),
                        court=args.get("court"),
                        year_from=args.get("year_from"),
                        year_to=args.get("year_to"),
                    )

                    # Format results for LLM
                    results_text = _format_search_results(results)

                    # Collect sources for UI
                    for r in results:
                        source = {
                            "doc_id": r.doc_id,
                            "title": r.title,
                            "court": r.court,
                            "year": r.year,
                            "score": r.score,
                            "text": r.text[:400],
                        }
                        # Deduplicate
                        if not any(s["doc_id"] == source["doc_id"] for s in all_sources):
                            all_sources.append(source)

                    # Add tool result
                    api_messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": results_text,
                    })

            continue  # Next round — LLM may call more tools

        # No tool calls — stream the final answer
        if all_sources:
            yield {"event": "sources", "data": all_sources}

        # Now stream the actual text
        stream = client.chat.completions.create(
            model=model_id,
            messages=api_messages,
            temperature=0.1,
            stream=True,
        )

        for chunk in stream:
            delta = chunk.choices[0].delta
            if delta.content:
                yield {"event": "token", "data": delta.content}

        yield {"event": "done", "data": {}}
        return

    # Exhausted rounds
    if all_sources:
        yield {"event": "sources", "data": all_sources}
    yield {"event": "token", "data": "I performed multiple searches but couldn't find a complete answer. Please try rephrasing your question."}
    yield {"event": "done", "data": {}}


async def _chat_claude(
    messages: list[dict],
    model_cfg: dict,
    system: str,
    search_fn,
) -> AsyncIterator[dict]:
    """Anthropic Claude chat with tool use and streaming."""
    from anthropic import Anthropic

    client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    model_id = model_cfg["model_id"]

    api_messages = list(messages)
    all_sources = []
    search_step = 0

    for round_num in range(MAX_TOOL_ROUNDS):
        response = client.messages.create(
            model=model_id,
            max_tokens=4000,
            system=system,
            messages=api_messages,
            tools=[CLAUDE_SEARCH_TOOL],
            temperature=0.1,
        )

        # Check if tool use is requested
        tool_uses = [b for b in response.content if b.type == "tool_use"]

        if tool_uses:
            # Add assistant response
            api_messages.append({"role": "assistant", "content": response.content})

            tool_results = []
            for tool_use in tool_uses:
                if tool_use.name == "search_cases":
                    args = tool_use.input
                    search_step += 1

                    yield {
                        "event": "searching",
                        "data": {"query": args.get("query", ""), "step": search_step},
                    }

                    results = search_fn(
                        query=args.get("query", ""),
                        court=args.get("court"),
                        year_from=args.get("year_from"),
                        year_to=args.get("year_to"),
                    )

                    results_text = _format_search_results(results)

                    for r in results:
                        source = {
                            "doc_id": r.doc_id, "title": r.title,
                            "court": r.court, "year": r.year,
                            "score": r.score, "text": r.text[:400],
                        }
                        if not any(s["doc_id"] == source["doc_id"] for s in all_sources):
                            all_sources.append(source)

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": results_text,
                    })

            api_messages.append({"role": "user", "content": tool_results})
            continue

        # No tool use — stream the answer
        if all_sources:
            yield {"event": "sources", "data": all_sources}

        # Stream final response
        with client.messages.stream(
            model=model_id,
            max_tokens=4000,
            system=system,
            messages=api_messages,
            temperature=0.1,
        ) as stream:
            for text in stream.text_stream:
                yield {"event": "token", "data": text}

        yield {"event": "done", "data": {}}
        return

    if all_sources:
        yield {"event": "sources", "data": all_sources}
    yield {"event": "token", "data": "Multiple searches performed but no complete answer found."}
    yield {"event": "done", "data": {}}


def _format_search_results(results: list) -> str:
    """Format search results as text context for the LLM."""
    if not results:
        return "No results found for this query."

    parts = []
    for i, r in enumerate(results, 1):
        parts.append(
            f"[Result {i}] {r.title}\n"
            f"Court: {r.court} | Year: {r.year} | Relevance: {r.score}%\n"
            f"{r.text}"
        )
    return "\n\n---\n\n".join(parts)
