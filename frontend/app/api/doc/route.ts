/**
 * Document viewer API route.
 *
 * GET /api/doc?doc_id=administrative/2016/201601-1113-13.md
 *
 * In development: reads .md files from local data/cases_parsed/ directory.
 * In production: reads from Cloudflare R2 bucket.
 */

import { NextRequest, NextResponse } from "next/server";
import { marked } from "marked";
import { readFile } from "fs/promises";
import { join, resolve } from "path";

export async function GET(request: NextRequest) {
  const docId = request.nextUrl.searchParams.get("doc_id");

  if (!docId) {
    return NextResponse.json({ error: "doc_id parameter required" }, { status: 400 });
  }

  // Prevent directory traversal
  if (docId.includes("..") || docId.startsWith("/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // Auto-append .md if missing (LLM sometimes omits it)
  const normalizedDocId = docId.endsWith(".md") ? docId : `${docId}.md`;

  try {
    const mdText = await loadDocument(normalizedDocId);

    if (!mdText) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const html = await marked.parse(mdText);

    // Extract title from first heading
    const firstLine = mdText.split("\n")[0] ?? "";
    const title = firstLine.replace(/^#+\s*/, "").trim().slice(0, 200);

    return NextResponse.json({ doc_id: normalizedDocId, html, title });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Doc route error:", message);
    return NextResponse.json({ error: "Failed to load document" }, { status: 500 });
  }
}

async function loadDocument(docId: string): Promise<string | null> {
  const isDev = process.env.NODE_ENV === "development" || process.env.NEXTJS_ENV === "development";

  if (isDev) {
    // Try R2 first (works with initOpenNextCloudflareForDev), fallback to disk
    const r2Text = await loadFromR2(docId).catch(() => null);
    if (r2Text) return r2Text;
    return loadFromDisk(docId);
  }

  return loadFromR2(docId);
}

/** Development: read from local data/cases_parsed/ directory */
async function loadFromDisk(docId: string): Promise<string | null> {
  const casesDir = join(process.cwd(), "..", "data", "cases_parsed");
  const filePath = resolve(casesDir, docId);

  // Double-check resolved path is still within cases_parsed
  if (!filePath.startsWith(resolve(casesDir))) {
    return null;
  }

  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Production / dev with wrangler: read from Cloudflare R2 bucket */
async function loadFromR2(docId: string): Promise<string | null> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = await getCloudflareContext({ async: true });
  const bucket = (env as unknown as CloudflareEnv).DOCS_BUCKET;
  const object = await bucket.get(docId);

  if (!object) return null;

  return object.text();
}
