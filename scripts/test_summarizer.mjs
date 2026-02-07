/**
 * Test script: simulate the summarizer agent on a specific document
 * with the UPDATED prompt to verify improvement.
 * Run from project root: node scripts/test_summarizer.mjs
 */

import { createRequire } from "module";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../frontend/"));
const OpenAI = require("openai").default;

const SUMMARIZER_MODEL = "gpt-4o";
const SUMMARIZER_MAX_TOKENS = 2000;
const DOC_ID = "apofaseised/oik/2024/2320240403.md";
const USER_QUERY = "How courts apply the presumption of one-third in property dispute cases in divorces?";
const FOCUS = "presumption of one-third in property disputes, how courts determine spousal contribution percentage, application of Article 14 of Law 232/91";

function extractDecisionText(text, maxChars) {
  const decisionMarker = "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:";
  const markerIdx = text.indexOf(decisionMarker);

  let decisionText;
  let title = "";

  const firstNewline = text.indexOf("\n");
  if (firstNewline > 0) {
    title = text.slice(0, firstNewline).trim() + "\n\n";
  }

  if (markerIdx !== -1) {
    decisionText = title + text.slice(markerIdx + decisionMarker.length).trim();
  } else {
    decisionText = text;
  }

  if (decisionText.length <= maxChars) return decisionText;

  const headSize = Math.floor(maxChars * 0.35);
  const tailSize = maxChars - headSize - 200;

  return decisionText.slice(0, headSize) +
    "\n\n[... middle section omitted — see full document for complete text ...]\n\n" +
    decisionText.slice(-tailSize);
}

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const docPath = join(__dirname, "../data/cases_parsed", DOC_ID);
  const fullText = await readFile(docPath, "utf-8");
  
  console.log(`\nDocument: ${DOC_ID}`);
  console.log(`Full text length: ${fullText.length} chars`);
  
  const extracted = extractDecisionText(fullText, 80000);
  console.log(`Extracted decision text: ${extracted.length} chars`);
  console.log(`User query: ${USER_QUERY}`);
  console.log(`Focus: ${FOCUS}`);

  // ── NEW prompt (updated) ──
  const systemPrompt = `You are a legal analyst summarizing a Cypriot court decision for a lawyer's research.

The lawyer's research question: "${USER_QUERY}"
Analysis focus: "${FOCUS}"

Summarize this court decision in 400-700 words:

1. CASE HEADER: Parties, court, date, case number (2 lines max)
2. STATUS: Final decision (ΑΠΟΦΑΣΗ) or interim (ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ)?
3. FACTS: Brief background — what happened, who sued whom, what was claimed (3-4 sentences)
4. WHAT THE CASE IS ACTUALLY ABOUT: In 1-2 sentences, state the core legal issue the court decided (e.g., "interim freezing order", "property division", "child custody"). This may differ from the research question.
5. COURT'S FINDINGS on "${FOCUS}":
   Carefully distinguish between these three levels:
   (a) APPLIED: The court actually analyzed and applied this legal principle to reach its decision.
   (b) MENTIONED: The court or parties referenced this principle, but the court did not rule on it.
   (c) NOT ADDRESSED: The principle does not appear in the decision at all.
   State which level applies, then:
   - If APPLIED: Quote the key passage in original Greek + English translation.
   - If MENTIONED: Quote the reference, but clearly state the court did NOT rule on this point.
   - If NOT ADDRESSED: Write "NOT ADDRESSED: The court did not discuss ${FOCUS} in this decision."
6. OUTCOME: What did the court order? (dismissed/succeeded/interim order/remanded)
7. RELEVANCE RATING: Rate as HIGH / MEDIUM / LOW / NONE and explain in one sentence:
   - HIGH: The court directly analyzed and ruled on the research topic.
   - MEDIUM: The court discussed the topic but did not reach a conclusion (e.g., interim stage, obiter dicta).
   - LOW: The topic was only mentioned by a party or in passing — the court did not engage with it.
   - NONE: The case is about a completely different legal issue.

CRITICAL RULES — VIOLATION IS UNACCEPTABLE:
- ONLY state what is EXPLICITLY written in the text. If something is not stated, say "not addressed" or "not decided".
- If the court says it has NOT decided an issue (e.g. "δεν κατέληξε", "δεν αποφασίστηκε"), you MUST report that the issue remains UNDECIDED. Do NOT present it as decided.
- If this is an INTERIM decision (ενδιάμεση απόφαση, προσωρινό διάταγμα), state this clearly — interim orders are NOT final rulings on the merits.
- NEVER assume or infer a court's conclusion. If the text says "the court could not conclude which law applies", your summary MUST say "the court did not reach a conclusion on applicable law".
- NEVER say the court "applied" a principle when it only "mentioned" or "referenced" it. A party arguing something is NOT the court ruling on it.
- Distinguish between what a PARTY ARGUED and what the COURT DECIDED. Parties' arguments are not court findings.
- Pay special attention to the LAST section of the document (after "[... middle section omitted ...]" if present, or the section starting with ΚΑΤΑΛΗΞΗ) — this contains the actual ruling.
- Include at least one EXACT QUOTE from the decision (in Greek) with English translation.
- A wrong summary is worse than no summary. When in doubt, quote the original text.

Document ID: ${DOC_ID}`;

  console.log(`\n${"=".repeat(80)}`);
  console.log("UPDATED SUMMARIZER OUTPUT:");
  console.log("=".repeat(80) + "\n");

  const response = await client.chat.completions.create({
    model: SUMMARIZER_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: extracted },
    ],
    temperature: 0.1,
    max_tokens: SUMMARIZER_MAX_TOKENS,
  });

  const summary = response.choices[0]?.message?.content ?? "[No summary]";
  console.log(summary);
  
  console.log(`\n${"=".repeat(80)}`);
  console.log("TOKEN USAGE:");
  console.log("=".repeat(80));
  console.log(`Input tokens: ${response.usage?.prompt_tokens}`);
  console.log(`Output tokens: ${response.usage?.completion_tokens}`);
  console.log(`Total tokens: ${response.usage?.total_tokens}`);
  
  const cost = ((response.usage?.prompt_tokens ?? 0) / 1_000_000) * 2.5 + 
               ((response.usage?.completion_tokens ?? 0) / 1_000_000) * 10;
  console.log(`Estimated cost: $${cost.toFixed(4)}`);
}

main().catch(console.error);
