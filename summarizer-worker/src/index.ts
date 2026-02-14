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

interface StructuredSummary {
  caseHeader: {
    parties: string;
    court: string;
    date: string;
    caseNumber: string;
  };
  status: string;
  facts: string;
  coreIssue: string;
  findings: {
    engagement: "RULED" | "DISCUSSED" | "MENTIONED" | "NOT_ADDRESSED";
    analysis: string;
    quote: string;
  };
  outcome: string;
  relevance: {
    rating: "HIGH" | "MEDIUM" | "LOW" | "NONE";
    reasoning: string;
  };
}

interface SummaryResult {
  docId: string;
  summary: StructuredSummary;
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

// ── JSON Schema for structured output ──────────────────

const SUMMARY_JSON_SCHEMA = {
  name: "case_summary",
  strict: true,
  schema: {
    type: "object",
    properties: {
      caseHeader: {
        type: "object",
        properties: {
          parties: { type: "string", description: "Plaintiff v Defendant (Greek)" },
          court: { type: "string", description: "Court name in Greek" },
          date: { type: "string", description: "Decision date" },
          caseNumber: { type: "string", description: "Case number" },
        },
        required: ["parties", "court", "date", "caseNumber"],
        additionalProperties: false,
      },
      status: { type: "string", description: "ΑΠΟΦΑΣΗ or ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ" },
      facts: { type: "string", description: "Brief background in 2-3 sentences (Greek)" },
      coreIssue: { type: "string", description: "Core legal issue in 1-2 sentences (Greek)" },
      findings: {
        type: "object",
        properties: {
          engagement: {
            type: "string",
            enum: ["RULED", "DISCUSSED", "MENTIONED", "NOT_ADDRESSED"],
          },
          analysis: { type: "string" },
          quote: { type: "string" },
        },
        required: ["engagement", "analysis", "quote"],
        additionalProperties: false,
      },
      outcome: { type: "string", description: "What the court ordered (Greek)" },
      relevance: {
        type: "object",
        properties: {
          rating: { type: "string", enum: ["HIGH", "MEDIUM", "LOW", "NONE"] },
          reasoning: { type: "string" },
        },
        required: ["rating", "reasoning"],
        additionalProperties: false,
      },
    },
    required: ["caseHeader", "status", "facts", "coreIssue", "findings", "outcome", "relevance"],
    additionalProperties: false,
  },
} as const;

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

/**
 * Post-process: enforce consistency rules.
 * - NOT_ADDRESSED + rating > LOW → downgrade to LOW
 * - MENTIONED + rating = HIGH → cap at MEDIUM
 */
function enforceRelevanceRules(summary: StructuredSummary): StructuredSummary {
  const { engagement } = summary.findings;
  const { rating } = summary.relevance;

  if (engagement === "NOT_ADDRESSED" && (rating === "HIGH" || rating === "MEDIUM")) {
    return { ...summary, relevance: { ...summary.relevance, rating: "LOW" } };
  }
  if (engagement === "MENTIONED" && rating === "HIGH") {
    return { ...summary, relevance: { ...summary.relevance, rating: "MEDIUM" } };
  }
  return summary;
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

/**
 * Strip noise from user query for summarizer focus.
 * Removes temporal constraints, court type mentions, action prefixes, quantity markers.
 * Falls back to original if result is too short.
 */
function distillSummarizerFocus(query: string): string {
  let text = query.trim();

  // 1. Temporal constraints
  const temporalPatterns = [
    /κατά τη[νη]?\s+τελευταί[αη]\s+(?:πενταετία|δεκαετία|τριετία|διετία)/gi,
    /τ(?:α|ης|ων)\s+τελευταί(?:α|ες|ων|ων)\s+\d+\s+(?:χρόνι[αω]|ετ[ηών]|μήν(?:ες|ών))/gi,
    /(?:μετά|από|πριν)\s+(?:το|τ[ηο]ν?)\s+(?:έτος\s+)?\d{4}/gi,
    /(?:μεταξύ|από)\s+\d{4}\s+(?:και|έως|μέχρι|ως)\s+\d{4}/gi,
    /πρόσφατ(?:ες|α|ων|η)\s*/gi,
    /τ(?:ης|ων)\s+τελευταί(?:ας|ων)\s+(?:πενταετίας|δεκαετίας|τριετίας|διετίας|περιόδου)/gi,
  ];
  for (const pat of temporalPatterns) {
    text = text.replace(pat, " ");
  }

  // 2. Court type mentions
  const courtPatterns = [
    /(?:στ[οα]|του|τ(?:ης|ων)|ενώπιον(?:\s+του)?|από\s+τ[οα])\s+(?:Ανώτατ[οα]|Ανωτάτου)\s+(?:Συνταγματικ[οό](?:ύ)?\s+)?Δικαστήρι[οα](?:ύ)?/gi,
    /(?:στ[οα]|του|τ(?:ης|ων)|ενώπιον(?:\s+του)?|από\s+τ[οα])\s+Εφετεί[οα](?:ύ)?/gi,
    /(?:σε|στ[αο]|τ(?:ων|α))\s+(?:πρωτ[οό]δικ[αο]|Επαρχιακ[αάό])\s+[Δδ]ικαστήρι[αο](?:ύ)?/gi,
    /(?:στ[οα]|του|τ(?:ης|ων))\s+[Δδ]ιοικητικ[οό](?:ύ)?\s+[Δδ]ικαστήρι[οα](?:ύ)?/gi,
    /(?:στ[οα]|του|τ(?:ης|ων))\s+Οικογενειακ[οό](?:ύ)?\s+[Δδ]ικαστήρι[οα](?:ύ)?/gi,
  ];
  for (const pat of courtPatterns) {
    text = text.replace(pat, " ");
  }

  // 3. Action/instruction prefixes
  const actionPatterns = [
    /^(?:Βρες|Αναζήτησε|Ψάξε|Δείξε|Εντόπισε)(?:\s+μου)?\s+(?:αποφάσεις|υποθέσεις|δικαστικές\s+αποφάσεις)?\s*(?:σχετικ[άέ]\s+(?:με|με\s+τ[οηα]ν?))?\s*/gi,
    /^(?:Θέλω|Χρειάζομαι)\s+(?:να\s+(?:βρω|δω|αναζητήσω))?\s*(?:αποφάσεις|υποθέσεις)?\s*(?:σχετικ[άέ]\s+(?:με|με\s+τ[οηα]ν?))?\s*/gi,
    /^(?:Ποιες|Ποια)\s+(?:αποφάσεις|υποθέσεις)\s+(?:αφορούν|σχετίζονται\s+με)\s*/gi,
  ];
  for (const pat of actionPatterns) {
    text = text.replace(pat, "");
  }

  // 4. Quantity markers
  const quantityPatterns = [
    /τ(?:ις|α|ους?)\s+\d+\s+(?:πιο|πλέον)\s+(?:σημαντικ[έά]ς?|σχετικ[έά]ς?)\s*/gi,
    /τ(?:α|ις)\s+(?:πρώτ[αες]|κύρι[αες])\s+\d+\s*/gi,
  ];
  for (const pat of quantityPatterns) {
    text = text.replace(pat, " ");
  }

  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/^[,;:\s]+|[,;:\s]+$/g, "").trim();

  if (text.length < 15) return query.trim();
  return text;
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

Return a structured JSON summary of this court decision. All text fields must be in Greek.

FIELD GUIDELINES:

- **caseHeader**: Extract parties, court, date, case number from the document header.
- **status**: "ΑΠΟΦΑΣΗ" for final decisions, "ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ" for interim.
- **facts**: Brief background in 2-3 sentences — who sued whom, what was claimed.
- **coreIssue**: The core legal issue the court actually decided (may differ from the research question).
- **findings.engagement**: How deeply the court addressed "${focus}":
  - RULED: Court analyzed the topic and reached a conclusion.
  - DISCUSSED: Court substantively engaged but didn't conclude.
  - MENTIONED: Topic briefly referenced without analysis.
  - NOT_ADDRESSED: Topic does not appear in the decision.
- **findings.analysis**: If RULED/DISCUSSED — describe what the court analyzed. If MENTIONED — brief note. If NOT_ADDRESSED — empty string.
- **findings.quote**: Exact quote from the decision (Greek). Empty string if NOT_ADDRESSED.
- **outcome**: What the court ordered.
- **relevance.rating**: Research value for the lawyer:
  - HIGH: Lawyer MUST read this — court analyzed the exact issue or nearly identical facts.
  - MEDIUM: Lawyer would benefit — shares key legal elements, similar dispute type, cross-border elements.
  - LOW: Tangentially related — same broad area but different context.
  - NONE: No connection — completely different area of law.
- **relevance.reasoning**: 1-2 sentences explaining the rating.

MANDATORY OVERRIDES:
- Foreign-law research + foreign parties/cross-border assets → at least MEDIUM.
- Purely domestic case (no foreign element) → at most LOW.
- Completely different area of law → NONE.

CRITICAL RULES:
- ONLY state what is EXPLICITLY written in the text.
- NEVER assume or infer conclusions.
- Distinguish party arguments from court decisions.
- A wrong summary is worse than no summary.`;

  const response = await client.chat.completions.create({
    model: SUMMARIZER_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: extractDecisionText(fullText, 80000) },
    ],
    temperature: 0,
    max_tokens: SUMMARIZER_MAX_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: SUMMARY_JSON_SCHEMA,
    },
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  let summary: StructuredSummary;
  try {
    summary = JSON.parse(raw) as StructuredSummary;
  } catch {
    summary = {
      caseHeader: { parties: "", court: "", date: "", caseNumber: "" },
      status: "",
      facts: "",
      coreIssue: "",
      findings: { engagement: "NOT_ADDRESSED", analysis: "", quote: "" },
      outcome: "",
      relevance: { rating: "NONE", reasoning: "Failed to parse summary" },
    };
  }

  // Enforce consistency: NOT_ADDRESSED → max LOW
  summary = enforceRelevanceRules(summary);

  return {
    docId,
    summary,
    relevance: summary.relevance.rating,
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

      // Distill focus for summarizer (strip temporal/court noise)
      const distilledFocus = distillSummarizerFocus(focus);

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
              return summarizeDocument(client, docId, fullText, distilledFocus, userQuery);
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
