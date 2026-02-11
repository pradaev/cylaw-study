#!/usr/bin/env node
/**
 * Summarizer Focus Comparison — tests whether legal_context in focus helps or hurts.
 *
 * Hypothesis: When focus = userQuery + legal_context, the summarizer may
 * - give too much weight to mention of specific regulations (false HIGH on C-docs)
 * - underweight docs that ARE relevant but don't cite the expected regulations (false NONE on B-docs)
 *
 * Compares relevance ratings: focus=userQuery only vs focus=userQuery+legalContext
 *
 * Usage: node scripts/summarizer_focus_comparison.mjs [--quick]
 *   --quick: test only 3 docs (A1, B3, C1) to save cost
 *
 * Requires: OPENAI_API_KEY, data/cases_parsed/ with ground-truth docs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
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

const require = createRequire(join(__dirname, "../frontend/"));
const OpenAI = require("openai").default;

const DATA_DIR = join(ROOT, "data", "cases_parsed");
const QUICK = process.argv.includes("--quick");

const USER_QUERY =
  "Η εφαρμογή του αλλοδαπού δικαίου σε υποθέσεις περιουσιακών διαφορών στο πλαίσιο διαδικασιών διαζυγίου κατά την τελευταία πενταετία";

// Typical legal_context from LLM for this query (accumulated across 3 searches)
const LEGAL_CONTEXT =
  "Κανονισμός 2016/1103 – περιουσιακές σχέσεις συζύγων. Βασικές αποφάσεις: Απόφαση C-386/12, Απόφαση C-218/16.";

const FOCUS_WITH_CONTEXT = `${USER_QUERY}\n\nΝομικό πλαίσιο: ${LEGAL_CONTEXT}`;

const TEST_DOCS = QUICK
  ? [
      { id: "A1", path: "apofaseised/oik/2024/2320240403.md", expected: "HIGH|MEDIUM", desc: "E.R v P.R — Russian citizens, Mareva, foreign law" },
      { id: "B3", path: "apofaseised/oik/2025/4320250176.md", expected: "MEDIUM|LOW", desc: "Α.Λ v Ι.Τ — property + divorce + foreign law" },
      { id: "C1", path: "apofaseised/oik/2021/2320210501.md", expected: "LOW|NONE", desc: "Domestic property, no foreign law" },
    ]
  : [
      { id: "A1", path: "apofaseised/oik/2024/2320240403.md", expected: "HIGH|MEDIUM", desc: "E.R v P.R — Russian, Mareva, foreign law" },
      { id: "A3", path: "apofaseised/oik/2022/2320220243.md", expected: "HIGH", desc: "M. v A. — EU Reg 2016/1103, key doc" },
      { id: "B3", path: "apofaseised/oik/2025/4320250176.md", expected: "MEDIUM|LOW", desc: "Α.Λ v Ι.Τ — property + divorce" },
      { id: "C1", path: "apofaseised/oik/2021/2320210501.md", expected: "LOW|NONE", desc: "Domestic property" },
      { id: "C2", path: "apofaseised/oik/2023/2320230482.md", expected: "LOW|NONE", desc: "Domestic property" },
    ];

const LEGAL_ANALYSIS_MARKER = "ΝΟΜΙΚΗ ΠΤΥΧΗ";
const DECISION_MARKER = "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:";

function extractDecisionText(text, maxChars = 80000) {
  const firstNewline = text.indexOf("\n");
  const title = firstNewline > 0 ? text.slice(0, firstNewline).trim() + "\n\n" : "";
  const legalIdx = text.indexOf(LEGAL_ANALYSIS_MARKER);
  const decisionIdx = text.indexOf(DECISION_MARKER);
  let bodyText;
  if (legalIdx !== -1) {
    bodyText = text.slice(legalIdx + LEGAL_ANALYSIS_MARKER.length).trim();
  } else if (decisionIdx !== -1) {
    bodyText = text.slice(decisionIdx + DECISION_MARKER.length).trim();
  } else {
    bodyText = text;
  }
  const decisionText = title + bodyText;
  if (decisionText.length <= maxChars) return decisionText;
  const headSize = Math.floor(maxChars * 0.35);
  const tailSize = maxChars - headSize - 200;
  return (
    decisionText.slice(0, headSize) +
    "\n\n[... middle omitted ...]\n\n" +
    decisionText.slice(-tailSize)
  );
}

function parseRelevance(summary) {
  const section = (summary.split(/RELEVANCE RATING/i)[1] ?? "").toLowerCase();
  for (const level of ["high", "medium", "low", "none"]) {
    if (new RegExp(`\\b${level}\\b`).test(section)) return level.toUpperCase();
  }
  return "UNKNOWN";
}

// Summarizer prompt — mirrors summarizer-worker/src/index.ts exactly
function buildSystemPrompt(userQuery, focus, docId) {
  return `You are a legal analyst summarizing a Cypriot court decision for a lawyer's research.

The lawyer's research question: "${userQuery}"
Analysis focus: "${focus}"

Summarize this court decision in 400-700 words:

1. CASE HEADER: Parties, court, date, case number (2 lines max)
2. STATUS: Final decision (ΑΠΟΦΑΣΗ) or interim (ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ)?
3. FACTS: Brief background — what happened, who sued whom, what was claimed (3-4 sentences)
4. WHAT THE CASE IS ACTUALLY ABOUT: In 1-2 sentences, state the core legal issue the court decided.
5. COURT'S FINDINGS on "${focus}":
   Pick ONE engagement level:
   - RULED: The court analyzed the topic and reached a conclusion or ruling.
   - DISCUSSED: The court substantively engaged with the topic but did NOT reach a conclusion.
   - MENTIONED: The topic was only briefly referenced without substantive analysis.
   - NOT ADDRESSED: The topic does not appear in the decision.
   State the level, then:
   - If RULED: Quote the court's conclusion in Greek.
   - If DISCUSSED: Describe what the court analyzed. Quote the most relevant passage in Greek.
   - If MENTIONED: Note the reference briefly.
   - If NOT ADDRESSED: Write "NOT ADDRESSED."
6. OUTCOME: What did the court order?
7. RELEVANCE RATING: Rate as HIGH / MEDIUM / LOW / NONE and explain in one sentence.

CRITICAL RULES:
- ONLY state what is EXPLICITLY written in the text.
- NEVER assume or infer a court's conclusion.
- Distinguish between what a PARTY ARGUED and what the COURT DECIDED.
- Include at least one EXACT QUOTE from the decision (in Greek).
- A wrong summary is worse than no summary.

Document ID: ${docId}`;
}

async function summarize(client, docId, fullText, focusVariant) {
  const focus = focusVariant === "query_only" ? USER_QUERY : FOCUS_WITH_CONTEXT;
  const systemPrompt = buildSystemPrompt(USER_QUERY, focus, docId);
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: extractDecisionText(fullText) },
    ],
    temperature: 0.1,
    max_tokens: 1500,
  });
  const summary = response.choices[0]?.message?.content ?? "";
  const relevance = parseRelevance(summary);
  const cost =
    ((response.usage?.prompt_tokens ?? 0) / 1e6) * 2.5 +
    ((response.usage?.completion_tokens ?? 0) / 1e6) * 10;
  return { summary, relevance, cost };
}

function isExpected(expected, actual) {
  const opts = expected.split("|");
  return opts.some((o) => o === actual);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY required");
    process.exit(1);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const docCache = new Map();

  console.log("\n" + "═".repeat(90));
  console.log("  SUMMARIZER FOCUS COMPARISON");
  console.log("  Query: Application of foreign law in property disputes (divorce context)");
  console.log("  Variant A: focus = userQuery only");
  console.log("  Variant B: focus = userQuery + Νομικό πλαίσιο (legal context)");
  console.log("═".repeat(90) + "\n");

  const results = [];
  let totalCost = 0;

  for (const td of TEST_DOCS) {
    const path = join(DATA_DIR, td.path);
    let text;
    try {
      text = await readFile(path, "utf-8");
    } catch (e) {
      console.log(`⊘ SKIP ${td.id} — file not found: ${td.path}\n`);
      continue;
    }

    console.log(`┌─ ${td.id} ${td.desc}`);
    console.log(`│  Expected relevance: ${td.expected}`);

    // Variant A: query only
    const a = await summarize(client, td.path, text, "query_only");
    totalCost += a.cost;
    console.log(`│  A (query only):     ${a.relevance}  $${a.cost.toFixed(4)}`);

    // Variant B: query + legal context
    const b = await summarize(client, td.path, text, "with_context");
    totalCost += b.cost;
    console.log(`│  B (+legal context): ${b.relevance}  $${b.cost.toFixed(4)}`);

    const aOk = isExpected(td.expected, a.relevance);
    const bOk = isExpected(td.expected, b.relevance);

    let verdict = "";
    if (aOk && !bOk) verdict = "⚠️ B WORSE — legal context hurt (false rating)";
    else if (!aOk && bOk) verdict = "✓ B BETTER — legal context helped";
    else if (aOk && bOk) verdict = "＝ both OK";
    else verdict = "⚠️ both off — check expected";

    console.log(`│  Verdict: ${verdict}`);
    console.log(`└─\n`);

    results.push({
      id: td.id,
      expected: td.expected,
      queryOnly: a.relevance,
      withContext: b.relevance,
      verdict,
    });
  }

  // Summary
  const better = results.filter((r) => r.verdict.includes("BETTER")).length;
  const worse = results.filter((r) => r.verdict.includes("WORSE")).length;
  const bothOk = results.filter((r) => r.verdict.includes("both OK")).length;

  console.log("═".repeat(90));
  console.log(`  RESULTS: ${bothOk} both OK, ${better} B better, ${worse} B worse`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  console.log("═".repeat(90) + "\n");

  if (worse > better) {
    console.log("  → Legal context appears to HURT summarizer relevance. Consider using focus=userQuery only.");
  } else if (better > worse) {
    console.log("  → Legal context appears to HELP. Keep current behavior.");
  } else {
    console.log("  → No clear winner. Either variant is acceptable.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
