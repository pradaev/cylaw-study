/**
 * Summarizer Eval Suite
 *
 * Tests the summarizer prompt against known cases with expected properties.
 * Not exact-match — checks structural/categorical properties that are stable
 * across LLM runs.
 *
 * Usage: node scripts/test_summarizer_eval.mjs
 * Add --verbose for full summary output
 */

import { createRequire } from "module";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../frontend/"));
const OpenAI = require("openai").default;

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");

// ── Test Case Definitions ──────────────────────────────

const TEST_CASES = [
  {
    id: "ER-v-PR_foreign-law",
    description: "E.R v. P.R — foreign law query on an interim freezing order case",
    docId: "apofaseised/oik/2024/2320240403.md",
    userQuery: "Application of the foreign law in property dispute cases in divorce proceedings in the last five years",
    focus: "application of foreign law in property disputes between spouses, conflict of laws rules, which law governs marital property",
    expected: {
      status: "interim",                     // must identify as interim
      engagementLevel: "DISCUSSED",          // court discussed but didn't rule
      engagementNotLevel: ["RULED"],         // must NOT be RULED
      relevanceRating: "MEDIUM",             // not HIGH (no ruling), not LOW (substantive discussion)
      relevanceNotRating: ["HIGH", "NONE"],  // must NOT be HIGH or NONE
      mustContain: ["ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ"],   // must identify interim status
      mustNotContain: [                      // must NOT fabricate these claims
        "the court applied Russian law",
        "the court ruled that Russian law",
        "the court decided that Russian law governs",
        "the court held that",
      ],
    },
  },
  {
    id: "ER-v-PR_one-third",
    description: "E.R v. P.R — one-third presumption query on an interim freezing order case",
    docId: "apofaseised/oik/2024/2320240403.md",
    userQuery: "How courts apply the presumption of one-third in property dispute cases in divorces?",
    focus: "presumption of one-third in property disputes, how courts determine spousal contribution percentage, application of Article 14 of Law 232/91",
    expected: {
      status: "interim",
      engagementLevel: ["MENTIONED", "NOT ADDRESSED", "DISCUSSED"], // court discussed Art.14 in jurisdiction context — any of these is acceptable
      engagementNotLevel: ["RULED"],           // must NOT be RULED (court didn't decide the 1/3 question)
      relevanceRating: ["LOW", "MEDIUM"],      // LOW or MEDIUM are both acceptable
      relevanceNotRating: ["HIGH"],
      mustContain: ["ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ"],
      mustNotContain: [
        "the court applied the presumption",
        "the court applied the one-third",
        "the court ruled on the contribution",
        "the court determined the percentage",
        "the court held that each spouse",
      ],
    },
  },
  {
    id: "ER-v-PR_freezing-orders",
    description: "E.R v. P.R — freezing orders query (should be HIGH, this is what the case is about)",
    docId: "apofaseised/oik/2024/2320240403.md",
    userQuery: "What are the prerequisites for issuing interim freezing orders (Mareva injunctions) in property disputes between spouses?",
    focus: "prerequisites for interim freezing orders under Article 32 of the Courts Law, Mareva injunctions in family property disputes",
    expected: {
      status: "interim",
      engagementLevel: ["RULED", "DISCUSSED"], // court analyzed all 3 prerequisites and issued the order — RULED or DISCUSSED both acceptable (interim = still a ruling, just not final)
      relevanceRating: ["HIGH", "MEDIUM"],     // HIGH or MEDIUM — the court DID rule on issuing the order
      relevanceNotRating: ["LOW", "NONE"],
      mustContain: ["ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ"],
      mustNotContain: [],
    },
  },
];

// ── Summarizer Prompt (mirrors llm-client.ts) ──────────

function buildPrompt(focus, userQuery, docId) {
  return `You are a legal analyst summarizing a Cypriot court decision for a lawyer's research.

The lawyer's research question: "${userQuery}"
Analysis focus: "${focus}"

Summarize this court decision in 400-700 words:

1. CASE HEADER: Parties, court, date, case number (2 lines max)
2. STATUS: Final decision (ΑΠΟΦΑΣΗ) or interim (ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ)?
3. FACTS: Brief background — what happened, who sued whom, what was claimed (3-4 sentences)
4. WHAT THE CASE IS ACTUALLY ABOUT: In 1-2 sentences, state the core legal issue the court decided (e.g., "interim freezing order", "property division", "child custody"). This may differ from the research question.
5. COURT'S FINDINGS on "${focus}":
   Pick ONE engagement level that best describes the court's treatment of the topic:
   - RULED: The court analyzed the topic and reached a conclusion or ruling.
   - DISCUSSED: The court substantively engaged with the topic — heard arguments from both sides, analyzed legal provisions, referenced case law or doctrine — but did NOT reach a final conclusion (e.g., reserved for trial, interim stage, left open). This includes cases where the court analyzed prerequisites or weighed evidence related to the topic.
   - MENTIONED: The topic was only briefly referenced by a party or the court in passing, without substantive analysis.
   - NOT ADDRESSED: The topic does not appear in the decision.
   State the level, then:
   - If RULED: Quote the court's conclusion in original Greek + English translation.
   - If DISCUSSED: Describe what the court analyzed. Quote the most relevant passage in Greek + English. Clearly state what was NOT decided.
   - If MENTIONED: Note the reference briefly. State the court did NOT engage with it.
   - If NOT ADDRESSED: Write "NOT ADDRESSED."
6. OUTCOME: What did the court order? (dismissed/succeeded/interim order/remanded)
7. RELEVANCE RATING: Rate as HIGH / MEDIUM / LOW / NONE and explain in one sentence:
   - HIGH: The court ruled on the research topic (level = RULED).
   - MEDIUM: The court substantively discussed or analyzed the topic without reaching a final conclusion (level = DISCUSSED). This is still valuable for legal research — the court's reasoning, the arguments considered, and the legal framework referenced are informative even without a final ruling.
   - LOW: The topic was only mentioned in passing without substantive analysis (level = MENTIONED).
   - NONE: The topic does not appear in the decision (level = NOT ADDRESSED).

CRITICAL RULES — VIOLATION IS UNACCEPTABLE:
- ONLY state what is EXPLICITLY written in the text.
- If the court says it has NOT decided an issue, you MUST report that the issue remains UNDECIDED.
- If this is an INTERIM decision, state this clearly — interim orders are NOT final rulings on the merits.
- NEVER assume or infer a court's conclusion.
- NEVER say the court "ruled" on a principle when it only "discussed" or "mentioned" it.
- Distinguish between what a PARTY ARGUED and what the COURT DECIDED.
- Pay special attention to the LAST section of the document (ΚΑΤΑΛΗΞΗ).
- Include at least one EXACT QUOTE from the decision (in Greek) with English translation.
- A wrong summary is worse than no summary. When in doubt, quote the original text.

Document ID: ${docId}`;
}

// ── Text Extraction (mirrors llm-client.ts) ────────────

function extractDecisionText(text, maxChars) {
  const decisionMarker = "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:";
  const markerIdx = text.indexOf(decisionMarker);
  let decisionText, title = "";
  const firstNewline = text.indexOf("\n");
  if (firstNewline > 0) title = text.slice(0, firstNewline).trim() + "\n\n";
  decisionText = markerIdx !== -1
    ? title + text.slice(markerIdx + decisionMarker.length).trim()
    : text;
  if (decisionText.length <= maxChars) return decisionText;
  const headSize = Math.floor(maxChars * 0.35);
  const tailSize = maxChars - headSize - 200;
  return decisionText.slice(0, headSize) +
    "\n\n[... middle section omitted ...]\n\n" +
    decisionText.slice(-tailSize);
}

// ── Assertion Helpers ──────────────────────────────────

function parseEngagement(summary) {
  // Look for engagement level markers
  for (const level of ["RULED", "DISCUSSED", "MENTIONED", "NOT ADDRESSED"]) {
    // Match patterns like "- DISCUSSED:", "DISCUSSED.", "(level = DISCUSSED)"
    const regex = new RegExp(`\\b${level}\\b`, "i");
    if (regex.test(summary)) return level;
  }
  return "UNKNOWN";
}

function parseRelevance(summary) {
  // Look for "RELEVANCE RATING: HIGH" or "HIGH." in relevance section
  const relevanceSection = summary.split(/RELEVANCE RATING/i)[1] || "";
  for (const level of ["HIGH", "MEDIUM", "LOW", "NONE"]) {
    if (new RegExp(`\\b${level}\\b`).test(relevanceSection)) return level;
  }
  return "UNKNOWN";
}

function checkAssertions(testCase, summary) {
  const results = [];
  const engagement = parseEngagement(summary);
  const relevance = parseRelevance(summary);
  const summaryLower = summary.toLowerCase();

  // Check engagement level
  const expectedEngagement = Array.isArray(testCase.expected.engagementLevel)
    ? testCase.expected.engagementLevel
    : [testCase.expected.engagementLevel];

  if (expectedEngagement.includes(engagement)) {
    results.push({ pass: true, test: `Engagement = ${engagement}` });
  } else {
    results.push({ pass: false, test: `Engagement: expected ${expectedEngagement.join("|")}, got ${engagement}` });
  }

  // Check engagement NOT level
  if (testCase.expected.engagementNotLevel) {
    for (const notLevel of testCase.expected.engagementNotLevel) {
      if (engagement === notLevel) {
        results.push({ pass: false, test: `Engagement must NOT be ${notLevel}, but it is` });
      } else {
        results.push({ pass: true, test: `Engagement is not ${notLevel}` });
      }
    }
  }

  // Check relevance rating
  const expectedRelevance = Array.isArray(testCase.expected.relevanceRating)
    ? testCase.expected.relevanceRating
    : [testCase.expected.relevanceRating];

  if (expectedRelevance.includes(relevance)) {
    results.push({ pass: true, test: `Relevance = ${relevance}` });
  } else {
    results.push({ pass: false, test: `Relevance: expected ${expectedRelevance.join("|")}, got ${relevance}` });
  }

  // Check relevance NOT rating
  if (testCase.expected.relevanceNotRating) {
    for (const notRating of testCase.expected.relevanceNotRating) {
      if (relevance === notRating) {
        results.push({ pass: false, test: `Relevance must NOT be ${notRating}, but it is` });
      } else {
        results.push({ pass: true, test: `Relevance is not ${notRating}` });
      }
    }
  }

  // Check interim status
  if (testCase.expected.status === "interim") {
    if (summaryLower.includes("interim") || summary.includes("ΕΝΔΙΑΜΕΣΗ")) {
      results.push({ pass: true, test: "Identified as interim" });
    } else {
      results.push({ pass: false, test: "Failed to identify as interim decision" });
    }
  }

  // Check mustContain
  for (const phrase of testCase.expected.mustContain || []) {
    if (summary.includes(phrase)) {
      results.push({ pass: true, test: `Contains "${phrase.slice(0, 40)}..."` });
    } else {
      results.push({ pass: false, test: `Missing required phrase: "${phrase.slice(0, 60)}"` });
    }
  }

  // Check mustNotContain (fabrication detection)
  for (const phrase of testCase.expected.mustNotContain || []) {
    if (summaryLower.includes(phrase.toLowerCase())) {
      results.push({ pass: false, test: `FABRICATION: contains "${phrase}"` });
    } else {
      results.push({ pass: true, test: `No fabrication: "${phrase.slice(0, 40)}..."` });
    }
  }

  return results;
}

// ── Main ───────────────────────────────────────────────

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Cache documents to avoid re-reading
  const docCache = new Map();

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalCost = 0;

  console.log(`\n${"━".repeat(80)}`);
  console.log(`  SUMMARIZER EVAL SUITE — ${TEST_CASES.length} test cases`);
  console.log(`${"━".repeat(80)}\n`);

  for (const tc of TEST_CASES) {
    console.log(`┌─ ${tc.id}`);
    console.log(`│  ${tc.description}`);
    console.log(`│  Query: "${tc.userQuery.slice(0, 70)}..."`);

    // Load document
    if (!docCache.has(tc.docId)) {
      const path = join(__dirname, "../data/cases_parsed", tc.docId);
      try {
        docCache.set(tc.docId, await readFile(path, "utf-8"));
      } catch {
        console.log(`│  ⊘ SKIP — document not found: ${tc.docId}`);
        console.log(`└─\n`);
        continue;
      }
    }

    const fullText = docCache.get(tc.docId);
    const extracted = extractDecisionText(fullText, 80000);

    // Call summarizer
    const t0 = Date.now();
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: buildPrompt(tc.focus, tc.userQuery, tc.docId) },
        { role: "user", content: extracted },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    const summary = response.choices[0]?.message?.content ?? "";
    const cost = ((response.usage?.prompt_tokens ?? 0) / 1e6) * 2.5 +
                 ((response.usage?.completion_tokens ?? 0) / 1e6) * 10;
    totalCost += cost;

    if (VERBOSE) {
      console.log(`│`);
      for (const line of summary.split("\n")) {
        console.log(`│  ${line}`);
      }
      console.log(`│`);
    }

    // Run assertions
    const results = checkAssertions(tc, summary);
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    totalTests += results.length;
    totalPassed += passed;
    totalFailed += failed;

    for (const r of results) {
      const icon = r.pass ? "✓" : "✗";
      console.log(`│  ${icon} ${r.test}`);
    }

    console.log(`│  ── ${elapsed}s, $${cost.toFixed(4)}, ${passed}/${results.length} passed`);
    console.log(`└─\n`);
  }

  // Summary
  console.log(`${"━".repeat(80)}`);
  const allPassed = totalFailed === 0;
  const icon = allPassed ? "✓" : "✗";
  console.log(`  ${icon} ${totalPassed}/${totalTests} assertions passed, ${totalFailed} failed`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`${"━".repeat(80)}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(console.error);
