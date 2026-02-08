/**
 * Search Regression Test Suite
 *
 * Verifies that the Vectorize search pipeline returns expected results.
 * Run after ANY changes to retriever, vectorize-client, or search-related code.
 *
 * Tests:
 *   1. Known document retrieval — specific queries must find specific cases
 *   2. Year filtering — yearFrom/yearTo must narrow results correctly
 *   3. Result quality — scores, deduplication, metadata completeness
 *
 * Usage:
 *   node scripts/test_search_regression.mjs
 *   node scripts/test_search_regression.mjs --verbose
 *
 * Requires: OPENAI_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN in env
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
const VECTORIZE_TOP_K = 100;
const MAX_DOCUMENTS = 30;

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;

if (!accountId || !apiToken || !openaiKey) {
  console.error("Missing env vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, OPENAI_API_KEY");
  process.exit(1);
}

const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/cyprus-law-cases-search`;
const cfHeaders = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };

// ── Helpers ────────────────────────────────────────────

async function embedQuery(client, query) {
  const resp = await client.embeddings.create({ model: EMBEDDING_MODEL, input: query });
  return resp.data[0].embedding;
}

async function vectorizeQuery(vector, topK = VECTORIZE_TOP_K) {
  const res = await fetch(`${baseUrl}/query`, {
    method: "POST",
    headers: cfHeaders,
    body: JSON.stringify({ vector, topK, returnMetadata: "none", returnValues: false }),
  });
  const json = await res.json();
  if (!json.success) throw new Error("Vectorize query failed");
  return json.result;
}

async function getByIds(ids) {
  const BATCH = 20;
  const all = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const res = await fetch(`${baseUrl}/get_by_ids`, {
      method: "POST",
      headers: cfHeaders,
      body: JSON.stringify({ ids: batch }),
    });
    const json = await res.json();
    if (!json.success) throw new Error("Vectorize getByIds failed");
    all.push(...json.result);
  }
  return all;
}

function extractDocPrefix(vectorId) {
  const sep = vectorId.lastIndexOf("::");
  return sep !== -1 ? vectorId.slice(0, sep) : vectorId;
}

/**
 * Full search pipeline — mirrors retriever.ts logic
 */
async function search(client, query, yearFrom, yearTo) {
  const vector = await embedQuery(client, query);
  const results = await vectorizeQuery(vector);

  if (!results.matches || results.matches.length === 0) return [];

  // Group by doc prefix
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

  // Sort by score
  const sorted = Array.from(docMap.entries()).sort((a, b) => b[1].score - a[1].score);

  // Fetch metadata
  const repIds = sorted.map(([, d]) => d.representativeId);
  const vectors = await getByIds(repIds);
  const metaLookup = new Map();
  for (const v of vectors) {
    if (v.metadata) metaLookup.set(v.id, v.metadata);
  }

  // Year filtering
  let filtered = sorted;
  if (yearFrom || yearTo) {
    filtered = sorted.filter(([, doc]) => {
      const meta = metaLookup.get(doc.representativeId);
      if (!meta?.year) return true;
      const year = parseInt(meta.year, 10);
      if (isNaN(year)) return true;
      if (yearFrom && year < yearFrom) return false;
      if (yearTo && year > yearTo) return false;
      return true;
    });
  }

  // Take top MAX_DOCUMENTS
  const top = filtered.slice(0, MAX_DOCUMENTS);

  return top.map(([, doc]) => {
    const meta = metaLookup.get(doc.representativeId) ?? {};
    return {
      doc_id: meta.doc_id ?? "",
      title: meta.title ?? "",
      court: meta.court ?? "",
      year: meta.year ?? "",
      score: doc.score,
    };
  });
}

// ── Test Case Definitions ──────────────────────────────

const TEST_CASES = [
  // ── Known document retrieval ──
  {
    id: "freezing-orders-direct",
    description: "Direct Greek query for freezing orders must find E.R v. P.R case",
    query: "Ρωσικό δίκαιο περιουσιακή διαφορά συζύγων Λεμεσός παγοποιητικό διάταγμα",
    expectedDocId: "apofaseised/oik/2024/2320240403.md",
    mustFind: true,
    maxRank: 30,  // must be within top 30
  },
  {
    id: "freezing-orders-broad",
    description: "Broad Greek query for interim freezing orders should return family court cases",
    query: "ενδιάμεσα παγοποιητικά διατάγματα περιουσιακές διαφορές συζύγων οικογενειακό δικαστήριο",
    assertions: [
      { type: "min_results", count: 10 },
      { type: "no_duplicate_doc_ids" },
      { type: "all_scores_positive" },
    ],
  },

  // ── Year filtering ──
  {
    id: "year-filter-last-5",
    description: "Year filter 2021-2026 should exclude pre-2021 cases",
    query: "εφαρμογή αλλοδαπού δικαίου σε περιουσιακές διαφορές μεταξύ συζύγων",
    yearFrom: 2021,
    yearTo: 2026,
    assertions: [
      { type: "all_years_in_range", yearFrom: 2021, yearTo: 2026 },
      { type: "min_results", count: 1 },
    ],
  },
  {
    id: "year-filter-recent",
    description: "Year filter 2024-2026 — only very recent cases",
    query: "ακίνητη περιουσία διαζύγιο κατανομή",
    yearFrom: 2024,
    yearTo: 2026,
    assertions: [
      { type: "all_years_in_range", yearFrom: 2024, yearTo: 2026 },
    ],
  },

  // ── Result quality ──
  {
    id: "result-quality-dedup",
    description: "Results must be deduplicated — no duplicate doc_ids",
    query: "αστική ευθύνη ιατρική αμέλεια αποζημίωση",
    assertions: [
      { type: "no_duplicate_doc_ids" },
      { type: "min_results", count: 5 },
      { type: "max_results", count: MAX_DOCUMENTS },
      { type: "all_scores_positive" },
      { type: "all_have_metadata" },
    ],
  },
  {
    id: "result-quality-english",
    description: "English query should also return results (JSC collection)",
    query: "breach of contract damages compensation",
    assertions: [
      { type: "min_results", count: 1 },
      { type: "all_scores_positive" },
    ],
  },
];

// ── Test Runner ────────────────────────────────────────

async function runTest(client, tc) {
  const results = await search(client, tc.query, tc.yearFrom, tc.yearTo);
  const assertions = [];

  // Check mustFind
  if (tc.expectedDocId) {
    const rank = results.findIndex((r) => r.doc_id === tc.expectedDocId);
    if (tc.mustFind) {
      if (rank === -1) {
        assertions.push({ pass: false, test: `Expected doc NOT found: ${tc.expectedDocId}` });
      } else if (tc.maxRank && rank + 1 > tc.maxRank) {
        assertions.push({ pass: false, test: `Doc found at rank ${rank + 1}, expected within top ${tc.maxRank}` });
      } else {
        assertions.push({ pass: true, test: `Doc found at rank ${rank + 1} (score=${results[rank].score.toFixed(4)})` });
      }
    }
  }

  // Check other assertions
  for (const a of tc.assertions ?? []) {
    switch (a.type) {
      case "all_years_in_range": {
        const outOfRange = results.filter((r) => {
          const y = parseInt(r.year, 10);
          return !isNaN(y) && (y < a.yearFrom || y > a.yearTo);
        });
        if (outOfRange.length > 0) {
          const years = outOfRange.map((r) => r.year).join(", ");
          assertions.push({ pass: false, test: `${outOfRange.length} results outside ${a.yearFrom}-${a.yearTo}: [${years}]` });
        } else {
          assertions.push({ pass: true, test: `All ${results.length} results within ${a.yearFrom}-${a.yearTo}` });
        }
        break;
      }
      case "no_duplicate_doc_ids": {
        const ids = results.map((r) => r.doc_id);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dupes.length > 0) {
          assertions.push({ pass: false, test: `${dupes.length} duplicate doc_ids: ${dupes.slice(0, 3).join(", ")}` });
        } else {
          assertions.push({ pass: true, test: "No duplicate doc_ids" });
        }
        break;
      }
      case "min_results": {
        if (results.length < a.count) {
          assertions.push({ pass: false, test: `Only ${results.length} results, expected >= ${a.count}` });
        } else {
          assertions.push({ pass: true, test: `${results.length} results >= ${a.count}` });
        }
        break;
      }
      case "max_results": {
        if (results.length > a.count) {
          assertions.push({ pass: false, test: `${results.length} results, expected <= ${a.count}` });
        } else {
          assertions.push({ pass: true, test: `${results.length} results <= ${a.count}` });
        }
        break;
      }
      case "all_scores_positive": {
        const bad = results.filter((r) => r.score <= 0);
        if (bad.length > 0) {
          assertions.push({ pass: false, test: `${bad.length} results with score <= 0` });
        } else {
          assertions.push({ pass: true, test: "All scores > 0" });
        }
        break;
      }
      case "all_have_metadata": {
        const missing = results.filter((r) => !r.doc_id || !r.court || !r.year);
        if (missing.length > 0) {
          assertions.push({ pass: false, test: `${missing.length} results missing metadata (doc_id/court/year)` });
        } else {
          assertions.push({ pass: true, test: "All results have doc_id, court, year" });
        }
        break;
      }
    }
  }

  return { results, assertions };
}

// ── Main ───────────────────────────────────────────────

async function main() {
  const client = new OpenAI({ apiKey: openaiKey });

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalCost = 0;

  console.log(`\n${"━".repeat(80)}`);
  console.log(`  SEARCH REGRESSION SUITE — ${TEST_CASES.length} test cases`);
  console.log(`${"━".repeat(80)}\n`);

  for (const tc of TEST_CASES) {
    const t0 = Date.now();
    console.log(`┌─ ${tc.id}`);
    console.log(`│  ${tc.description}`);
    console.log(`│  Query: "${tc.query.slice(0, 70)}..."`);
    if (tc.yearFrom || tc.yearTo) {
      console.log(`│  Year filter: ${tc.yearFrom ?? "any"} - ${tc.yearTo ?? "any"}`);
    }

    const { results, assertions } = await runTest(client, tc);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // Estimate cost (1 embedding call per test)
    const cost = 0.00002; // ~$0.02/1M tokens, 1 query ≈ 10 tokens
    totalCost += cost;

    if (VERBOSE) {
      console.log(`│`);
      for (let i = 0; i < Math.min(results.length, 5); i++) {
        const r = results[i];
        console.log(`│  #${i + 1} score=${r.score.toFixed(4)} year=${r.year} court=${r.court} ${r.doc_id}`);
      }
      if (results.length > 5) console.log(`│  ... +${results.length - 5} more`);
      console.log(`│`);
    }

    const passed = assertions.filter((a) => a.pass).length;
    const failed = assertions.filter((a) => !a.pass).length;
    totalTests += assertions.length;
    totalPassed += passed;
    totalFailed += failed;

    for (const a of assertions) {
      const icon = a.pass ? "✓" : "✗";
      console.log(`│  ${icon} ${a.test}`);
    }

    console.log(`│  ── ${elapsed}s, ${results.length} results, ${passed}/${assertions.length} passed`);
    console.log(`└─\n`);
  }

  // Summary
  console.log(`${"━".repeat(80)}`);
  const allPassed = totalFailed === 0;
  const icon = allPassed ? "✓" : "✗";
  console.log(`  ${icon} ${totalPassed}/${totalTests} assertions passed, ${totalFailed} failed`);
  console.log(`  Estimated cost: $${totalCost.toFixed(4)}`);
  console.log(`${"━".repeat(80)}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(console.error);
