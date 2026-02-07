/**
 * Test v3: updated RULED/DISCUSSED/MENTIONED/NOT ADDRESSED levels
 */
import { createRequire } from "module";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../frontend/"));
const OpenAI = require("openai").default;

const DOC_ID = "apofaseised/oik/2024/2320240403.md";
const USER_QUERY = "Application of the foreign law in property dispute cases in divorce proceedings in the last five years";
const FOCUS = "application of foreign law in property disputes between spouses, conflict of laws rules, which law governs marital property";

function extractDecisionText(text, maxChars) {
  const decisionMarker = "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:";
  const markerIdx = text.indexOf(decisionMarker);
  let decisionText, title = "";
  const firstNewline = text.indexOf("\n");
  if (firstNewline > 0) title = text.slice(0, firstNewline).trim() + "\n\n";
  decisionText = markerIdx !== -1 ? title + text.slice(markerIdx + decisionMarker.length).trim() : text;
  if (decisionText.length <= maxChars) return decisionText;
  const headSize = Math.floor(maxChars * 0.35);
  const tailSize = maxChars - headSize - 200;
  return decisionText.slice(0, headSize) + "\n\n[... middle section omitted ...]\n\n" + decisionText.slice(-tailSize);
}

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const fullText = await readFile(join(__dirname, "../data/cases_parsed", DOC_ID), "utf-8");
  const extracted = extractDecisionText(fullText, 80000);

  // ── New prompt with RULED/DISCUSSED/MENTIONED/NOT ADDRESSED ──
  const systemPrompt = `You are a legal analyst summarizing a Cypriot court decision for a lawyer's research.

The lawyer's research question: "${USER_QUERY}"
Analysis focus: "${FOCUS}"

Summarize this court decision in 400-700 words:

1. CASE HEADER: Parties, court, date, case number (2 lines max)
2. STATUS: Final decision (ΑΠΟΦΑΣΗ) or interim (ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ)?
3. FACTS: Brief background — what happened, who sued whom, what was claimed (3-4 sentences)
4. WHAT THE CASE IS ACTUALLY ABOUT: In 1-2 sentences, state the core legal issue the court decided (e.g., "interim freezing order", "property division", "child custody"). This may differ from the research question.
5. COURT'S FINDINGS on "${FOCUS}":
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

Document ID: ${DOC_ID}`;

  console.log(`Query: ${USER_QUERY}\n`);
  console.log("=".repeat(80));

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: extracted },
    ],
    temperature: 0.1,
    max_tokens: 2000,
  });

  console.log(response.choices[0]?.message?.content);
  console.log(`\nTokens: in=${response.usage?.prompt_tokens} out=${response.usage?.completion_tokens}`);
}

main().catch(console.error);
