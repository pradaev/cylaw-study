/**
 * Test script: simulate the summarizer agent on a specific document
 * to verify accuracy of summaries.
 *
 * Usage: npx tsx scripts/test_summarizer.ts
 */

import OpenAI from "openai";
import { readFile } from "fs/promises";
import { join } from "path";

const SUMMARIZER_MODEL = "gpt-4o";
const SUMMARIZER_MAX_TOKENS = 2000;
const DOC_ID = "apofaseised/oik/2024/2320240403.md";
const USER_QUERY = "How courts apply the presumption of one-third in property dispute cases in divorces?";
const FOCUS = "presumption of one-third in property disputes, how courts determine spousal contribution percentage, application of Article 14 of Law 232/91";

function extractDecisionText(text: string, maxChars: number): string {
  const decisionMarker = "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:";
  const markerIdx = text.indexOf(decisionMarker);

  let decisionText: string;
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

  // Read the document
  const docPath = join(process.cwd(), "data/cases_parsed", DOC_ID);
  const fullText = await readFile(docPath, "utf-8");
  
  console.log(`\n📄 Document: ${DOC_ID}`);
  console.log(`📏 Full text length: ${fullText.length} chars`);
  
  const extracted = extractDecisionText(fullText, 80000);
  console.log(`📏 Extracted decision text: ${extracted.length} chars`);
  console.log(`🔍 User query: ${USER_QUERY}`);
  console.log(`🎯 Focus: ${FOCUS}`);
  console.log(`\n${"=".repeat(80)}`);
  console.log("SUMMARIZER OUTPUT:");
  console.log("=".repeat(80) + "\n");

  const systemPrompt = `You are a legal analyst summarizing a Cypriot court decision for a lawyer's research.

The lawyer's research question: "${USER_QUERY}"
Analysis focus: "${FOCUS}"

Summarize this court decision in 400-700 words:

1. CASE HEADER: Parties, court, date, case number (2 lines max)
2. STATUS: Final decision (ΑΠΟΦΑΣΗ) or interim (ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ)?
3. FACTS: Brief background — what happened, who sued whom, what was claimed (3-4 sentences)
4. COURT'S FINDINGS on "${FOCUS}":
   - What did the court say about this topic? Quote the key passage in original Greek.
   - Translate the quote to English.
   - If the court discussed this topic indirectly (e.g. in obiter dicta or as part of a broader ruling), still include it.
   - If the court did not address this topic, write: "The court did not directly address ${FOCUS} in this decision."
5. OUTCOME: What did the court order? (dismissed/succeeded/interim order/remanded)
6. RELEVANCE: One sentence explaining why this case is relevant to the research question.

CRITICAL RULES — VIOLATION IS UNACCEPTABLE:
- ONLY state what is EXPLICITLY written in the text. If something is not stated, say "not addressed" or "not decided".
- If the court says it has NOT decided an issue (e.g. "δεν κατέληξε", "δεν αποφασίστηκε"), you MUST report that the issue remains UNDECIDED. Do NOT present it as decided.
- If this is an INTERIM decision (ενδιάμεση απόφαση, προσωρινό διάταγμα), state this clearly — interim orders are NOT final rulings.
- NEVER assume or infer a court's conclusion. If the text says "the court could not conclude which law applies", your summary MUST say "the court did not reach a conclusion on applicable law".
- Pay special attention to the LAST section of the document (after "[... middle section omitted ...]" if present, or the section starting with ΚΑΤΑΛΗΞΗ) — this contains the actual ruling.
- Include at least one EXACT QUOTE from the decision (in Greek) with English translation.
- A wrong summary is worse than no summary. When in doubt, quote the original text.

Document ID: ${DOC_ID}`;

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
