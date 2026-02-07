"""Unified LLM client for generating answers from retrieved context.

Supports both OpenAI (GPT-4o-mini) and Anthropic (Claude 3.5 Sonnet).
Provides both blocking and streaming interfaces.
"""

import logging
import os
from dataclasses import dataclass
from typing import AsyncIterator, Optional

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a Cypriot legal research assistant. You help lawyers and researchers find relevant court cases and legal precedents from the Cyprus court system.

RULES:
1. Answer in the SAME LANGUAGE as the user's question (Greek, English, or Russian).
2. Base your answer ONLY on the provided court case excerpts. Do not use external knowledge.
3. CITE every claim by referencing the specific case: mention the case title, court, and year.
4. When quoting relevant passages, use quotation marks and indicate the source case.
5. If the provided context does not contain enough information to answer, say so clearly — do not invent or guess.
6. Structure your answer with clear paragraphs. Start with a direct answer, then provide supporting case references.
7. At the end of your answer, list all cited cases in a "Sources" section.

FORMAT for citing cases:
- In text: "According to the case *CASE_TITLE* (COURT, YEAR), ..."
- Sources section: numbered list with case title, court, year."""

TRANSLATE_SUFFIX = """

IMPORTANT: Write your ENTIRE answer in English. Translate all Greek case excerpts and quotes to English. Keep original Greek case titles in parentheses for reference."""


@dataclass
class Answer:
    """An LLM-generated answer with metadata."""

    text: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int


def _build_context(chunks: list) -> str:
    """Format retrieved chunks as context for the LLM prompt."""
    parts: list[str] = []
    for i, chunk in enumerate(chunks, 1):
        header = (
            f"[Source {i}] {chunk.title} "
            f"(Court: {chunk.court}, Year: {chunk.year})"
        )
        parts.append(f"{header}\n{chunk.text}")
    return "\n\n---\n\n".join(parts)


def _get_system_prompt(translate_to_english: bool = False) -> str:
    """Return system prompt, optionally with translation instruction."""
    prompt = SYSTEM_PROMPT
    if translate_to_english:
        prompt += TRANSLATE_SUFFIX
    return prompt


async def stream_answer(
    question: str,
    context_chunks: list,
    provider: str = "openai",
    translate_to_english: bool = False,
) -> AsyncIterator[str]:
    """Stream answer tokens from the LLM.

    Yields individual text tokens as they arrive.
    """
    context = _build_context(context_chunks)
    user_message = (
        f"Context from Cypriot court cases:\n\n{context}\n\n"
        f"---\n\nQuestion: {question}"
    )
    system = _get_system_prompt(translate_to_english)

    if provider == "openai":
        async for token in _stream_openai(system, user_message):
            yield token
    elif provider == "claude":
        async for token in _stream_claude(system, user_message):
            yield token
    else:
        raise ValueError(f"Unknown provider: {provider}")


async def _stream_openai(
    system: str,
    user_message: str,
) -> AsyncIterator[str]:
    """Stream tokens from OpenAI GPT-4o-mini."""
    from openai import OpenAI

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise ValueError("OPENAI_API_KEY not set")

    client = OpenAI(api_key=key)
    stream = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_message},
        ],
        temperature=0.1,
        max_tokens=2000,
        stream=True,
    )

    for chunk in stream:
        delta = chunk.choices[0].delta
        if delta.content:
            yield delta.content


async def _stream_claude(
    system: str,
    user_message: str,
) -> AsyncIterator[str]:
    """Stream tokens from Anthropic Claude."""
    from anthropic import Anthropic

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise ValueError("ANTHROPIC_API_KEY not set")

    client = Anthropic(api_key=key)
    with client.messages.stream(
        model="claude-sonnet-4-20250514",
        max_tokens=2000,
        system=system,
        messages=[{"role": "user", "content": user_message}],
        temperature=0.1,
    ) as stream:
        for text in stream.text_stream:
            yield text
