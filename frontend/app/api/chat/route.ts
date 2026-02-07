/**
 * Chat API route with SSE streaming.
 *
 * POST /api/chat
 * Body: { messages: ChatMessage[], model: string, translate: boolean }
 *
 * Returns a Server-Sent Events stream with events:
 *   - searching: { query, step }
 *   - sources: SearchResult[]
 *   - token: string
 *   - done: {}
 *   - error: string
 *
 * Authentication is handled by Cloudflare Access (Zero Trust).
 */

import { NextRequest, NextResponse } from "next/server";
import { chatStream, stubSearchFn } from "@/lib/llm-client";
import type { ChatMessage } from "@/lib/types";

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

  // Phase 1: use stub search function (returns empty results)
  // Phase 2: replace with Vectorize-backed search
  const searchFn = stubSearchFn;

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
