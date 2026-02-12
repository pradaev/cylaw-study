#!/usr/bin/env node
/**
 * Compare Vectorize vs Weaviate search quality.
 *
 * Runs the same query through both backends (via searchBackendOverride),
 * collects sources from SSE, compares ground-truth hit rate.
 *
 * Usage:
 *   node scripts/compare_search_backends.mjs
 *   E2E_BASE_URL=http://localhost:3000 node scripts/compare_search_backends.mjs
 *
 * Requires: Dev server running, frontend/.env.local with API keys + R2/Vectorize/Weaviate.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

function loadEnv() {
  try {
    const envPath = join(ROOT, "frontend", ".env.local");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq);
      const v = t.slice(eq + 1).replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnv();

const TEST_QUERY =
  "Η εφαρμογή του αλλοδαπού δικαίου σε υποθέσεις περιουσιακών διαφορών στο πλαίσιο διαδικασιών διαζυγίου κατά την τελευταία πενταετία";

const GROUND_TRUTH = {
  A: [
    "apofaseised/oik/2024/2320240403.md",
    "apofaseised/oik/2025/2320250270.md",
    "apofaseised/oik/2022/2320220243.md",
    "courtOfAppeal/2025/202512-E4-25.md",
  ],
  B: [
    "apofaseised/oik/2025/2320250273.md",
    "apofaseised/oik/2025/2320250275.md",
    "apofaseised/oik/2025/4320250176.md",
    "apofaseised/oik/2022/4320220257.md",
    "apofaseised/oik/2022/1320220770.md",
    "apofaseised/oik/2024/2320240442.md",
  ],
};

/** Normalize doc_id for comparison (strip .md if present, handle path variants) */
function norm(id) {
  if (!id) return "";
  const s = String(id).trim();
  return s.endsWith(".md") ? s : s + ".md";
}

async function runSearch(backend) {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: TEST_QUERY }],
      model: "gpt-4o",
      sessionId: `compare-${backend}`,
      searchBackendOverride: backend,
    }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ev = "";
  let sources = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) ev = line.slice(7);
      else if (line.startsWith("data: ") && ev) {
        if (ev === "sources") {
          try {
            sources = JSON.parse(line.slice(6));
          } catch {}
        }
        // Stop after rerank done (summarizing = Phase 1 complete, saves ~1–2 min)
        if (ev === "summarizing") {
          reader.cancel();
          break;
        }
        ev = "";
      }
    }
    if (ev === "summarizing") break;
  }

  const docIds = new Set(sources.map((s) => norm(s.doc_id ?? s.docId ?? "")));
  return { sources, docIds };
}

function countHits(docIds, list) {
  let n = 0;
  const found = [];
  for (const path of list) {
    const npath = norm(path);
    if (docIds.has(npath)) {
      n++;
      found.push(path);
    }
  }
  return { n, found };
}

async function main() {
  console.log("\n=== Vectorize vs Weaviate quality comparison ===\n");
  console.log("Query:", TEST_QUERY.slice(0, 80) + "...\n");

  let vecResult, weavResult;
  try {
    console.log("Running Vectorize...");
    vecResult = await runSearch("vectorize");
    console.log(`  Sources: ${vecResult.sources.length}`);
  } catch (e) {
    console.error("  Vectorize error:", e.message);
    vecResult = { docIds: new Set(), sources: [] };
  }

  try {
    console.log("Running Weaviate...");
    weavResult = await runSearch("weaviate");
    console.log(`  Sources: ${weavResult.sources.length}`);
  } catch (e) {
    console.error("  Weaviate error:", e.message);
    weavResult = { docIds: new Set(), sources: [] };
  }

  const vecA = countHits(vecResult.docIds, GROUND_TRUTH.A);
  const vecB = countHits(vecResult.docIds, GROUND_TRUTH.B);
  const weavA = countHits(weavResult.docIds, GROUND_TRUTH.A);
  const weavB = countHits(weavResult.docIds, GROUND_TRUTH.B);

  console.log("\n--- Ground truth hits (Phase 1 sources) ---\n");
  console.log("Category A (4 highly relevant):");
  console.log(`  Vectorize: ${vecA.n}/4  ${vecA.found.length ? vecA.found.join(", ") : ""}`);
  console.log(`  Weaviate:  ${weavA.n}/4  ${weavA.found.length ? weavA.found.join(", ") : ""}`);
  console.log("\nCategory B (6 probably relevant):");
  console.log(`  Vectorize: ${vecB.n}/6  ${vecB.found.length ? vecB.found.join(", ") : ""}`);
  console.log(`  Weaviate:  ${weavB.n}/6  ${weavB.found.length ? weavB.found.join(", ") : ""}`);

  const vecTotal = vecA.n + vecB.n;
  const weavTotal = weavA.n + weavB.n;
  console.log("\n--- Summary ---");
  console.log(`  Vectorize: ${vecTotal}/10 ground truth (A+B) | ${vecResult.sources.length} total sources`);
  console.log(`  Weaviate:  ${weavTotal}/10 ground truth (A+B) | ${weavResult.sources.length} total sources`);

  const verbose = process.env.VERBOSE;
  if (verbose) {
    console.log("\n--- Weaviate doc_ids (first 15) ---");
    const weavIds = [...weavResult.docIds].slice(0, 15);
    weavIds.forEach((id) => console.log("  ", id));
  }

  if (weavTotal > vecTotal) {
    console.log("\n  Weaviate wins on ground truth hits.");
  } else if (vecTotal > weavTotal) {
    console.log("\n  Vectorize wins on ground truth hits.");
  } else {
    console.log("\n  Tie on ground truth hits.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
