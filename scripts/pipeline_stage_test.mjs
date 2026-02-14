#!/usr/bin/env node
/**
 * Pipeline Stage Diagnostic — tests each pipeline stage independently
 * against ground-truth documents from the SEARCH_QUALITY_EXPERIMENT.
 *
 * Stages tested:
 *   Stage 1: Vector search — does Vectorize return ground-truth docs?
 *   Stage 2: Score filter — do they pass the threshold?
 *   Stage 3: Reranker — what score does GPT-4o-mini assign?
 *   Stage 4: Full E2E — run through the API and check final output
 *
 * Usage:
 *   node scripts/pipeline_stage_test.mjs              # All stages
 *   node scripts/pipeline_stage_test.mjs --stage=1    # Just vector search
 *   node scripts/pipeline_stage_test.mjs --stage=3    # Just reranker
 *
 * Requires:
 *   - Dev server running on localhost:3000
 *   - OPENAI_API_KEY in env or frontend/.env.local
 *   - R2/Vectorize credentials in frontend/.env.local
 *
 * See docs/SEARCH_QUALITY_EXPERIMENT.md for full methodology.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

// ── Load env from frontend/.env.local ──────────────────
function loadEnv() {
  try {
    const envPath = join(ROOT, "frontend", ".env.local");
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* ignore */ }
}
loadEnv();

// ── Test Query ─────────────────────────────────────────

const TEST_QUERY =
  "Η εφαρμογή του αλλοδαπού δικαίου σε υποθέσεις περιουσιακών διαφορών στο πλαίσιο διαδικασιών διαζυγίου κατά την τελευταία πενταετία";

// Additional search queries the LLM typically generates (for direct vector search testing)
const SEARCH_QUERIES = [
  "εφαρμογή αλλοδαπού δικαίου περιουσιακές διαφορές διαζύγιο",
  "Κανονισμός 2016/1103 περιουσιακές σχέσεις συζύγων αλλοδαπό δίκαιο",
  "σύγκρουση νόμων περιουσιακές διαφορές διαζύγιο αλλοδαπό δίκαιο",
  "Mareva injunction περιουσιακά στοιχεία διαζύγιο αλλοδαπή",
  "Νόμος 232/91 περιουσιακές σχέσεις συζύγων αλλοδαπός",
];

// ── Ground Truth ───────────────────────────────────────

const GROUND_TRUTH = {
  A: {
    label: "HIGHLY RELEVANT (must find)",
    docs: [
      { id: "A1", path: "apofaseised/oik/2024/2320240403.md", desc: "E.R v P.R — Russian citizens, Mareva, property in divorce" },
      { id: "A2", path: "apofaseised/oik/2025/2320250270.md", desc: "E.R v P.R (later) — freezing €5M+ assets" },
      { id: "A3", path: "apofaseised/oik/2022/2320220243.md", desc: "M. v A. — EU Reg 2016/1103, international jurisdiction" },
      { id: "A4", path: "courtOfAppeal/2025/202512-E4-25.md", desc: "E.R v P.R appeal" },
    ],
  },
  B: {
    label: "PROBABLY RELEVANT (should find)",
    docs: [
      { id: "B1", path: "apofaseised/oik/2025/2320250273.md", desc: "A.K v K.K — €5-10M property, Moscow/Dubai" },
      { id: "B2", path: "apofaseised/oik/2025/2320250275.md", desc: "A.K v K.K — asset freezing" },
      { id: "B3", path: "apofaseised/oik/2025/4320250176.md", desc: "Α.Λ v Ι.Τ — property + divorce + foreign law" },
      { id: "B4", path: "apofaseised/oik/2022/4320220257.md", desc: "Π.Α v Φ.Γ — property abroad" },
      { id: "B5", path: "apofaseised/oik/2022/1320220770.md", desc: "O.S v M.S — property + foreign law" },
      { id: "B6", path: "apofaseised/oik/2024/2320240442.md", desc: "Γ.Χ v Χ.Θ — property + foreign elements" },
    ],
  },
  C: {
    label: "MARGINALLY RELEVANT (ok to miss)",
    docs: [
      { id: "C1", path: "apofaseised/oik/2021/2320210501.md", desc: "Domestic property, no foreign law" },
      { id: "C2", path: "apofaseised/oik/2023/2320230482.md", desc: "Domestic property" },
      { id: "C3", path: "apofaseised/oik/2024/2320240463.md", desc: "Mostly custody (41 mentions)" },
    ],
  },
};

const ALL_GROUND_TRUTH = [
  ...GROUND_TRUTH.A.docs,
  ...GROUND_TRUTH.B.docs,
  ...GROUND_TRUTH.C.docs,
];

// ── Helpers ────────────────────────────────────────────

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

function printHeader(title) {
  console.log(`\n${"═".repeat(100)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(100)}`);
}

function printResult(id, desc, status, detail = "") {
  const icon = status === "FOUND" ? "✅" : status === "MISSED" ? "❌" : "⚠️";
  console.log(`  ${icon} ${pad(id, 4)} ${pad(desc.slice(0, 60), 62)} ${status} ${detail}`);
}

// ── STAGE 1: Vector Search (via E2E) ───────────────────
// No separate search API — we check which ground-truth docs appear in the
// `sources` SSE event from the full chat API. This tells us what survived:
// vector search + score filter + dedup (but BEFORE reranker).

async function testStage1_VectorSearch() {
  printHeader("STAGE 1: VECTOR SEARCH — Do ground-truth docs appear in Phase 1 sources?");
  console.log("  (Running full query via /api/chat and parsing 'sources' SSE event)\n");

  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: TEST_QUERY }],
      model: "gpt-4o",
      sessionId: "pipeline-stage1-test",
    }),
  });

  if (!res.ok) {
    console.log(`  ⚠️ API returned ${res.status}`);
    return new Map();
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  const allSources = [];
  const searches = [];
  const summaries = [];
  let reranked = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ") && currentEvent) {
        const data = line.slice(6);
        if (currentEvent === "searching") {
          try { searches.push(JSON.parse(data)); } catch {}
        }
        if (currentEvent === "sources") {
          try {
            // The server emits the full allSources array each time — take the latest
            const parsed = JSON.parse(data);
            allSources.length = 0;
            allSources.push(...parsed);
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
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`  Completed in ${elapsed}s`);
  console.log(`  Searches: ${searches.length}`);
  for (const s of searches) {
    console.log(`    "${s.query}" (year ${s.year_from ?? s.yearFrom ?? "?"}–${s.year_to ?? s.yearTo ?? "?"})`);
  }

  console.log(`\n  Sources found (Phase 1 output, before reranker): ${allSources.length}`);
  console.log(`  Summaries produced (after reranker + summarizer): ${summaries.length}`);

  // Build lookup maps
  const sourceMap = new Map();
  for (const s of allSources) {
    sourceMap.set(s.doc_id, s);
  }
  const summaryMap = new Map();
  for (const s of summaries) {
    summaryMap.set(s.doc_id ?? s.docId ?? "", s);
  }
  const rerankMap = new Map();
  if (reranked?.scores) {
    for (const s of reranked.scores) {
      rerankMap.set(s.doc_id, s);
    }
  }

  if (reranked) {
    console.log(`\n  Reranker: ${reranked.inputDocs} in → ${reranked.keptCount} kept (threshold ≥${reranked.threshold})`);
  }

  console.log(`\n  Ground truth tracking through pipeline:\n`);
  console.log(`  ${pad("ID", 4)} ${pad("Vec", 8)} ${pad("Src?", 6)} ${pad("Rerank", 8)} ${pad("Kept?", 7)} ${pad("Sum?", 6)} ${pad("Rel", 7)} ${pad("Description", 50)}`);
  console.log(`  ${pad("─", 4)} ${pad("─", 8)} ${pad("─", 6)} ${pad("─", 8)} ${pad("─", 7)} ${pad("─", 6)} ${pad("─", 7)} ${pad("─", 50)}`);

  for (const category of ["A", "B", "C"]) {
    for (const gt of GROUND_TRUTH[category].docs) {
      const src = sourceMap.get(gt.path);
      const rr = rerankMap.get(gt.path);
      const sum = summaryMap.get(gt.path);
      const vecScore = src ? src.score.toFixed(3) : "—";
      const inSources = src ? "✅" : "❌";
      const rrScore = rr ? String(rr.rerank_score) : "—";
      const rrKept = rr ? (rr.kept ? "✅" : "❌") : "—";
      const summarized = sum ? "✅" : "❌";
      const relevance = sum ? ((sum.summary ?? "").includes("HIGH") ? "HIGH" : (sum.summary ?? "").includes("MEDIUM") ? "MEDIUM" : (sum.summary ?? "").includes("NONE") ? "NONE" : "?") : "—";

      console.log(`  ${pad(gt.id, 4)} ${pad(vecScore, 8)} ${pad(inSources, 6)} ${pad(rrScore, 8)} ${pad(rrKept, 7)} ${pad(summarized, 6)} ${pad(relevance, 7)} ${gt.desc.slice(0, 50)}`);
    }
  }

  // Return source map for other stages
  return sourceMap;
}

// ── STAGE 3: Reranker ──────────────────────────────────
// Fetch each ground-truth doc, build preview, send to GPT-4o-mini for scoring

async function testStage3_Reranker() {
  printHeader("STAGE 3: RERANKER — What score does GPT-4o-mini give each ground-truth doc?");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("  ⚠️ OPENAI_API_KEY not set, skipping reranker test");
    return;
  }

  // Read document text from disk (dev mode)
  function fetchDocText(docPath) {
    try {
      const fullPath = join(ROOT, "data", "cases_parsed", docPath);
      return readFileSync(fullPath, "utf-8");
    } catch {
      return null;
    }
  }

  // Replicate buildRerankPreview from llm-client.ts (prefer ΝΟΜΙΚΗ ΠΤΥΧΗ when present)
  const HEAD_CHARS = 300;
  const DECISION_CHARS = 600;
  const TAIL_CHARS = 800;
  const TAIL_SKIP = 200;
  const LEGAL_ANALYSIS_MARKER = "ΝΟΜΙΚΗ ΠΤΥΧΗ";

  function buildPreview(text) {
    const head = text.slice(0, HEAD_CHARS);
    const tailEnd = Math.max(0, text.length - TAIL_SKIP);
    const tailStart = Math.max(0, tailEnd - TAIL_CHARS);
    const tail = tailStart > HEAD_CHARS ? text.slice(tailStart, tailEnd) : "";

    const legalIdx = text.indexOf(LEGAL_ANALYSIS_MARKER);
    const keimenoIdx = text.indexOf("ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ");

    let decisionPreview;
    if (legalIdx !== -1) {
      let start = legalIdx + LEGAL_ANALYSIS_MARKER.length;
      while (start < text.length && /[:\s*]/.test(text[start])) start++;
      decisionPreview = text.slice(start, start + DECISION_CHARS);
    } else if (keimenoIdx !== -1) {
      let start = keimenoIdx + "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ".length;
      while (start < text.length && /[:\s*]/.test(text[start])) start++;
      decisionPreview = text.slice(start, start + DECISION_CHARS);
    } else {
      decisionPreview = text.slice(0, DECISION_CHARS);
    }

    const parts = [head, "\n[...]\n", decisionPreview];
    if (tail) parts.push("\n[...middle omitted...]\n", tail);
    return parts.join("");
  }

  // Fetch all ground-truth docs and build previews
  const previews = [];
  for (const gt of ALL_GROUND_TRUTH) {
    const text = await fetchDocText(gt.path);
    if (!text) {
      console.log(`  ⚠️ Could not fetch ${gt.id} (${gt.path})`);
      continue;
    }
    const preview = buildPreview(text);
    previews.push({ ...gt, preview, textLen: text.length, previewLen: preview.length });
    console.log(`  📄 ${gt.id}: fetched ${text.length} chars → preview ${preview.length} chars`);
  }

  if (previews.length === 0) {
    console.log("  ⚠️ No documents fetched, skipping reranker scoring");
    return;
  }

  // Build the reranker prompt (identical to llm-client.ts)
  const docList = previews
    .map((p, i) => `[DOC_${i}] ${p.path}\n${p.preview}`)
    .join("\n---\n");

  const rerankPrompt = `You are a legal relevance scorer for Cypriot court decisions. The user's research question is:
"${TEST_QUERY}"

Below are ${previews.length} document previews. Each preview shows THREE parts:
1. TITLE/HEADER (case name, parties, date)
2. DECISION OPENING (court name, jurisdiction type, first paragraphs after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ)
3. CONCLUSION/RULING (the court's actual ruling from near the end of the document)

Score each document's likely relevance on a 0-10 scale:
- 0-1: Completely unrelated topic (different area of law entirely)
- 2-3: Same area of law but different legal issue
- 4-5: Related legal issue, might contain useful references or dicta
- 6-7: Directly addresses the topic — court analyzed this specific legal question
- 8-10: Core case — court ruled on this exact legal question

SCORING TIPS:
- The CONCLUSION section is most informative — it shows what the court actually decided
- The JURISDICTION TYPE (e.g., ΠΕΡΙΟΥΣΙΑΚΩΝ ΔΙΑΦΟΡΩΝ, ΟΙΚΟΓΕΝΕΙΑΚΗ) is a strong signal
- If you see legal terms/statutes from the query mentioned in the conclusion, score higher

Respond with ONLY a JSON array of objects: [{"idx": 0, "score": 5}, {"idx": 1, "score": 2}, ...]
No explanation, no markdown fencing, just the JSON array.

Documents:
${docList}`;

  console.log(`\n  Sending ${previews.length} previews to GPT-4o-mini...`);
  console.log(`  Prompt size: ~${(rerankPrompt.length / 4).toFixed(0)} tokens`);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: rerankPrompt }],
        temperature: 0,
        max_tokens: 2000,
      }),
    });

    const data = await res.json();
    const rawOutput = data.choices?.[0]?.message?.content ?? "[]";
    const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      console.log(`  ⚠️ Could not parse reranker output: ${rawOutput.slice(0, 200)}`);
      return;
    }

    const scores = JSON.parse(jsonMatch[0]);
    const scoreMap = new Map();
    for (const s of scores) {
      scoreMap.set(s.idx, s.score);
    }

    console.log(`\n  Reranker scores (threshold = 4):\n`);
    console.log(`  ${pad("ID", 4)} ${pad("Score", 7)} ${pad("Status", 10)} ${pad("Description", 65)}`);
    console.log(`  ${pad("─", 4)} ${pad("─", 7)} ${pad("─", 10)} ${pad("─", 65)}`);

    for (let i = 0; i < previews.length; i++) {
      const p = previews[i];
      const score = scoreMap.get(i) ?? -1;
      const status = score >= 4 ? "KEPT ✅" : "DROPPED ❌";
      console.log(`  ${pad(p.id, 4)} ${pad(score, 7)} ${pad(status, 10)} ${p.desc.slice(0, 65)}`);
    }

    // Summary
    const keptA = previews.filter((p, i) => p.id.startsWith("A") && (scoreMap.get(i) ?? 0) >= 4).length;
    const keptB = previews.filter((p, i) => p.id.startsWith("B") && (scoreMap.get(i) ?? 0) >= 4).length;
    const keptC = previews.filter((p, i) => p.id.startsWith("C") && (scoreMap.get(i) ?? 0) >= 4).length;

    console.log(`\n  Summary: A kept=${keptA}/${GROUND_TRUTH.A.docs.length}, B kept=${keptB}/${GROUND_TRUTH.B.docs.length}, C kept=${keptC}/${GROUND_TRUTH.C.docs.length}`);

    // Show previews for any A-category docs that were DROPPED (for debugging)
    for (let i = 0; i < previews.length; i++) {
      const p = previews[i];
      const score = scoreMap.get(i) ?? 0;
      if (p.id.startsWith("A") && score < 4) {
        console.log(`\n  ⚠️ DROPPED A-CATEGORY DOC: ${p.id} (score=${score})`);
        console.log(`  Preview sent to reranker (first 500 chars):`);
        console.log(`  ${"-".repeat(80)}`);
        const previewLines = p.preview.slice(0, 500).split("\n");
        for (const line of previewLines) {
          console.log(`  | ${line}`);
        }
        console.log(`  ${"-".repeat(80)}`);
      }
    }

    // Token usage
    if (data.usage) {
      console.log(`\n  Token usage: ${data.usage.prompt_tokens} in / ${data.usage.completion_tokens} out`);
      const cost = (data.usage.prompt_tokens * 0.15 + data.usage.completion_tokens * 0.6) / 1_000_000;
      console.log(`  Estimated cost: $${cost.toFixed(4)}`);
    }
  } catch (err) {
    console.log(`  ⚠️ Reranker error: ${err.message}`);
  }
}

// ── STAGE 4: Full E2E ──────────────────────────────────

async function testStage4_E2E() {
  printHeader("STAGE 4: FULL E2E — Run query through API, check which ground-truth docs appear");

  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: TEST_QUERY }],
      model: "gpt-4o",
      sessionId: "pipeline-stage-test",
    }),
  });

  if (!res.ok) {
    console.log(`  ⚠️ API returned ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  const sources = [];
  const summaries = [];
  let e2eReranked = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
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
          try { e2eReranked = JSON.parse(data); } catch {}
        }
        if (currentEvent === "summaries") {
          try { summaries.push(...JSON.parse(data)); } catch {}
        }
        currentEvent = "";
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  Completed in ${elapsed}s`);
  console.log(`  Sources found: ${sources.length}`);
  if (e2eReranked) {
    console.log(`  Reranked: ${e2eReranked.inputDocs} → ${e2eReranked.keptCount} kept (threshold ≥${e2eReranked.threshold})`);
  }
  console.log(`  Summaries produced: ${summaries.length}`);

  const sourceIds = new Set(sources.map((s) => s.doc_id));
  const summaryMap = new Map();
  for (const s of summaries) {
    const docId = s.doc_id ?? s.docId ?? "";
    // Handle both structured summary objects and legacy string summaries
    let relevance;
    if (s.summary && typeof s.summary === "object" && s.summary.relevance) {
      relevance = s.summary.relevance.rating ?? "OTHER";
    } else {
      const summaryStr = typeof s.summary === "string" ? s.summary : JSON.stringify(s.summary ?? "");
      relevance = summaryStr.includes("HIGH") ? "HIGH"
        : summaryStr.includes("MEDIUM") ? "MEDIUM"
        : summaryStr.includes("NONE") ? "NONE"
        : "OTHER";
    }
    summaryMap.set(docId, relevance);
  }
  const e2eRerankMap = new Map();
  if (e2eReranked?.scores) {
    for (const s of e2eReranked.scores) {
      e2eRerankMap.set(s.doc_id, s);
    }
  }

  console.log(`\n  Ground truth check:\n`);
  console.log(`  ${pad("ID", 4)} ${pad("Sources", 9)} ${pad("Rerank", 8)} ${pad("Kept", 6)} ${pad("Summ?", 7)} ${pad("Rel", 8)} ${pad("Description", 55)}`);
  console.log(`  ${pad("─", 4)} ${pad("─", 9)} ${pad("─", 8)} ${pad("─", 6)} ${pad("─", 7)} ${pad("─", 8)} ${pad("─", 55)}`);

  for (const category of ["A", "B", "C"]) {
    for (const gt of GROUND_TRUTH[category].docs) {
      const inSources = sourceIds.has(gt.path) ? "✅" : "❌";
      const rr = e2eRerankMap.get(gt.path);
      const rrScore = rr ? String(rr.rerank_score) : "—";
      const rrKept = rr ? (rr.kept ? "✅" : "❌") : "—";
      const relevance = summaryMap.get(gt.path) ?? "—";
      const summarized = summaryMap.has(gt.path) ? "✅" : "❌";
      console.log(`  ${pad(gt.id, 4)} ${pad(inSources, 9)} ${pad(rrScore, 8)} ${pad(rrKept, 6)} ${pad(summarized, 7)} ${pad(relevance, 8)} ${gt.desc.slice(0, 55)}`);
    }
  }

  // Stats — handle structured summary objects
  function getRelevance(s) {
    if (s.summary && typeof s.summary === "object" && s.summary.relevance) {
      return s.summary.relevance.rating ?? "";
    }
    return typeof s.summary === "string" ? s.summary : JSON.stringify(s.summary ?? "");
  }
  const totalHigh = summaries.filter((s) => getRelevance(s) === "HIGH" || getRelevance(s).includes?.("HIGH")).length;
  const totalMedium = summaries.filter((s) => getRelevance(s) === "MEDIUM" || getRelevance(s).includes?.("MEDIUM")).length;
  const totalLow = summaries.filter((s) => getRelevance(s) === "LOW" || getRelevance(s).includes?.("LOW")).length;
  const totalNone = summaries.filter((s) => getRelevance(s) === "NONE" || getRelevance(s).includes?.("NONE")).length;

  console.log(`\n  Overall: ${summaries.length} summarized → ${totalHigh} HIGH, ${totalMedium} MEDIUM, ${totalLow} LOW, ${totalNone} NONE`);
  console.log(`  Hit rate: ${((totalHigh + totalMedium) / Math.max(summaries.length, 1) * 100).toFixed(0)}%`);
}

// ── Main ───────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const stageArg = args.find((a) => a.startsWith("--stage="));
  const stage = stageArg ? parseInt(stageArg.split("=")[1]) : 0;

  console.log(`\n${"█".repeat(100)}`);
  console.log(`  PIPELINE STAGE DIAGNOSTIC`);
  console.log(`  Query: "${TEST_QUERY.slice(0, 80)}..."`);
  console.log(`  Ground truth: ${ALL_GROUND_TRUTH.length} docs (A=${GROUND_TRUTH.A.docs.length}, B=${GROUND_TRUTH.B.docs.length}, C=${GROUND_TRUTH.C.docs.length})`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`${"█".repeat(100)}`);

  // Check server
  try {
    await fetch(`${BASE_URL}/`);
  } catch {
    console.error(`\n  ⚠️ Dev server not running at ${BASE_URL}`);
    process.exit(1);
  }

  if (stage === 0 || stage === 1) {
    await testStage1_VectorSearch();
  }

  if (stage === 0 || stage === 3) {
    await testStage3_Reranker();
  }

  if (stage === 0 || stage === 4) {
    await testStage4_E2E();
  }

  console.log(`\n${"█".repeat(100)}`);
  console.log(`  DONE — see docs/SEARCH_QUALITY_EXPERIMENT.md for methodology and ground truth`);
  console.log(`${"█".repeat(100)}\n`);
}

main().catch(console.error);
