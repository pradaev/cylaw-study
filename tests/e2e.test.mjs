/**
 * End-to-End LLM Pipeline Test
 *
 * Tests the full pipeline: user query → LLM search decisions → Vectorize →
 * summarization → final answer. Captures behavioral profile and asserts
 * structural properties (not exact text).
 *
 * Requires: dev server running on localhost:3000 (npm run dev in frontend/)
 *
 * Usage:
 *   node tests/e2e.test.mjs
 *   node tests/e2e.test.mjs --verbose
 *   node tests/e2e.test.mjs --query 1      # run only query 1
 *
 * Each query costs ~$1-3 (LLM + summarizer). Run on demand, not on every commit.
 */

const VERBOSE = process.argv.includes("--verbose");
const QUERY_FILTER = process.argv.find((a) => a.startsWith("--query="))?.split("=")[1];
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

// ── Test Query Definitions ─────────────────────────────

const TEST_QUERIES = [
  {
    id: "1-one-third",
    query: "Πώς εφαρμόζουν τα δικαστήρια το τεκμήριο του ενός τρίτου σε υποθέσεις περιουσιακών διαφορών σε διαζύγια;",
    expected: {
      minSearches: 2,
      minSources: 20,
      minSummarized: 15,
      yearFilterApplied: false,
    },
  },
  {
    id: "2-foreign-law",
    query: "Η εφαρμογή του αλλοδαπού δικαίου σε υποθέσεις περιουσιακών διαφορών στο πλαίσιο διαδικασιών διαζυγίου κατά την τελευταία πενταετία",
    expected: {
      minSearches: 2,
      minSources: 15,
      minSummarized: 10,
      yearFilterApplied: false,  // LLM may or may not apply year filter from Greek text
    },
  },
  {
    id: "3-amending-pleadings",
    query: "Βρες τις κυρίες αποφάσεις του Ανώτατου Δικαστηρίου που αναλύουν τις βασικές αρχές για την τροποποίηση δικογράφου μετά την καταχώρηση. Δώσε προτεραιότητα σε αποφάσεις του Ανώτατου Δικαστηρίου και Εφετείου.",
    expected: {
      minSearches: 2,
      minSources: 20,
      minSummarized: 15,
      yearFilterApplied: false,
    },
  },
  {
    id: "4-delay-defence",
    query: "Βρες αποφάσεις που εξετάζουν πότε η καθυστέρηση στην κατάθεση αγωγής μπορεί να αποτελέσει άμυνα. Δώσε προτεραιότητα σε αποφάσεις του Ανώτατου Δικαστηρίου και του Εφετείου.",
    expected: {
      minSearches: 2,
      minSources: 20,
      minSummarized: 15,
      yearFilterApplied: false,
    },
  },
];

// ── SSE Parser ─────────────────────────────────────────

async function runQuery(query) {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: query }],
      model: "gpt-4o",
      sessionId: "e2e-test",
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
    searches: [],       // { query, step, yearFrom, yearTo, resultsCount, newUniqueCount }
    sources: [],        // SearchResult[]
    summarized: 0,      // number of docs summarized
    summaries: [],      // { docId, summary }
    answer: "",         // final answer text
    usage: null,        // { model, inputTokens, outputTokens, documentsAnalyzed }
    errors: [],
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
              case "summarizing": {
            const d = JSON.parse(data);
            profile.summarized += d.count;
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

// ── Assertion Helpers ──────────────────────────────────

function checkAssertions(tc, profile) {
  const results = [];
  const exp = tc.expected;

  // 1. Number of searches
  if (profile.searches.length >= exp.minSearches) {
    results.push({ pass: true, test: `${profile.searches.length} searches >= ${exp.minSearches}` });
  } else {
    results.push({ pass: false, test: `Only ${profile.searches.length} searches, expected >= ${exp.minSearches}` });
  }

  // 2. Number of sources
  if (profile.sources.length >= exp.minSources) {
    results.push({ pass: true, test: `${profile.sources.length} sources >= ${exp.minSources}` });
  } else {
    results.push({ pass: false, test: `Only ${profile.sources.length} sources, expected >= ${exp.minSources}` });
  }

  // 3. Number of documents summarized
  if (profile.summarized >= exp.minSummarized) {
    results.push({ pass: true, test: `${profile.summarized} summarized >= ${exp.minSummarized}` });
  } else {
    results.push({ pass: false, test: `Only ${profile.summarized} summarized, expected >= ${exp.minSummarized}` });
  }

  // 4. Year filter
  if (exp.yearFilterApplied) {
    const hasYearFilter = profile.searches.some(
      (s) => s.year_from || s.yearFrom,
    );
    if (hasYearFilter) {
      results.push({ pass: true, test: "Year filter applied" });
    } else {
      results.push({ pass: false, test: "Year filter NOT applied — expected year filter for time-reference query" });
    }

    // Check yearFrom value
    if (exp.yearFrom) {
      const yearFromValues = profile.searches
        .map((s) => s.year_from ?? s.yearFrom)
        .filter(Boolean);
      const minYearFrom = Math.min(...yearFromValues);
      if (minYearFrom >= exp.yearFrom) {
        results.push({ pass: true, test: `yearFrom=${minYearFrom} >= ${exp.yearFrom}` });
      } else {
        results.push({ pass: false, test: `yearFrom=${minYearFrom}, expected >= ${exp.yearFrom}` });
      }
    }
  } else {
    // No year filter expected — check that searches don't have restrictive year filters
    const hasRestrictiveYearFilter = profile.searches.some(
      (s) => (s.year_from ?? s.yearFrom ?? 0) > 2000,
    );
    if (!hasRestrictiveYearFilter) {
      results.push({ pass: true, test: "No restrictive year filter (correct)" });
    } else {
      results.push({ pass: false, test: "Unexpected year filter applied" });
    }
  }

  // 5. Answer not empty
  if (profile.answer.length > 100) {
    results.push({ pass: true, test: `Answer length: ${profile.answer.length} chars` });
  } else {
    results.push({ pass: false, test: `Answer too short: ${profile.answer.length} chars` });
  }

  // 6. No errors
  if (profile.errors.length === 0) {
    results.push({ pass: true, test: "No errors" });
  } else {
    results.push({ pass: false, test: `${profile.errors.length} errors: ${profile.errors.join(", ")}` });
  }

  // 7. Summaries received
  if (profile.summaries.length > 0) {
    results.push({ pass: true, test: `${profile.summaries.length} summaries received` });
  } else {
    results.push({ pass: false, test: "No summaries received" });
  }

  // 8. Search queries must be in Cypriot Greek
  const queries = profile.searches.map((s) => s.query ?? "");
  const hasGreek = queries.some((q) => /[\u0370-\u03FF]/.test(q));
  if (hasGreek) {
    results.push({ pass: true, test: "Αναζητήσεις στα κυπριακά ελληνικά" });
  } else {
    results.push({ pass: false, test: "Δεν βρέθηκαν αναζητήσεις στα ελληνικά" });
  }

  return results;
}

// ── Main ───────────────────────────────────────────────

async function main() {
  // Check if dev server is running
  try {
    await fetch(`${BASE_URL}/`);
  } catch {
    console.error(`\nDev server not running at ${BASE_URL}`);
    console.error("Start it with: cd frontend && npm run dev\n");
    process.exit(1);
  }

  const queries = QUERY_FILTER
    ? TEST_QUERIES.filter((q) => q.id.startsWith(QUERY_FILTER))
    : TEST_QUERIES;

  if (queries.length === 0) {
    console.error(`No queries match filter: ${QUERY_FILTER}`);
    process.exit(1);
  }

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;

  console.log(`\n${"━".repeat(80)}`);
  console.log(`  E2E PIPELINE TEST — ${queries.length} queries`);
  console.log(`${"━".repeat(80)}\n`);

  for (const tc of queries) {
    const t0 = Date.now();
    console.log(`┌─ ${tc.id}`);
    console.log(`│  "${tc.query.slice(0, 80)}..."`);

    try {
      const profile = await runQuery(tc.query);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

      if (VERBOSE) {
        console.log(`│`);
        console.log(`│  Searches: ${profile.searches.length}`);
        for (const s of profile.searches) {
          const q = (s.query ?? "").slice(0, 60);
          const yf = s.year_from ?? s.yearFrom ?? "";
          const yt = s.year_to ?? s.yearTo ?? "";
          const yr = yf ? ` [${yf}-${yt}]` : "";
          console.log(`│    Step ${s.step}: "${q}"${yr} → ${s.resultsCount ?? "?"} results`);
        }
        console.log(`│  Sources: ${profile.sources.length}`);
        console.log(`│  Summarized: ${profile.summarized}`);
        console.log(`│  Summaries received: ${profile.summaries.length}`);
        console.log(`│  Answer: ${profile.answer.length} chars`);

        // Court distribution from sources
        const courts = {};
        for (const s of profile.sources) {
          courts[s.court] = (courts[s.court] || 0) + 1;
        }
        console.log(`│  Courts: ${JSON.stringify(courts)}`);
        console.log(`│`);
      }

      const assertions = checkAssertions(tc, profile);
      const passed = assertions.filter((a) => a.pass).length;
      const failed = assertions.filter((a) => !a.pass).length;
      totalTests += assertions.length;
      totalPassed += passed;
      totalFailed += failed;

      for (const a of assertions) {
        const icon = a.pass ? "✓" : "✗";
        console.log(`│  ${icon} ${a.test}`);
      }

      console.log(`│  ── ${elapsed}s, ${passed}/${assertions.length} passed`);
    } catch (err) {
      console.log(`│  ✗ FATAL: ${err.message}`);
      totalTests++;
      totalFailed++;
    }

    console.log(`└─\n`);
  }

  // Summary
  console.log(`${"━".repeat(80)}`);
  const allPassed = totalFailed === 0;
  const icon = allPassed ? "✓" : "✗";
  console.log(`  ${icon} ${totalPassed}/${totalTests} assertions passed, ${totalFailed} failed`);
  console.log(`${"━".repeat(80)}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(console.error);
