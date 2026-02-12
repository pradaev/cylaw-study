/**
 * Summarizer Worker — handles document summarization via OpenAI.
 *
 * Called by the main Worker via Service Binding.
 * Each call = new request = fresh 6-connection pool.
 *
 * POST /
 * Body: { docIds: string[], userQuery: string, focus: string, openaiApiKey: string }
 * Returns: { results: SummaryResult[] }
 */

import OpenAI from "openai";

interface Env {
  DOCS_BUCKET: R2Bucket;
}

interface SummaryResult {
  docId: string;
  summary: string;
  relevance: string;
  courtLevel: string;
  court: string;
  year: number;
  inputTokens: number;
  outputTokens: number;
}

interface RequestBody {
  docIds: string[];
  userQuery: string;
  focus: string;
  openaiApiKey: string;
}

// ── Constants ──────────────────────────────────────────

const SUMMARIZER_MODEL = "gpt-4o";
const SUMMARIZER_MAX_TOKENS = 1500;

// ── Helpers ────────────────────────────────────────────

/** Legal analysis marker (ΝΟΜΙΚΗ ΠΤΥΧΗ). Used when present for summarizer input. */
const LEGAL_ANALYSIS_MARKER = "ΝΟΜΙΚΗ ΠΤΥΧΗ";
const DECISION_MARKER = "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:";

/**
 * Extract text for summarization. Prefer ΝΟΜΙΚΗ ΠΤΥΧΗ (legal analysis) when present;
 * else use text after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ. Truncation: head+tail of the extracted section.
 */
function extractDecisionText(text: string, maxChars: number): string {
  const firstNewline = text.indexOf("\n");
  const title = firstNewline > 0 ? text.slice(0, firstNewline).trim() + "\n\n" : "";

  const legalIdx = text.indexOf(LEGAL_ANALYSIS_MARKER);
  const decisionIdx = text.indexOf(DECISION_MARKER);

  let bodyText: string;
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

  return decisionText.slice(0, headSize) +
    "\n\n[... middle section omitted — see full document for complete text ...]\n\n" +
    decisionText.slice(-tailSize);
}

function parseRelevance(summary: string): string {
  const section = summary.split(/RELEVANCE RATING/i)[1] ?? "";
  for (const level of ["HIGH", "MEDIUM", "LOW", "NONE"]) {
    if (new RegExp(`\\b${level}\\b`).test(section)) return level;
  }
  return "NONE";
}

function getCourtLevel(court: string): string {
  const map: Record<string, string> = {
    aad: "supreme", supreme: "supreme", supremeAdministrative: "supreme",
    jsc: "supreme", rscc: "supreme", clr: "supreme",
    areiospagos: "foreign",
    courtOfAppeal: "appeal", administrativeCourtOfAppeal: "appeal",
    apofaseised: "first_instance", juvenileCourt: "first_instance",
    administrative: "administrative", administrativeIP: "administrative",
    epa: "other", aap: "other",
  };
  return map[court] ?? "other";
}

function extractYearFromDocId(docId: string): number {
  const match = docId.match(/\/(\d{4})\//);
  return match ? parseInt(match[1], 10) : 0;
}

// ── Summarize a single document ────────────────────────

async function summarizeDocument(
  client: OpenAI,
  docId: string,
  fullText: string,
  focus: string,
  userQuery: string,
): Promise<SummaryResult> {
  const court = docId.split("/")[0] === "apofaseis"
    ? docId.split("/")[1] ?? "unknown"
    : docId.split("/")[0] ?? "unknown";

  const systemPrompt = `You are a legal analyst summarizing a Cypriot court decision for a lawyer's research.

The lawyer's research question: "${userQuery}"
Analysis focus: "${focus}"

Summarize this court decision in 400-700 words:

1. CASE HEADER: Parties, court, date, case number (2 lines max)
2. STATUS: Final decision (ΑΠΟΦΑΣΗ) or interim (ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ)?
3. FACTS: Brief background — what happened, who sued whom, what was claimed (3-4 sentences)
4. WHAT THE CASE IS ACTUALLY ABOUT: In 1-2 sentences, state the core legal issue the court decided. This may differ from the research question.
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
7. RELEVANCE RATING — rate based on RESEARCH VALUE to the lawyer, NOT on engagement level above:
   The engagement level (section 5) describes HOW the court addressed the topic.
   The relevance rating describes WHETHER THIS CASE IS USEFUL for the lawyer's research — these are DIFFERENT things.
   A case can be NOT ADDRESSED on the exact topic but still MEDIUM/HIGH relevance if the facts, parties, or legal context overlap significantly.

   Rate as HIGH / MEDIUM / LOW / NONE:
   - HIGH: A lawyer researching this topic MUST read this case. The court analyzed the specific legal issue, or the case involves nearly identical facts/parties/legal questions.
   - MEDIUM: A lawyer would BENEFIT from reading this case. It shares key factual or legal elements: same type of dispute, similar parties (e.g., foreign nationals), overlapping legal area, or cross-border elements — even if the court's main focus was different.
   - LOW: Tangentially related. Same broad area of law but different context.
   - NONE: No connection to the research question whatsoever — completely different area of law, different type of dispute, no overlapping facts.

   MANDATORY OVERRIDES (apply BEFORE deciding your rating):
   - If the research question involves FOREIGN LAW and this case has foreign parties, cross-border assets, or references to non-Cypriot legal systems → rate at least MEDIUM, even if the court did not explicitly analyze foreign law as a topic.
   - A purely domestic case (Cypriot parties, Cypriot assets, no foreign element) is LOW even if it involves the same area of law.
   - Only rate NONE if the case is about a COMPLETELY DIFFERENT area of law (e.g., immigration, criminal, labor when the question is about family property).

CRITICAL RULES:
- ONLY state what is EXPLICITLY written in the text.
- NEVER assume or infer a court's conclusion.
- Distinguish between what a PARTY ARGUED and what the COURT DECIDED.
- Include at least one EXACT QUOTE from the decision (in Greek).
- A wrong summary is worse than no summary.

Document ID: ${docId}`;

  const response = await client.chat.completions.create({
    model: SUMMARIZER_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: extractDecisionText(fullText, 80000) },
    ],
    temperature: 0.1,
    max_tokens: SUMMARIZER_MAX_TOKENS,
  });

  const summary = response.choices[0]?.message?.content ?? "[Summary unavailable]";

  return {
    docId,
    summary,
    relevance: parseRelevance(summary),
    courtLevel: getCourtLevel(court),
    court,
    year: extractYearFromDocId(docId),
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

// ── Worker entry point ─────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.json() as RequestBody;
      const { docIds, userQuery, focus, openaiApiKey } = body;

      if (!docIds?.length || !userQuery || !openaiApiKey) {
        return Response.json({ error: "Missing required fields" }, { status: 400 });
      }

      const client = new OpenAI({ apiKey: openaiApiKey });
      const results: SummaryResult[] = [];

      // Process all docs in this batch with concurrency=5
      // Each Service Binding call gets its own 6-connection pool
      const CONCURRENCY = 5;
      for (let i = 0; i < docIds.length; i += CONCURRENCY) {
        const batch = docIds.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (docId) => {
            try {
              const object = await env.DOCS_BUCKET.get(docId);
              if (!object) {
                console.error(JSON.stringify({ event: "summarizer_error", docId, error: "Document not found in R2" }));
                return null;
              }
              const fullText = await object.text();
              return summarizeDocument(client, docId, fullText, focus, userQuery);
            } catch (docErr) {
              const msg = docErr instanceof Error ? docErr.message : String(docErr);
              console.error(JSON.stringify({ event: "summarizer_error", docId, error: msg }));
              return null;
            }
          }),
        );
        for (const result of batchResults) {
          if (result) results.push(result);
        }
      }

      console.log(JSON.stringify({
        event: "summarizer_batch_complete",
        docsRequested: docIds.length,
        docsProcessed: results.length,
      }));

      return Response.json({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ event: "summarizer_fatal_error", error: message }));
      return Response.json({ error: message }, { status: 500 });
    }
  },
};
