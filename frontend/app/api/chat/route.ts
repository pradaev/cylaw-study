/**
 * Chat API route with SSE streaming and multi-agent summarization.
 *
 * POST /api/chat
 * Body: { messages: ChatMessage[], model: string, translate: boolean }
 *
 * Flow: Main LLM → search_cases → summarize_documents (parallel agents) → answer
 */

import { NextRequest, NextResponse } from "next/server";
import { chatStream, stubSearchFn, setFetchDocumentFn } from "@/lib/llm-client";
import { localSearchFn, localFetchDocument } from "@/lib/local-retriever";
import type { ChatMessage } from "@/lib/types";

// Wire up document fetching for the summarizer agents
const isDev = process.env.NODE_ENV === "development" || process.env.NEXTJS_ENV === "development";

if (isDev) {
  setFetchDocumentFn(localFetchDocument);
}

export async function POST(request: NextRequest) {
  let body: { messages?: ChatMessage[]; model?: string; translate?: boolean };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messages = body.messages ?? [];
  const model = body.model ?? "gpt-4o";
  const translate = body.translate ?? false;

  if (messages.length === 0) {
    return NextResponse.json({ error: "No messages" }, { status: 400 });
  }

  const searchFn = isDev ? localSearchFn : stubSearchFn;
  const stream = chatStream(messages, model, translate, searchFn);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
