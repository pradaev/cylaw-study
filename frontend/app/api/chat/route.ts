/**
 * Chat API route with SSE streaming and two-phase pipeline.
 *
 * POST /api/chat
 * Body: { messages: ChatMessage[], model: string, sessionId: string }
 *
 * Flow:
 *   Phase 1: LLM formulates search queries → Vectorize search (fast, metadata only)
 *   Phase 2: Batch summarization via cylaw-summarizer Worker (Service Binding)
 *
 * Document fetching for summarizer:
 *   - Production: R2 via Worker binding
 *   - Dev: R2 via S3 HTTP API
 */

import { NextRequest, NextResponse } from "next/server";
import { chatStream, setFetchDocumentFn, setSessionId, setUserEmail } from "@/lib/llm-client";
import { localFetchDocument } from "@/lib/local-retriever";
import { createVectorizeSearchFn } from "@/lib/retriever";
import { createHybridSearchFn } from "@/lib/pg-retriever";
import { createBindingClient, createHttpClient } from "@/lib/vectorize-client";
import type { ChatMessage } from "@/lib/types";
import type { FetchDocumentFn } from "@/lib/llm-client";

const isDev = process.env.NODE_ENV === "development" || process.env.NEXTJS_ENV === "development";
/** True when running on Node (Railway, Fly.io) — use HTTP clients, no Worker bindings */
const isNodeRuntime = process.env.DEPLOY_TARGET === "node" || process.env.RAILWAY_ENVIRONMENT != null;

/**
 * Fetch document from Cloudflare R2 via Worker binding.
 * Only works in production (Cloudflare Workers runtime) where the real R2 bucket is bound.
 * In dev, initOpenNextCloudflareForDev provides a LOCAL emulator (miniflare) which is empty,
 * so this will return null — use r2FetchViaS3 for dev instead.
 */
const r2FetchViaBinding: FetchDocumentFn = async (docId: string): Promise<string | null> => {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const bucket = (ctx.env as unknown as CloudflareEnv).DOCS_BUCKET;
    if (!bucket) return null;
    const object = await bucket.get(docId);
    if (!object) return null;
    return object.text();
  } catch {
    return null;
  }
};

/**
 * Fetch document from R2 via S3-compatible HTTP API.
 * Works in dev (Node.js runtime) by calling the real Cloudflare R2 over HTTPS.
 * Requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY env vars.
 */
const r2FetchViaS3: FetchDocumentFn = async (docId: string): Promise<string | null> => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKey = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const bucket = "cyprus-case-law-docs";

  if (!accountId || !accessKey || !secretKey) {
    console.error("[r2FetchViaS3] Missing R2 credentials in env");
    return null;
  }

  try {
    // Use unsigned URL with AWS Signature V4 via fetch
    // R2 S3 endpoint: https://{account_id}.r2.cloudflarestorage.com
    const url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${docId}`;

    // AWS Signature V4 — construct manually for a simple GET
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, "").slice(0, 8);
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const region = "auto";
    const service = "s3";

    const { createHmac, createHash } = await import("crypto");

    function hmacSha256(key: Buffer | string, data: string): Buffer {
      return createHmac("sha256", key).update(data).digest();
    }
    function sha256(data: string): string {
      return createHash("sha256").update(data).digest("hex");
    }

    const host = `${accountId}.r2.cloudflarestorage.com`;
    const canonicalUri = `/${bucket}/${docId}`;
    const canonicalQuerystring = "";
    const payloadHash = sha256("");
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

    const canonicalRequest = [
      "GET", canonicalUri, canonicalQuerystring,
      canonicalHeaders, signedHeaders, payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest),
    ].join("\n");

    const signingKey = hmacSha256(
      hmacSha256(
        hmacSha256(
          hmacSha256(`AWS4${secretKey}`, dateStamp),
          region,
        ),
        service,
      ),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(url, {
      headers: {
        Host: host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        Authorization: authorization,
      },
    });

    if (!res.ok) {
      console.error("[r2FetchViaS3] HTTP", res.status, "for", docId);
      return null;
    }

    return res.text();
  } catch (err) {
    console.error("[r2FetchViaS3] Error:", docId, err instanceof Error ? err.message : err);
    return null;
  }
};

// Wire up document fetching for the summarizer agents
if (isDev || isNodeRuntime) {
  // Dev / Node (Railway): use S3 HTTP API for R2; fallback to local if no credentials
  setFetchDocumentFn(async (docId) => {
    const r2Text = await r2FetchViaS3(docId);
    if (r2Text) return r2Text;
    return localFetchDocument(docId);
  });
} else {
  // Cloudflare Workers: use binding (direct, zero-latency)
  setFetchDocumentFn(r2FetchViaBinding);
}

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

  // Get authenticated user email from Cloudflare Zero Trust
  const userEmail = request.headers.get("Cf-Access-Authenticated-User-Email") ?? "anonymous";

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

  // Vectorize client (text-embedding-3-small 1536d) — fallback only, used when pgvector has no data.
  // TODO: Remove after deploying hosted PostgreSQL (Neon/Supabase) to production.
  const vectorizeClient =
    isDev || isNodeRuntime
      ? createHttpClient()
      : await (async () => {
          const { getCloudflareContext } = await import("@opennextjs/cloudflare");
          const ctx = await getCloudflareContext({ async: true });
          return createBindingClient(ctx.env as unknown as CloudflareEnv);
        })();
  const vectorizeSearchFn = createVectorizeSearchFn(vectorizeClient);

  // Hybrid search: pgvector (primary) + BM25 → RRF fusion.
  // Automatically falls back to Vectorize if pgvector has no data (production without hosted PG).
  const searchFn = createHybridSearchFn(vectorizeSearchFn);

  // Get Summarizer binding (Cloudflare Workers only; Node uses direct OpenAI)
  let summarizerBinding: Fetcher | undefined;
  if (!isDev && !isNodeRuntime) {
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const ctx = await getCloudflareContext({ async: true });
      summarizerBinding = (ctx.env as unknown as CloudflareEnv).SUMMARIZER;
    } catch {
      // No binding available — will fall back to direct calls
    }
  }

  const stream = chatStream(messages, model, searchFn, summarizerBinding);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
