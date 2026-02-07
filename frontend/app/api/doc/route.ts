/**
 * Document viewer API route.
 *
 * GET /api/doc?doc_id=administrative/2016/201601-1113-13.md
 *
 * Reads a Markdown file from R2 and returns rendered HTML.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { marked } from "marked";

export async function GET(request: NextRequest) {
  const docId = request.nextUrl.searchParams.get("doc_id");

  if (!docId) {
    return NextResponse.json({ error: "doc_id parameter required" }, { status: 400 });
  }

  // Prevent directory traversal
  if (docId.includes("..") || docId.startsWith("/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const { env } = getCloudflareContext() as { env: CloudflareEnv };
    const bucket = env.DOCS_BUCKET;
    const object = await bucket.get(docId);

    if (!object) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const mdText = await object.text();
    const html = await marked.parse(mdText);

    // Extract title from first heading
    const firstLine = mdText.split("\n")[0] ?? "";
    const title = firstLine.replace(/^#+\s*/, "").trim().slice(0, 200);

    return NextResponse.json({ doc_id: docId, html, title });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Doc route error:", message);
    return NextResponse.json({ error: "Failed to load document" }, { status: 500 });
  }
}
