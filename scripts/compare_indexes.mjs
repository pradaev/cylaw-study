#!/usr/bin/env node
/**
 * Compare search results between old and new Vectorize indexes.
 *
 * For each test query: embed once, query both indexes, print side-by-side:
 *   - Top-K scores (avg, max, distribution)
 *   - Overlap of top-30 doc_ids
 *   - Metadata completeness (title, court, year, jurisdiction)
 *   - Court-level distribution
 *
 * Usage:
 *   node scripts/compare_indexes.mjs
 *   node scripts/compare_indexes.mjs --verbose
 *
 * Requires: OPENAI_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
 */

import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, "../frontend/"));
const OpenAI = require("openai").default;

const VERBOSE = process.argv.includes("--verbose");

// ── Config ─────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";
const TOP_K = 100;
const MAX_DOCS = 30;

const OLD_INDEX = "cyprus-law-cases-search";
const NEW_INDEX = "cyprus-law-cases-search-revised";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;

if (!accountId || !apiToken || !openaiKey) {
  console.error("Missing env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, OPENAI_API_KEY");
  process.exit(1);
}

const cfHeaders = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };

function indexUrl(name) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${name}`;
}

// ── Test Queries ───────────────────────────────────────

const QUERIES = [
  {
    id: "freezing-orders",
    query: "Ρωσικό δίκαιο περιουσιακή διαφορά συζύγων Λεμεσός παγοποιητικό διάταγμα",
    knownDocId: "apofaseised/oik/2024/2320240403.md",
  },
  {
    id: "interim-freezing",
    query: "ενδιάμεσα παγοποιητικά διατάγματα περιουσιακές διαφορές συζύγων οικογενειακό δικαστήριο",
  },
  {
    id: "foreign-law",
    query: "εφαρμογή αλλοδαπού δικαίου σε περιουσιακές διαφορές μεταξύ συζύγων",
  },
  {
    id: "property-divorce",
    query: "ακίνητη περιουσία διαζύγιο κατανομή",
  },
  {
    id: "medical-negligence",
    query: "αστική ευθύνη ιατρική αμέλεια αποζημίωση",
  },
  {
    id: "one-third-presumption",
    query: "Πώς εφαρμόζουν τα δικαστήρια το τεκμήριο του ενός τρίτου σε υποθέσεις περιουσιακών διαφορών σε διαζύγια;",
  },
  {
    id: "amending-pleadings",
    query: "Βρες τις κυρίες αποφάσεις του Ανώτατου Δικαστηρίου που αναλύουν τις βασικές αρχές για την τροποποίηση δικογράφου μετά την καταχώρηση.",
  },
  {
    id: "delay-defence",
    query: "Βρες αποφάσεις που εξετάζουν πότε η καθυστέρηση στην κατάθεση αγωγής μπορεί να αποτελέσει άμυνα.",
  },
];

// ── Helpers ────────────────────────────────────────────

async function embed(client, text) {
  const resp = await client.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return resp.data[0].embedding;
}

async function queryIndex(indexName, vector) {
  const res = await fetch(`${indexUrl(indexName)}/query`, {
    method: "POST",
    headers: cfHeaders,
    body: JSON.stringify({ vector, topK: TOP_K, returnMetadata: "none", returnValues: false }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`Query ${indexName} failed: ${JSON.stringify(json.errors)}`);
  return json.result;
}

async function getByIds(indexName, ids) {
  const BATCH = 20;
  const all = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const res = await fetch(`${indexUrl(indexName)}/get_by_ids`, {
      method: "POST",
      headers: cfHeaders,
      body: JSON.stringify({ ids: batch }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(`getByIds ${indexName} failed`);
    all.push(...json.result);
  }
  return all;
}

function extractDocPrefix(id) {
  const sep = id.lastIndexOf("::");
  return sep !== -1 ? id.slice(0, sep) : id;
}

async function searchIndex(indexName, vector) {
  const results = await queryIndex(indexName, vector);
  if (!results.matches?.length) return [];

  // Group by doc prefix, keep best score
  const docMap = new Map();
  for (const match of results.matches) {
    const docPrefix = extractDocPrefix(match.id);
    const existing = docMap.get(docPrefix);
    if (existing) {
      if (match.score > existing.score) {
        existing.score = match.score;
        existing.representativeId = match.id;
      }
    } else {
      docMap.set(docPrefix, { score: match.score, representativeId: match.id });
    }
  }

  // Sort by score desc
  const sorted = Array.from(docMap.entries()).sort((a, b) => b[1].score - a[1].score);
  const top = sorted.slice(0, MAX_DOCS);

  // Fetch metadata
  const repIds = top.map(([, d]) => d.representativeId);
  const vectors = await getByIds(indexName, repIds);
  const metaLookup = new Map();
  for (const v of vectors) {
    if (v.metadata) metaLookup.set(v.id, v.metadata);
  }

  return top.map(([docPrefix, doc]) => {
    const meta = metaLookup.get(doc.representativeId) ?? {};
    return {
      docPrefix,
      doc_id: meta.doc_id ?? "",
      title: meta.title ?? "",
      court: meta.court ?? "",
      court_level: meta.court_level ?? "",
      year: meta.year ?? "",
      jurisdiction: meta.jurisdiction ?? "",
      score: doc.score,
    };
  });
}

// ── Analysis ──────────────────────────────────────────

function analyzeResults(results) {
  if (!results.length) return { count: 0, avgScore: 0, maxScore: 0, minScore: 0 };

  const scores = results.map((r) => r.score);
  const courts = {};
  const courtLevels = {};
  let withTitle = 0;
  let withYear = 0;
  let withJurisdiction = 0;

  for (const r of results) {
    if (r.court) courts[r.court] = (courts[r.court] || 0) + 1;
    if (r.court_level) courtLevels[r.court_level] = (courtLevels[r.court_level] || 0) + 1;
    if (r.title) withTitle++;
    if (r.year) withYear++;
    if (r.jurisdiction) withJurisdiction++;
  }

  return {
    count: results.length,
    avgScore: scores.reduce((a, b) => a + b, 0) / scores.length,
    maxScore: Math.max(...scores),
    minScore: Math.min(...scores),
    courts,
    courtLevels,
    withTitle,
    withYear,
    withJurisdiction,
  };
}

function pad(str, len) {
  return String(str).padEnd(len);
}
function padL(str, len) {
  return String(str).padStart(len);
}

// ── Main ──────────────────────────────────────────────

async function main() {
  const client = new OpenAI({ apiKey: openaiKey });

  console.log(`\n${"═".repeat(90)}`);
  console.log(`  INDEX COMPARISON: ${OLD_INDEX} vs ${NEW_INDEX}`);
  console.log(`  ${QUERIES.length} queries, top-${MAX_DOCS} results each`);
  console.log(`${"═".repeat(90)}\n`);

  const summary = { oldBetter: 0, newBetter: 0, tie: 0 };

  for (const q of QUERIES) {
    const t0 = Date.now();
    console.log(`┌─ ${q.id}`);
    console.log(`│  "${q.query.slice(0, 80)}${q.query.length > 80 ? "..." : ""}"`);

    // Embed once
    const vector = await embed(client, q.query);

    // Query both indexes
    const [oldResults, newResults] = await Promise.all([
      searchIndex(OLD_INDEX, vector),
      searchIndex(NEW_INDEX, vector),
    ]);

    const oldA = analyzeResults(oldResults);
    const newA = analyzeResults(newResults);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // Overlap analysis
    const oldDocIds = new Set(oldResults.map((r) => r.doc_id));
    const newDocIds = new Set(newResults.map((r) => r.doc_id));
    const overlap = [...oldDocIds].filter((id) => newDocIds.has(id)).length;
    const overlapPct = oldDocIds.size > 0 ? ((overlap / Math.max(oldDocIds.size, newDocIds.size)) * 100).toFixed(0) : "0";

    // Print comparison
    console.log(`│`);
    console.log(`│  ${pad("", 25)} ${padL("OLD", 12)} ${padL("NEW", 12)}  ${padL("Δ", 8)}`);
    console.log(`│  ${pad("─".repeat(25), 25)} ${padL("─".repeat(12), 12)} ${padL("─".repeat(12), 12)}  ${padL("─".repeat(8), 8)}`);
    console.log(`│  ${pad("Results", 25)} ${padL(oldA.count, 12)} ${padL(newA.count, 12)}`);
    console.log(`│  ${pad("Avg score", 25)} ${padL(oldA.avgScore.toFixed(4), 12)} ${padL(newA.avgScore.toFixed(4), 12)}  ${padL((newA.avgScore - oldA.avgScore > 0 ? "+" : "") + (newA.avgScore - oldA.avgScore).toFixed(4), 8)}`);
    console.log(`│  ${pad("Max score", 25)} ${padL(oldA.maxScore.toFixed(4), 12)} ${padL(newA.maxScore.toFixed(4), 12)}  ${padL((newA.maxScore - oldA.maxScore > 0 ? "+" : "") + (newA.maxScore - oldA.maxScore).toFixed(4), 8)}`);
    console.log(`│  ${pad("Min score (in top-30)", 25)} ${padL(oldA.minScore.toFixed(4), 12)} ${padL(newA.minScore.toFixed(4), 12)}  ${padL((newA.minScore - oldA.minScore > 0 ? "+" : "") + (newA.minScore - oldA.minScore).toFixed(4), 8)}`);
    console.log(`│  ${pad("Overlap (doc_ids)", 25)} ${padL(`${overlap}/${Math.max(oldDocIds.size, newDocIds.size)} (${overlapPct}%)`, 25)}`);
    console.log(`│`);

    // Metadata completeness
    console.log(`│  ${pad("With title", 25)} ${padL(`${oldA.withTitle}/${oldA.count}`, 12)} ${padL(`${newA.withTitle}/${newA.count}`, 12)}`);
    console.log(`│  ${pad("With year", 25)} ${padL(`${oldA.withYear}/${oldA.count}`, 12)} ${padL(`${newA.withYear}/${newA.count}`, 12)}`);
    console.log(`│  ${pad("With jurisdiction", 25)} ${padL(`${oldA.withJurisdiction}/${oldA.count}`, 12)} ${padL(`${newA.withJurisdiction}/${newA.count}`, 12)}`);
    console.log(`│`);

    // Court level distribution
    const allLevels = new Set([...Object.keys(oldA.courtLevels || {}), ...Object.keys(newA.courtLevels || {})]);
    if (allLevels.size > 0) {
      console.log(`│  Court levels:`);
      for (const level of [...allLevels].sort()) {
        const o = oldA.courtLevels?.[level] || 0;
        const n = newA.courtLevels?.[level] || 0;
        console.log(`│    ${pad(level, 23)} ${padL(o, 12)} ${padL(n, 12)}`);
      }
      console.log(`│`);
    }

    // Known doc check
    if (q.knownDocId) {
      const oldRank = oldResults.findIndex((r) => r.doc_id === q.knownDocId);
      const newRank = newResults.findIndex((r) => r.doc_id === q.knownDocId);
      const oldStr = oldRank >= 0 ? `#${oldRank + 1} (${oldResults[oldRank].score.toFixed(4)})` : "NOT FOUND";
      const newStr = newRank >= 0 ? `#${newRank + 1} (${newResults[newRank].score.toFixed(4)})` : "NOT FOUND";
      console.log(`│  Known doc: ${q.knownDocId}`);
      console.log(`│    OLD: ${oldStr}  |  NEW: ${newStr}`);
      console.log(`│`);
    }

    // Verbose: top 5 from each
    if (VERBOSE) {
      console.log(`│  Top 5 OLD:`);
      for (let i = 0; i < Math.min(5, oldResults.length); i++) {
        const r = oldResults[i];
        console.log(`│    #${i + 1} ${r.score.toFixed(4)} ${r.court_level}/${r.court} ${r.year} ${r.doc_id.slice(0, 60)}`);
      }
      console.log(`│  Top 5 NEW:`);
      for (let i = 0; i < Math.min(5, newResults.length); i++) {
        const r = newResults[i];
        console.log(`│    #${i + 1} ${r.score.toFixed(4)} ${r.court_level}/${r.court} ${r.year} ${r.doc_id.slice(0, 60)}`);
      }
      console.log(`│`);
    }

    // Score winner
    const diff = newA.avgScore - oldA.avgScore;
    if (diff > 0.005) { summary.newBetter++; console.log(`│  → NEW wins (avg +${diff.toFixed(4)})`); }
    else if (diff < -0.005) { summary.oldBetter++; console.log(`│  → OLD wins (avg ${diff.toFixed(4)})`); }
    else { summary.tie++; console.log(`│  → TIE (Δ ${diff.toFixed(4)})`); }

    console.log(`│  ── ${elapsed}s`);
    console.log(`└─\n`);
  }

  // Final summary
  console.log(`${"═".repeat(90)}`);
  console.log(`  SUMMARY: NEW better: ${summary.newBetter}, OLD better: ${summary.oldBetter}, Tie: ${summary.tie}`);
  console.log(`${"═".repeat(90)}\n`);
}

main().catch(console.error);
