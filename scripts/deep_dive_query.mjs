#!/usr/bin/env node
/**
 * Deep-dive diagnostic for a single query through the full pipeline.
 *
 * Shows EVERYTHING that happens under the hood:
 *   1. LLM search decisions (queries, filters, court_level)
 *   2. Every document found with score, court, year, title
 *   3. Deduplication results
 *   4. Summarization results with relevance levels
 *   5. NONE-filtered docs vs kept
 *   6. Court/year distribution
 *   7. Final answer
 *
 * Usage:
 *   node scripts/deep_dive_query.mjs
 *   node scripts/deep_dive_query.mjs "custom query text"
 *
 * Requires: dev server running on localhost:3000
 */

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

const DEFAULT_QUERY =
  "Η εφαρμογή του αλλοδαπού δικαίου σε υποθέσεις περιουσιακών διαφορών στο πλαίσιο διαδικασιών διαζυγίου κατά την τελευταία πενταετία";

const query = process.argv[2] || DEFAULT_QUERY;

// ── SSE Parser ─────────────────────────────────────────

async function runQuery(q) {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: q }],
      model: "gpt-4o",
      sessionId: "deep-dive-test",
    }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  const profile = {
    searches: [],
    sources: [],
    reranked: null,
    summarized: 0,
    summaryBatches: [],
    summaries: [],
    answer: "",
    usage: null,
    errors: [],
    rawEvents: [],
  };

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
        profile.rawEvents.push({ event: currentEvent, data });

        switch (currentEvent) {
          case "searching": {
            const d = JSON.parse(data);
            profile.searches.push(d);
            break;
          }
          case "sources": {
            profile.sources = JSON.parse(data);
            break;
          }
          case "reranked": {
            profile.reranked = JSON.parse(data);
            break;
          }
          case "summarizing": {
            const d = JSON.parse(data);
            profile.summarized += d.count;
            profile.summaryBatches.push(d);
            break;
          }
          case "summaries": {
            const entries = JSON.parse(data);
            profile.summaries.push(...entries);
            break;
          }
          case "token": {
            profile.answer += data.replace(/\\n/g, "\n");
            break;
          }
          case "usage": {
            profile.usage = JSON.parse(data);
            break;
          }
          case "error": {
            profile.errors.push(data);
            break;
          }
        }
        currentEvent = "";
      }
    }
  }

  return profile;
}

// ── Court Level / Relevance Helpers ────────────────────

const COURT_LEVEL_MAP = {
  aad: "supreme", supreme: "supreme", supremeAdministrative: "supreme",
  jsc: "supreme", rscc: "supreme", clr: "supreme",
  areiospagos: "foreign",
  courtOfAppeal: "appeal", administrativeCourtOfAppeal: "appeal",
  apofaseised: "first_instance", juvenileCourt: "first_instance",
  administrative: "administrative", administrativeIP: "administrative",
  epa: "other", aap: "other",
};

function getCourtLevel(court) {
  return COURT_LEVEL_MAP[court] ?? "other";
}

function parseRelevance(summary) {
  const section = (summary ?? "").split(/RELEVANCE RATING/i)[1] ?? "";
  for (const level of ["HIGH", "MEDIUM", "LOW", "NONE"]) {
    if (new RegExp(`\\b${level}\\b`).test(section)) return level;
  }
  return "UNKNOWN";
}

function parseEngagement(summary) {
  const text = summary ?? "";
  if (/\bRULED\b/.test(text)) return "RULED";
  if (/\bDISCUSSED\b/.test(text)) return "DISCUSSED";
  if (/\bMENTIONED\b/.test(text)) return "MENTIONED";
  if (/\bNOT ADDRESSED\b/.test(text)) return "NOT_ADDRESSED";
  return "UNKNOWN";
}

// ── Display Helpers ────────────────────────────────────

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }
function line(ch = "─", n = 100) { return ch.repeat(n); }

function printSection(title) {
  console.log(`\n${"═".repeat(100)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(100)}`);
}

function printSubSection(title) {
  console.log(`\n  ${line("─", 96)}`);
  console.log(`  ${title}`);
  console.log(`  ${line("─", 96)}`);
}

// ── Main ──────────────────────────────────────────────

async function main() {
  // Check server
  try {
    await fetch(`${BASE_URL}/`);
  } catch {
    console.error(`Dev server not running at ${BASE_URL}`);
    process.exit(1);
  }

  console.log(`\n${"█".repeat(100)}`);
  console.log(`  DEEP DIVE QUERY ANALYSIS`);
  console.log(`${"█".repeat(100)}`);
  console.log(`\n  Query: "${query}"`);
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  Time: ${new Date().toISOString()}`);

  const t0 = Date.now();
  const profile = await runQuery(query);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // ── 1. SEARCH STEPS ──────────────────────────────────

  printSection(`1. LLM SEARCH DECISIONS (${profile.searches.length} searches)`);

  for (let i = 0; i < profile.searches.length; i++) {
    const s = profile.searches[i];
    const yf = s.year_from ?? s.yearFrom ?? "";
    const yt = s.year_to ?? s.yearTo ?? "";
    const cl = s.court_level ?? s.courtLevel ?? "";
    const yr = yf ? `  Year: ${yf}–${yt}` : "  Year: any";
    const court = cl ? `  Court: ${cl}` : "  Court: any";

    console.log(`\n  Search #${i + 1} (step ${s.step}):`);
    console.log(`    Query: "${s.query}"`);
    console.log(`   ${yr}${court}`);
    console.log(`    Results: ${s.resultsCount ?? "?"} found, ${s.newUniqueCount ?? "?"} new unique`);
  }

  // ── 2. ALL SOURCES ───────────────────────────────────

  printSection(`2. ALL SOURCES FOUND (${profile.sources.length} documents)`);

  // Enrich with derived court_level
  const enrichedSources = profile.sources.map((s) => ({
    ...s,
    court_level: getCourtLevel(s.court ?? ""),
  }));

  // Sort by score desc
  const sortedSources = [...enrichedSources].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  console.log(`\n  ${pad("#", 4)} ${pad("Score", 8)} ${pad("Court", 22)} ${pad("Level", 16)} ${pad("Year", 6)} ${pad("Doc ID", 55)}`);
  console.log(`  ${pad("─", 4)} ${pad("─", 8)} ${pad("─", 22)} ${pad("─", 16)} ${pad("─", 6)} ${pad("─", 55)}`);

  for (let i = 0; i < sortedSources.length; i++) {
    const s = sortedSources[i];
    console.log(
      `  ${pad(i + 1, 4)} ${pad((s.score ?? 0).toFixed(4), 8)} ${pad(s.court ?? "—", 22)} ${pad(s.court_level ?? "—", 16)} ${pad(s.year ?? "—", 6)} ${s.doc_id?.slice(0, 55) ?? "—"}`
    );
  }

  // ── 3. COURT DISTRIBUTION ────────────────────────────

  printSubSection("Court Distribution");
  const courtDist = {};
  const courtLevelDist = {};
  const yearDist = {};
  for (const s of sortedSources) {
    const court = s.court || "unknown";
    const level = s.court_level || "unknown";
    const year = s.year || "unknown";
    courtDist[court] = (courtDist[court] || 0) + 1;
    courtLevelDist[level] = (courtLevelDist[level] || 0) + 1;
    yearDist[year] = (yearDist[year] || 0) + 1;
  }

  console.log(`\n  By court_level:`);
  for (const [level, count] of Object.entries(courtLevelDist).sort((a, b) => b[1] - a[1])) {
    const bar = "█".repeat(count);
    console.log(`    ${pad(level, 20)} ${padL(count, 3)}  ${bar}`);
  }

  console.log(`\n  By court:`);
  for (const [court, count] of Object.entries(courtDist).sort((a, b) => b[1] - a[1])) {
    const bar = "█".repeat(count);
    console.log(`    ${pad(court, 20)} ${padL(count, 3)}  ${bar}`);
  }

  console.log(`\n  By year (top 10):`);
  const yearEntries = Object.entries(yearDist).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [year, count] of yearEntries) {
    const bar = "█".repeat(count);
    console.log(`    ${pad(year, 20)} ${padL(count, 3)}  ${bar}`);
  }

  // ── 3b. RERANKER RESULTS ────────────────────────────

  if (profile.reranked) {
    printSection(`2b. RERANKER (${profile.reranked.inputDocs} in → ${profile.reranked.keptCount} kept, threshold ≥${profile.reranked.threshold})`);

    if (profile.reranked.scores) {
      const scoreSorted = [...profile.reranked.scores].sort((a, b) => b.rerank_score - a.rerank_score);
      console.log(`\n  ${pad("Score", 7)} ${pad("Kept?", 7)} ${pad("Doc ID", 80)}`);
      console.log(`  ${pad("─", 7)} ${pad("─", 7)} ${pad("─", 80)}`);

      for (const s of scoreSorted) {
        const status = s.kept ? "✅" : "❌";
        console.log(`  ${pad(s.rerank_score, 7)} ${pad(status, 7)} ${s.doc_id?.slice(0, 80) ?? "—"}`);
      }
    }
  }

  // ── 4. SUMMARIZATION RESULTS ─────────────────────────

  printSection(`3. SUMMARIZATION (${profile.summaries.length} summaries)`);

  // Enrich summaries with parsed relevance and engagement
  const enrichedSummaries = profile.summaries.map((s) => ({
    ...s,
    relevance: parseRelevance(s.summary),
    engagement: parseEngagement(s.summary),
    // Find matching source for court/year
    ...(sortedSources.find((src) => src.doc_id === (s.doc_id ?? s.docId)) ?? {}),
  }));

  // Group by relevance
  const relevanceGroups = { HIGH: [], MEDIUM: [], LOW: [], NONE: [], UNKNOWN: [] };
  for (const s of enrichedSummaries) {
    const bucket = relevanceGroups[s.relevance] ? s.relevance : "UNKNOWN";
    relevanceGroups[bucket].push(s);
  }

  console.log(`\n  Relevance distribution:`);
  for (const [level, docs] of Object.entries(relevanceGroups)) {
    if (docs.length > 0) {
      const bar = "█".repeat(docs.length);
      console.log(`    ${pad(level, 10)} ${padL(docs.length, 3)}  ${bar}`);
    }
  }

  // Engagement distribution
  const engagementDist = {};
  for (const s of enrichedSummaries) {
    engagementDist[s.engagement] = (engagementDist[s.engagement] || 0) + 1;
  }
  console.log(`\n  Engagement distribution:`);
  for (const [level, count] of Object.entries(engagementDist).sort((a, b) => b[1] - a[1])) {
    const bar = "█".repeat(count);
    console.log(`    ${pad(level, 16)} ${padL(count, 3)}  ${bar}`);
  }

  // Show HIGH relevance docs in detail
  if (relevanceGroups.HIGH.length > 0) {
    printSubSection(`HIGH relevance (${relevanceGroups.HIGH.length})`);
    for (const s of relevanceGroups.HIGH) {
      const docId = s.doc_id ?? s.docId ?? "—";
      const title = s.title ?? "";
      const level = s.court_level ?? getCourtLevel(s.court ?? "");
      console.log(`\n    📄 ${docId}`);
      if (title) console.log(`       Title: ${title.slice(0, 90)}`);
      console.log(`       Court: ${s.court ?? "?"} (${level}), Year: ${s.year ?? "?"}, Engagement: ${s.engagement}`);
      if (s.summary) {
        const summaryLines = s.summary.split("\n").filter((l) => l.trim());
        for (const ln of summaryLines.slice(0, 5)) {
          console.log(`       ${ln.slice(0, 100)}`);
        }
        if (summaryLines.length > 5) console.log(`       ... +${summaryLines.length - 5} more lines`);
      }
    }
  }

  // Show MEDIUM relevance docs
  if (relevanceGroups.MEDIUM.length > 0) {
    printSubSection(`MEDIUM relevance (${relevanceGroups.MEDIUM.length})`);
    for (const s of relevanceGroups.MEDIUM) {
      const docId = s.doc_id ?? s.docId ?? "—";
      const level = s.court_level ?? getCourtLevel(s.court ?? "");
      console.log(`    📄 ${docId} — ${s.court ?? ""} (${level}) ${s.year ?? ""} — ${s.engagement}`);
      if (s.summary) {
        // Extract the "WHAT THE CASE IS ABOUT" line
        const aboutLine = s.summary.split("\n").find((l) => /CASE IS|ABOUT|ΑΦΟΡΑ/i.test(l)) ?? s.summary.split("\n").find((l) => l.trim().length > 30) ?? "";
        console.log(`       ${aboutLine.slice(0, 120)}`);
      }
    }
  }

  // Show LOW relevance docs
  if (relevanceGroups.LOW.length > 0) {
    printSubSection(`LOW relevance (${relevanceGroups.LOW.length})`);
    for (const s of relevanceGroups.LOW) {
      const docId = s.doc_id ?? s.docId ?? "—";
      console.log(`    ⚠ ${docId} — ${s.court ?? ""} ${s.year ?? ""} — ${s.engagement}`);
    }
  }

  // Show NONE docs
  if (relevanceGroups.NONE.length > 0) {
    printSubSection(`NONE / filtered out (${relevanceGroups.NONE.length})`);
    for (const s of relevanceGroups.NONE) {
      const docId = s.doc_id ?? s.docId ?? "—";
      console.log(`    ❌ ${docId} — ${s.court ?? ""} ${s.year ?? ""}`);
    }
  }

  // ── 5. FINAL ANSWER ──────────────────────────────────

  printSection("4. FINAL LLM ANSWER");
  if (profile.answer) {
    console.log();
    const answerLines = profile.answer.split("\n");
    for (const line of answerLines.slice(0, 30)) {
      console.log(`  ${line}`);
    }
    if (answerLines.length > 30) console.log(`  ... +${answerLines.length - 30} more lines`);
  } else {
    console.log("  (no answer text)");
  }

  // ── 6. USAGE & ERRORS ───────────────────────────────

  printSection("5. STATS");
  const kept = (relevanceGroups.HIGH?.length ?? 0) + (relevanceGroups.MEDIUM?.length ?? 0) + (relevanceGroups.LOW?.length ?? 0);
  const filtered = relevanceGroups.NONE?.length ?? 0;

  console.log(`\n  Total time: ${elapsed}s`);
  console.log(`  Searches: ${profile.searches.length}`);
  console.log(`  Sources found: ${profile.sources.length}`);
  console.log(`  Summaries: ${profile.summaries.length}`);
  console.log(`    HIGH: ${relevanceGroups.HIGH?.length ?? 0}`);
  console.log(`    MEDIUM: ${relevanceGroups.MEDIUM?.length ?? 0}`);
  console.log(`    LOW: ${relevanceGroups.LOW?.length ?? 0}`);
  console.log(`    NONE (filtered): ${filtered}`);
  console.log(`  Kept/Total: ${kept}/${profile.summaries.length} (${profile.summaries.length > 0 ? ((kept / profile.summaries.length) * 100).toFixed(0) : 0}%)`);

  if (profile.usage) {
    console.log(`  Model: ${profile.usage.model}`);
    console.log(`  Input tokens: ${profile.usage.inputTokens?.toLocaleString()}`);
    console.log(`  Output tokens: ${profile.usage.outputTokens?.toLocaleString()}`);
    console.log(`  Documents analyzed: ${profile.usage.documentsAnalyzed}`);
  }

  if (profile.errors.length > 0) {
    console.log(`\n  ⚠️  ERRORS (${profile.errors.length}):`);
    for (const e of profile.errors) {
      console.log(`    ${e}`);
    }
  }

  console.log(`\n${"█".repeat(100)}\n`);
}

main().catch(console.error);
