#!/usr/bin/env node
/**
 * Pipeline integration test — verifies search quality and timing.
 *
 * Tests:
 *   1. E2E query completes within 3 minutes (was 4+ before fixes)
 *   2. Reranker doesn't pass more than MAX_SUMMARIZE_DOCS to summarizer
 *   3. At least 1 HIGH-relevance A-category doc is found
 *   4. SSE stream doesn't hang (events keep arriving)
 *
 * Requires: dev server on localhost:3000 (or E2E_BASE_URL)
 * Cost: ~$1-2 per run (GPT-4o summarization)
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";
const VERBOSE = process.argv.includes("--verbose");

// Load env
try {
  const envPath = join(ROOT, "frontend", ".env.local");
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* ignore */ }

const TEST_QUERY =
  "Η εφαρμογή του αλλοδαπού δικαίου σε υποθέσεις περιουσιακών διαφορών στο πλαίσιο διαδικασιών διαζυγίου κατά την τελευταία πενταετία";

// Ground truth A-category doc IDs (must find at least 1)
const A_DOCS = [
  "apofaseised/oik/2024/2320240403.md",
  "apofaseised/oik/2025/2320250270.md",
  "apofaseised/oik/2022/2320220243.md",
];

const MAX_TIME_MS = 180_000;    // 3 minutes max
const MAX_SUMMARIZE = 20;       // must not exceed this
const MAX_EVENT_GAP_MS = 60_000; // no more than 60s between SSE events

let passed = 0;
let failed = 0;

function assert(name, condition, detail = "") {
  if (condition) {
    passed++;
    if (VERBOSE) console.log(`    ✓ ${name}`);
  } else {
    failed++;
    console.log(`    ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // Check server
  try {
    await fetch(`${BASE_URL}/`);
  } catch {
    console.error(`  Server not running at ${BASE_URL}`);
    process.exit(1);
  }

  console.log(`  Running pipeline test against ${BASE_URL}...`);

  const t0 = Date.now();
  let lastEventTime = t0;
  let maxEventGap = 0;

  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: TEST_QUERY }],
      model: "gpt-4o",
      sessionId: "pipeline-test",
    }),
  });

  assert("API responds with 200", res.ok, `status=${res.status}`);
  if (!res.ok) {
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  const sources = [];
  const summaries = [];
  let reranked = null;
  let eventCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const now = Date.now();
    const gap = now - lastEventTime;
    if (gap > maxEventGap) maxEventGap = gap;
    lastEventTime = now;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
        eventCount++;
      } else if (line.startsWith("data: ") && currentEvent) {
        const data = line.slice(6);
        if (currentEvent === "sources") {
          try {
            const parsed = JSON.parse(data);
            sources.length = 0;
            sources.push(...parsed);
          } catch {}
        }
        if (currentEvent === "reranked") {
          try { reranked = JSON.parse(data); } catch {}
        }
        if (currentEvent === "summaries") {
          try { summaries.push(...JSON.parse(data)); } catch {}
        }
        currentEvent = "";
      }
    }

    // Timeout check
    if (Date.now() - t0 > MAX_TIME_MS) {
      console.log(`    ✗ TIMEOUT — exceeded ${MAX_TIME_MS / 1000}s`);
      failed++;
      break;
    }
  }

  const elapsed = Date.now() - t0;
  const elapsedSec = (elapsed / 1000).toFixed(1);

  if (VERBOSE) {
    console.log(`\n  Stats:`);
    console.log(`    Time: ${elapsedSec}s`);
    console.log(`    Events: ${eventCount}`);
    console.log(`    Sources: ${sources.length}`);
    console.log(`    Reranked: ${reranked?.inputDocs ?? "?"} → ${reranked?.keptCount ?? "?"}`);
    console.log(`    Summaries: ${summaries.length}`);
    console.log(`    Max event gap: ${(maxEventGap / 1000).toFixed(1)}s`);
  }

  // Test assertions
  assert(
    `Completes within ${MAX_TIME_MS / 1000}s`,
    elapsed < MAX_TIME_MS,
    `took ${elapsedSec}s`
  );

  assert(
    `No SSE gap > ${MAX_EVENT_GAP_MS / 1000}s`,
    maxEventGap < MAX_EVENT_GAP_MS,
    `max gap was ${(maxEventGap / 1000).toFixed(1)}s`
  );

  assert(
    "Sources found (> 0)",
    sources.length > 0,
    `found ${sources.length}`
  );

  assert(
    `Summaries ≤ ${MAX_SUMMARIZE}`,
    summaries.length <= MAX_SUMMARIZE,
    `got ${summaries.length}`
  );

  assert(
    "Summaries > 0",
    summaries.length > 0,
    `got ${summaries.length}`
  );

  // Check reranker event was emitted
  assert(
    "Reranked SSE event emitted",
    reranked !== null,
  );

  if (reranked) {
    assert(
      `Reranker kept ≤ ${MAX_SUMMARIZE}`,
      (reranked.keptCount ?? 0) <= MAX_SUMMARIZE,
      `kept ${reranked.keptCount}`
    );
  }

  // Check at least 1 A-category doc found with HIGH relevance
  const summaryDocIds = new Set(summaries.map((s) => s.doc_id ?? s.docId ?? ""));
  const highSummaries = summaries.filter((s) => (s.summary ?? "").includes("HIGH"));
  const highDocIds = new Set(highSummaries.map((s) => s.doc_id ?? s.docId ?? ""));

  const aDocsFound = A_DOCS.filter((id) => summaryDocIds.has(id));
  const aDocsHigh = A_DOCS.filter((id) => highDocIds.has(id));

  assert(
    "At least 1 A-category doc summarized",
    aDocsFound.length >= 1,
    `found ${aDocsFound.length}: ${aDocsFound.join(", ")}`
  );

  assert(
    "At least 1 A-category doc rated HIGH",
    aDocsHigh.length >= 1,
    `HIGH: ${aDocsHigh.length}`
  );

  // Summary
  console.log(`\n  ${passed} passed, ${failed} failed (${elapsedSec}s)`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`  Error: ${err.message}`);
  process.exit(1);
});
