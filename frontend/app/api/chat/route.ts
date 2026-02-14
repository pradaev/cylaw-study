/**
 * Chat API route with SSE streaming and two-phase pipeline.
 *
 * POST /api/chat
 * Body: { messages: ChatMessage[], model: string, sessionId: string }
 *
 * Flow:
 *   Phase 1: LLM formulates search queries → Hybrid search (pgvector + BM25)
 *   Phase 2: Direct summarization via OpenAI (no Service Binding)
 *
 * Document fetching: Always uses localFetchDocument (reads from local disk)
 */

import { NextRequest, NextResponse } from "next/server";
import { chatStream, setFetchDocumentFn, setSessionId, setUserEmail } from "@/lib/llm-client";
import { createHybridSearchFn } from "@/lib/pg-retriever";
import { localFetchDocument } from "@/lib/local-retriever";
import type { ChatMessage } from "@/lib/types";

// Wire up document fetching for the summarizer agents
// Always use local disk - no R2, no Service Binding
setFetchDocumentFn(localFetchDocument);

export async function POST(request: NextRequest) {
  let body: { messages?: ChatMessage[]; model?: string; sessionId?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messages = body.messages ?? [];
  const model = body.model ?? "gpt-4o";
  const sessionId = body.sessionId ?? "unknown";

  // Use anonymous user for now (no Zero Trust auth)
  const userEmail = "anonymous";

  if (messages.length === 0) {
    return NextResponse.json({ error: "No messages" }, { status: 400 });
  }

  // Set session context for structured logging
  setSessionId(sessionId);
  setUserEmail(userEmail);

  const userQuery = messages[messages.length - 1]?.content ?? "";
  console.log(JSON.stringify({
    event: "chat_request",
    sessionId,
    userEmail,
    model,
    messageCount: messages.length,
    queryLength: userQuery.length,
    queryPreview: userQuery.slice(0, 200),
  }));

  // Hybrid search: pgvector + BM25 → RRF fusion (no Vectorize fallback)
  const searchFn = createHybridSearchFn();

  // No Service Binding - direct OpenAI calls only
  const stream = chatStream(messages, model, searchFn);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}