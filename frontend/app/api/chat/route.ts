/**
 * Chat API route with SSE streaming and multi-agent summarization.
 *
 * POST /api/chat
 * Body: { messages: ChatMessage[], model: string, translate: boolean }
 *
 * Flow: Main LLM → search_cases → summarize_documents (parallel agents) → answer
 *
 * Document fetching for summarizer:
 *   - Production (Cloudflare Workers): reads from R2 bucket via binding
 *   - Dev with wrangler / initOpenNextCloudflareForDev: also reads from R2
 *   - Dev fallback (no CF context): reads from local Python search server
 */

import { NextRequest, NextResponse } from "next/server";
import { chatStream, stubSearchFn, setFetchDocumentFn } from "@/lib/llm-client";
import { localSearchFn, localFetchDocument } from "@/lib/local-retriever";
import type { ChatMessage } from "@/lib/types";
import type { FetchDocumentFn } from "@/lib/llm-client";

const isDev = process.env.NODE_ENV === "development" || process.env.NEXTJS_ENV === "development";

/**
 * Fetch document from Cloudflare R2 bucket.
 * Uses async mode for getCloudflareContext — required in dev (Node.js runtime),
 * also works in production (Workers runtime).
 */
const r2FetchDocument: FetchDocumentFn = async (docId: string): Promise<string | null> => {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    const bucket = (env as unknown as CloudflareEnv).DOCS_BUCKET;
    const object = await bucket.get(docId);
    if (!object) return null;
    return object.text();
  } catch (err) {
    console.error("[r2FetchDocument] Failed to read from R2:", docId, err instanceof Error ? err.message : err);
    return null;
  }
};

/**
 * Fetch document with R2-first strategy.
 * Tries R2 binding first (works in prod and wrangler dev),
 * falls back to local Python search server if R2 is unavailable (plain npm run dev).
 */
const fetchDocumentWithFallback: FetchDocumentFn = async (docId: string): Promise<string | null> => {
  const r2Result = await r2FetchDocument(docId);
  if (r2Result) return r2Result;

  // Fallback to local Python server (only useful in dev)
  return localFetchDocument(docId);
};

// Wire up document fetching for the summarizer agents
if (isDev) {
  // In dev: try R2 first (works with wrangler dev / initOpenNextCloudflareForDev),
  // fall back to local Python server if CF context is not available
  setFetchDocumentFn(fetchDocumentWithFallback);
} else {
  // In production: R2 only
  setFetchDocumentFn(r2FetchDocument);
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
