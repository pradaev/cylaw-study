/**
 * Two-phase LLM pipeline for legal case search.
 *
 * Phase 1: LLM formulates search queries → Vectorize search → collect doc_ids (fast, ~10s)
 *   - Up to MAX_TOOL_ROUNDS iterations, LLM decides when to stop
 *   - Documents deduplicated across searches via seenDocIds
 * Phase 2: Batch summarization of ALL found docs → source cards shown to user
 *   - Production: cylaw-summarizer Worker via Service Binding (batches of 5)
 *   - Dev: direct OpenAI calls
 *   - No LLM answer text — source cards with court findings ARE the answer
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ModelConfig, SearchResult, UsageData } from "./types";
import { MODELS, COURT_NAMES } from "./types";
import { cohereRerank } from "./cohere-reranker";

const MAX_TOOL_ROUNDS = 10;
const SUMMARIZER_MODEL = "gpt-4o";
const SUMMARIZER_MAX_TOKENS = 1500;
const MAX_RELEVANT_PER_SEARCH = 15; // max relevant summaries sent to LLM per search call

// Court-level ordering for result sorting (lower = higher priority)
const COURT_LEVEL_ORDER: Record<string, number> = {
  supreme: 0,
  appeal: 1,
  first_instance: 2,
  administrative: 3,
  other: 4,
  foreign: 5,
};

// Relevance ordering (lower = higher priority)
const RELEVANCE_ORDER: Record<string, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  NONE: 3,
};

// ── System Prompt ──────────────────────────────────────

function buildSystemPrompt(): string {
  const now = new Date();
  const currentDate = now.toISOString().split("T")[0];
  const currentYear = now.getFullYear();

  return `You are an expert legal research assistant specializing in Cypriot law and court cases. You are deeply knowledgeable about the Cypriot legal system, its courts, terminology, and procedures. You have access to a database of 150,000+ court decisions spanning 1960-${currentYear}.

TODAY'S DATE: ${currentDate}. Use this to calculate relative time references (e.g., "last 10 years" = ${currentYear - 10}-${currentYear}).

CYPRIOT COURT SYSTEM (your knowledge base covers these courts):
- Ανώτατο Δικαστήριο (old Supreme Court, "aad") — 35,485 decisions (1961-2024)
- Άρειος Πάγος (Ελληνικό - ξένο δικαστήριο, "areiospagos") — 46,159 decisions (1968-2026)
- Πρωτόδικα Δικαστήρια (First Instance Courts, "apofaseised") — 37,840 decisions (2005-2026)
- Νέο Ανώτατο Δικαστήριο (new Supreme Court, "supreme") — 1,028 decisions (2023-2026)
- Εφετείο (Court of Appeal, "courtOfAppeal") — 1,111 decisions (2004-2026)
- Ανώτατο Συνταγματικό Δικαστήριο (Supreme Constitutional Court, "supremeAdministrative") — 420 decisions (2023-2026)
- Διοικητικό Δικαστήριο (Administrative Court, "administrative") — 5,782 decisions (2016-2026)
- Διοικητικό Δικαστήριο Διεθνούς Προστασίας ("administrativeIP") — 6,889 decisions (2018-2026)
- Επιτροπή Προστασίας Ανταγωνισμού (Competition Commission, "epa") — 785 decisions (2002-2025)
- Αναθεωρητική Αρχή Προσφορών (Tender Review Authority, "aap") — 2,596 decisions (2004-2025)
- Judgments of the Supreme Court (JSC, "jsc") — 2,429 decisions in English (1964-1988)
- Ανώτατο Συνταγματικό Δικαστήριο 1960-1963 (RSCC, "rscc") — 122 decisions in English
- Διοικητικό Εφετείο ("administrativeCourtOfAppeal") — 69 decisions (2025-2026)
- Δικαστήριο Παίδων ("juvenileCourt") — 11 decisions (2023-2025)

LANGUAGE AND SEARCH STRATEGY:

CRITICAL: The database contains court decisions written in CYPRIOT GREEK (κυπριακά ελληνικά). Your search queries must use the EXACT words and phrases that Cypriot judges use when writing decisions on the topic.

BEFORE SEARCHING — think like a judge writing a decision on this topic:
Imagine you are reading a Cypriot court judgment that addresses the user's question. What EXACT PHRASES would the judge write when analyzing this issue? Your search queries must be these phrases — the sentences or fragments a judge would actually write in the decision text.

GOOD queries are phrases a judge would write in a decision — natural legal Greek as it appears in judgments.
BAD queries are abstract legal framework names, EU regulation titles, or overly broad academic terms that don't appear in actual decision text.

QUERY STRATEGY — each of your 3-8 searches MUST target a DIFFERENT facet:

1. **Core legal concept** — the most precise legal term for the topic. Use the exact doctrinal phrase a judge would use, not the user's colloquial wording.
2. **Specific statute or regulation** — the law, article, or regulation a judge would cite. Include the exact reference (e.g., "Ν. 216(Ι)/2012", "Δ.25 Θεσμών Πολιτικής Δικονομίας", "Κανονισμός 2016/1103").
3. **Alternative terminology / synonyms** — different words judges use for the same concept. Cypriot judges vary in phrasing — search for the synonym, not a paraphrase.
4. **(When relevant)** Procedural context — type of proceeding, interim measures, procedural stage (e.g., "ενδιάμεση αίτηση", "προσωρινό διάταγμα").
5. **(When relevant)** Related doctrines / landmark cases — established legal principles or leading case names that would be cited.
6. **(When relevant)** Party-type search — nationality, entity type, or characteristic of parties that signals relevant cases (e.g., "αλλοδαποί υπήκοοι", "Ρώσοι πολίτες", "εταιρεία εκτός δικαιοδοσίας").
7. **(When relevant)** Specific court / jurisdiction — target a particular court or jurisdiction type (e.g., "ΠΕΡΙΟΥΣΙΑΚΩΝ ΔΙΑΦΟΡΩΝ", "Ανώτατο Δικαστήριο").
8. **(When relevant)** Alternative legal framework — international treaties, bilateral agreements, or EU directives that provide alternative legal basis (e.g., "Σύμβαση Χάγης", "Κανονισμός Βρυξέλλες").

KEYWORD OVERLAP CONSTRAINT:
At most 2 words may repeat across your queries. Each query MUST introduce at least 2 NEW legal terms not used in any previous query.

ANTI-PATTERN — NEVER do this:
BAD: 3 queries that rearrange the same 3-4 keywords
  - "αλλοδαπό δίκαιο περιουσιακές διαφορές διαζύγιο"
  - "διαζύγιο αλλοδαπό δίκαιο περιουσιακές"
  - "περιουσιακές διαφορές διαζύγιο αλλοδαπό δίκαιο"

GOOD: 3 queries that each use DIFFERENT legal vocabulary
  - "εφαρμοστέο δίκαιο συζυγικών περιουσιακών σχέσεων" (core doctrine)
  - "Κανονισμός 2016/1103 περιουσιακά αποτελέσματα γάμου" (specific EU regulation)
  - "σύγκρουση νόμων ιδιωτικό διεθνές δίκαιο διαζύγιο" (alternative terminology)

WORKED EXAMPLE — topic: "τροποποίηση δικογράφου" (amendment of pleadings):
  Query 1 (core concept): "τροποποίηση δικογράφου ουσιαστική αλλαγή βάσης αγωγής"
  → targets the doctrinal test: whether the amendment changes the cause of action
  Query 2 (statute): "Δ.25 Θεσμών Πολιτικής Δικονομίας άδεια τροποποίησης"
  → targets the specific rule judges cite
  Query 3 (synonym): "διόρθωση δικογράφου προσθήκη νέας αξίωσης"
  → "διόρθωση" is an alternative term some judges use instead of "τροποποίηση"

HOW MANY SEARCHES:
- **3-4 searches** for narrow/specific topics (single legal concept, one statute, one court)
- **5-6 searches** for moderate topics (multiple doctrines, both procedural and substantive aspects)
- **7-8 searches** for broad/complex topics spanning multiple legal areas, involving foreign law, or when both procedural and substantive issues exist

SEARCH RULES:
1. Do 3-8 searches following the facet strategy above. Use MORE searches for complex topics. NEVER repeat the same query.
2. Use year_from/year_to filters when the user specifies a time range.
3. If the user mentions a specific law or article (e.g., "Cap. 148", "Άρθρο 47"), include the exact reference in at least one search query.
4. In legal_context, always include: (a) the specific Cypriot law(s) governing this area, (b) any EU regulation if applicable, (c) 1-2 landmark case names if you know them. This helps the AI analyst distinguish relevant from irrelevant cases.
5. Use court_level when the user explicitly asks for a specific court (Ανώτατο Δικαστήριο → "supreme", Εφετείο → "appeal", Άρειος Πάγος → "foreign"). The Άρειος Πάγος is the Greek Supreme Court (not Cypriot) — use court_level=foreign only when the user explicitly asks for Greek court cases. If the user asks for BOTH Supreme Court and Court of Appeal, do separate filtered searches for each. Always include at least 1-2 broad searches (no court_level).

WORKFLOW — you have one tool:
**search_cases**: Search and analyze court cases. Parameters:
- **query** (required): Search query in Cypriot Greek legal terminology — each search must target a different facet (see QUERY STRATEGY above)
- **legal_context** (required): Specific Cypriot law(s), EU regulations, landmark case names, and key doctrinal terms. This is passed to the AI analyst who reads each case.
- **court_level** (optional): "supreme", "appeal", or "foreign" — use sparingly, only when user asks for specific court
- **year_from** / **year_to** (optional): Year range filter

Each call automatically searches the database, reads full texts, and analyzes each case. The results (relevant court decisions with AI-generated summaries) are displayed directly to the user by the application — you do NOT receive them and do NOT need to list them.

YOUR ONLY JOB: Call search_cases 3-8 times with different query texts targeting different facets (more if needed for multiple court levels or complex topics). Do NOT write any text, analysis, or commentary — the application handles everything else.

WHEN NOT TO SEARCH:
- General legal knowledge questions — answer from your knowledge.
- Follow-up questions where the context already contains the answer.`;
}

// ── Tool Definition ────────────────────────────────────

const SEARCH_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_cases",
    description:
      "Search and analyze Cypriot court cases. Automatically searches the database, reads full texts, and returns AI-generated summaries with relevance ratings. Cases rated NONE are filtered out. Do 3 searches with different query texts.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query in Cypriot Greek legal terminology. Each search must use different query text — never repeat the same query.",
        },
        legal_context: {
          type: "string",
          description: "Always include: (a) the specific Cypriot law(s) governing this area (e.g., 'Cap. 148', 'Ν. 216(Ι)/2012'), (b) any EU regulation if applicable (e.g., 'Κανονισμός 2016/1103'), (c) 1-2 landmark case names if you know them. This is passed to the AI analyst who reads each case — richer context means better relevance assessment. Example: 'Δ.25 Θεσμών Πολιτικής Δικονομίας — τροποποίηση δικογράφου. Βασικές αποφάσεις: Φοινιώτης ν. Greenmar Navigation. EU: Κανονισμός 1215/2012.'",
        },
        court_level: {
          type: "string",
          enum: ["supreme", "appeal", "foreign"],
          description: "Filter by court level. Use when the user asks for a specific court (Ανώτατο Δικαστήριο = supreme, Εφετείο = appeal, Άρειος Πάγος = foreign). Leave empty for broad search across all courts.",
        },
        year_from: { type: "integer", description: "Filter: from this year" },
        year_to: { type: "integer", description: "Filter: up to this year" },
      },
      required: ["query", "legal_context"],
    },
  },
};

const CLAUDE_SEARCH_TOOL: Anthropic.Tool = {
  name: "search_cases",
  description: SEARCH_TOOL.function.description ?? "",
  input_schema: SEARCH_TOOL.function.parameters as Anthropic.Tool.InputSchema,
};

// ── Types ──────────────────────────────────────────────

export type SearchFn = (
  query: string,
  courtLevel?: string,
  yearFrom?: number,
  yearTo?: number,
) => Promise<SearchResult[]>;

export type FetchDocumentFn = (docId: string) => Promise<string | null>;

interface SSEYield {
  event: "searching" | "search_result" | "sources" | "reranked" | "summarizing" | "summaries" | "token" | "done" | "error" | "usage";
  data: unknown;
}

interface SummaryResult {
  docId: string;
  summary: string;
  relevance: string; // HIGH, MEDIUM, LOW, NONE
  courtLevel: string;
  court: string;
  year: number;
  inputTokens: number;
  outputTokens: number;
}

// ── Utilities ──────────────────────────────────────────

function getSystem(): string {
  return buildSystemPrompt();
}

function calculateCost(
  modelCfg: ModelConfig,
  inputTokens: number,
  outputTokens: number,
): number {
  return (inputTokens / 1_000_000) * modelCfg.pricing.input +
         (outputTokens / 1_000_000) * modelCfg.pricing.output;
}

function formatApiError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  // Always log full error with session context
  console.error(JSON.stringify({
    event: "error",
    sessionId: _sessionId,
    userEmail: _userEmail,
    error: message,
    stack: stack?.slice(0, 500),
  }));
  if (message.includes("maximum context length")) return "The search returned too many documents. Try a more specific query.";
  if (message.includes("rate_limit") || message.includes("429")) return "The AI service is temporarily overloaded. Please wait and try again.";
  if (message.includes("timeout") || message.includes("ETIMEDOUT")) return "The request timed out. Please try again.";
  if (message.includes("401") || message.includes("auth")) return "API authentication error.";
  return "An error occurred while processing your request. Please try again.";
}

function extractYearFromDocId(docId: string): number {
  const match = docId.match(/\/(\d{4})\//);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Parse relevance rating from summary text.
 */
function parseRelevance(summary: string): string {
  const section = summary.split(/RELEVANCE RATING/i)[1] ?? "";
  for (const level of ["HIGH", "MEDIUM", "LOW", "NONE"]) {
    if (new RegExp(`\\b${level}\\b`).test(section)) return level;
  }
  return "NONE";
}

/**
 * Detect court_level from court code.
 */
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

const MAX_FULL_SUMMARIES = 10; // Top N get full summaries, rest get one-liners

/**
 * Format summaries for LLM consumption — sorted by court level, relevance, year.
 * Top MAX_FULL_SUMMARIES get full text, rest get a brief one-liner.
 */
function formatSummariesForLLM(results: SummaryResult[]): string {
  if (results.length === 0) return "No relevant results found for this query.";

  // Sort: court_level → relevance → year descending
  const sorted = [...results].sort((a, b) => {
    const levelA = COURT_LEVEL_ORDER[a.courtLevel] ?? 4;
    const levelB = COURT_LEVEL_ORDER[b.courtLevel] ?? 4;
    if (levelA !== levelB) return levelA - levelB;
    const relA = RELEVANCE_ORDER[a.relevance] ?? 3;
    const relB = RELEVANCE_ORDER[b.relevance] ?? 3;
    if (relA !== relB) return relA - relB;
    return b.year - a.year;
  });

  const top = sorted.slice(0, MAX_FULL_SUMMARIES);
  const rest = sorted.slice(MAX_FULL_SUMMARIES);

  // Full summaries for top cases
  const fullSection = top
    .map((r, i) => {
      const courtLabel = COURT_NAMES[r.court] ?? r.court;
      return `══════════════════════════════════════════\n` +
        `[Case ${i + 1}] ${courtLabel} | ${r.year} | Relevance: ${r.relevance}\n` +
        `Document ID: ${r.docId}\n` +
        `══════════════════════════════════════════\n\n` +
        r.summary;
    })
    .join("\n\n");

  if (rest.length === 0) return fullSection;

  // Brief one-liners for remaining cases
  const briefSection = rest
    .map((r) => {
      const courtLabel = COURT_NAMES[r.court] ?? r.court;
      // Extract first sentence of summary as brief description
      const firstLine = r.summary.split("\n").find((l) => l.trim().length > 20) ?? "";
      return `- [${r.relevance}] ${courtLabel}, ${r.year} — Document ID: ${r.docId} — ${firstLine.slice(0, 120)}`;
    })
    .join("\n");

  return fullSection + `\n\n══════════════════════════════════════════\nΥπόλοιπες σχετικές αποφάσεις (${rest.length}):\n══════════════════════════════════════════\n${briefSection}`;
}

// ── Summarizer Agent ───────────────────────────────────

/** Legal analysis marker: court's reasoning section (ΝΟΜΙΚΗ ΠΤΥΧΗ). ~5400 docs have it. */
const LEGAL_ANALYSIS_MARKER = "ΝΟΜΙΚΗ ΠΤΥΧΗ";

/** Decision text marker: start of case body. */
const DECISION_MARKER = "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:";

/**
 * Extract text for summarization. Prefer ΝΟΜΙΚΗ ΠΤΥΧΗ (legal analysis) when present;
 * else use text after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ. Truncation: head+tail of the extracted section.
 */
function extractDecisionText(text: string, maxChars: number): string {
  const firstNewline = text.indexOf("\n");
  const title = firstNewline > 0 ? text.slice(0, firstNewline).trim() + "\n\n" : "";

  // Prefer legal analysis section when present
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
4. WHAT THE CASE IS ACTUALLY ABOUT: In 1-2 sentences, state the core legal issue the court decided.
5. COURT'S FINDINGS on "${focus}":
   Pick ONE engagement level:
   - RULED: The court analyzed the topic and reached a conclusion or ruling.
   - DISCUSSED: The court substantively engaged with the topic but did NOT reach a conclusion.
   - MENTIONED: The topic was only briefly referenced without substantive analysis.
   - NOT ADDRESSED: The topic does not appear in the decision.
   State the level, then:
   - If RULED: Quote the court's conclusion in original Greek.
   - If DISCUSSED: Describe what the court analyzed. Quote the most relevant passage.
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
    temperature: 0,
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

// ── Lightweight Reranker ──────────────────────────────

const RERANK_MODEL = "gpt-4o-mini";
const RERANK_MIN_SCORE_GPT = 4;      // 0-10 scale; GPT-4o-mini: keep docs scoring >= 4
const RERANK_MIN_SCORE_COHERE = 0.1; // 0-10 scale (= 0.01 native); Cohere scores are much lower, use top_n + cap
const RERANK_MAX_DOCS_IN = 180;      // max docs to send to reranker (9 searches × 30 docs)
const RERANK_BATCH_SIZE = 20;        // score in batches of 20 to prevent attention degradation
const SUMMARIZE_DOCS_MIN = 30;       // minimum docs to always keep (baseline)
const SUMMARIZE_DOCS_MAX = 50;       // absolute max to prevent cost explosion
const SMART_CUTOFF_SCORE = 2.0;      // extend beyond min for docs scoring >= this
const RERANK_HEAD_CHARS = 500;        // chars from document head (title, parties)
const RERANK_DECISION_CHARS = 2000;   // chars from start of decision text / ΝΟΜΙΚΗ ΠΤΥΧΗ
const RERANK_TAIL_CHARS = 1500;       // chars from end (ruling/conclusion)
const RERANK_TAIL_SKIP = 200;         // chars to skip from very end (signatures/costs)

/**
 * Extract a smart preview: title + subject + start of legal analysis / decision + conclusion.
 *
 * Cypriot docs: title → ΑΝΑΦΟΡΕΣ → ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ → sections → ΝΟΜΙΚΗ ΠΤΥΧΗ (legal analysis).
 * When ΝΟΜΙΚΗ ΠΤΥΧΗ exists (~5400 docs), use it for relevance scoring — it's the court's reasoning.
 * Otherwise use first 600 chars after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ.
 */
function buildRerankPreview(text: string): string {
  const head = text.slice(0, RERANK_HEAD_CHARS);

  let subjectLine = "";
  const subjectMatch = text.match(/Subject:\s*(.+)/);
  if (subjectMatch) {
    subjectLine = `[SUBJECT: ${subjectMatch[1].trim()}]`;
  }

  const tailEnd = Math.max(0, text.length - RERANK_TAIL_SKIP);
  const tailStart = Math.max(0, tailEnd - RERANK_TAIL_CHARS);
  const tail = tailStart > RERANK_HEAD_CHARS ? text.slice(tailStart, tailEnd) : "";

  // Prefer ΝΟΜΙΚΗ ΠΤΥΧΗ (legal analysis) for preview when present
  const legalIdx = text.indexOf(LEGAL_ANALYSIS_MARKER);
  const keimenoIdx = text.indexOf("ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ");

  let decisionPreview: string;
  if (legalIdx !== -1) {
    let start = legalIdx + LEGAL_ANALYSIS_MARKER.length;
    while (start < text.length && /[:\s*]/.test(text[start])) {
      start++;
    }
    decisionPreview = text.slice(start, start + RERANK_DECISION_CHARS);
  } else if (keimenoIdx !== -1) {
    let start = keimenoIdx + "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ".length;
    while (start < text.length && /[:\s*]/.test(text[start])) {
      start++;
    }
    decisionPreview = text.slice(start, start + RERANK_DECISION_CHARS);
  } else {
    decisionPreview = text.slice(0, RERANK_DECISION_CHARS);
  }

  const parts = [head];
  if (subjectLine) parts.push(subjectLine);
  parts.push("\n[...]\n", decisionPreview);
  if (tail) parts.push("\n[...middle omitted...]\n", tail);

  return parts.join("");
}

/**
 * Lightweight reranker: read title + start of decision for each doc,
 * send all previews in one GPT-4o-mini call, keep only docs scoring >= RERANK_MIN_SCORE.
 *
 * Cost: ~$0.003-0.008 per call (vs ~$1.50 for full summarization of all docs).
 */
async function rerankDocs(
  client: OpenAI,
  docs: SearchResult[],
  userQuery: string,
  fetchDoc: FetchDocumentFn,
  emit?: (event: SSEYield) => void,
): Promise<SearchResult[]> {
  if (docs.length === 0) return [];
  if (docs.length <= 3) return docs; // too few to bother reranking

  const docsToRerank = docs.slice(0, RERANK_MAX_DOCS_IN);

  // 1. Fetch smart preview (title + decision start) for each doc
  const previews: { idx: number; docId: string; preview: string }[] = [];

  // Fetch in parallel batches of 5
  for (let i = 0; i < docsToRerank.length; i += 5) {
    const batch = docsToRerank.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (doc, batchIdx) => {
        const text = await fetchDoc(doc.doc_id);
        if (!text) return null;
        return {
          idx: i + batchIdx,
          docId: doc.doc_id,
          preview: buildRerankPreview(text),
        };
      }),
    );
    for (const r of results) {
      if (r) previews.push(r);
    }
  }

  if (previews.length === 0) return docs;

  // 2. Score documents — Cohere rerank (preferred) or GPT-4o-mini batches (fallback)
  const allScores = new Map<number, number>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let rerankBackend = "gpt-4o-mini";

  // ── Helper: score a batch of previews with GPT-4o-mini ──
  async function gptScoreBatch(
    batch: { idx: number; docId: string; preview: string }[],
  ): Promise<Map<number, number>> {
    const batchScores = new Map<number, number>();
    const docList = batch
      .map((p, localIdx) => `[DOC_${localIdx}] ${p.docId}\n${p.preview}`)
      .join("\n---\n");

    const rerankPrompt = `You are a legal relevance scorer for Cypriot court decisions. The user's research question is:
"${userQuery}"

Below are ${batch.length} document previews. Each preview shows THREE parts:
1. TITLE/HEADER (case name, parties, date)
2. DECISION OPENING (court name, jurisdiction type, first paragraphs after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ)
3. CONCLUSION/RULING (the court's actual ruling from near the end of the document)

Score each document's likely relevance on a 0-10 scale:
- 0-1: Completely unrelated topic (different area of law entirely)
- 2-3: Same area of law but different legal issue
- 4-5: Related legal issue, might contain useful references or dicta
- 6-7: Directly addresses the topic — court analyzed this specific legal question
- 8-10: Core case — court ruled on this exact legal question

SCORING TIPS:
- The CONCLUSION section is most informative — it shows what the court actually decided
- The JURISDICTION TYPE (e.g., ΠΕΡΙΟΥΣΙΑΚΩΝ ΔΙΑΦΟΡΩΝ, ΟΙΚΟΓΕΝΕΙΑΚΗ) is a strong signal
- If you see legal terms/statutes from the query mentioned in the conclusion, score higher
- Look for PARTY NAMES that suggest foreign elements (non-Greek names, Russian, English parties)
- Cases involving cross-border assets, foreign law references, or international elements score higher for international law queries

Respond with ONLY a JSON array of objects: [{"idx": 0, "score": 5}, {"idx": 1, "score": 2}, ...]
No explanation, no markdown fencing, just the JSON array.

Documents:
${docList}`;

    try {
      const response = await client.chat.completions.create({
        model: RERANK_MODEL,
        messages: [{ role: "user", content: rerankPrompt }],
        temperature: 0,
        max_tokens: 2000,
      });

      totalInputTokens += response.usage?.prompt_tokens ?? 0;
      totalOutputTokens += response.usage?.completion_tokens ?? 0;

      const rawOutput = response.choices[0]?.message?.content ?? "[]";
      const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.log(JSON.stringify({ event: "rerank_parse_error", raw: rawOutput.slice(0, 200) }));
        return batchScores;
      }

      const scores: { idx: number; score: number }[] = JSON.parse(jsonMatch[0]);
      for (const s of scores) {
        if (s.idx >= 0 && s.idx < batch.length) {
          batchScores.set(batch[s.idx].idx, s.score);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ event: "rerank_gpt_batch_error", error: msg }));
    }
    return batchScores;
  }

  const cohereKey = process.env.COHERE_API_KEY;
  if (cohereKey) {
    // ── Cohere rerank: single call, no batch noise ──
    rerankBackend = "cohere";
    try {
      const documents = previews.map((p) => p.preview);
      // Return ALL scores (not just top N) so BM25-found docs aren't silently dropped
      const results = await cohereRerank(userQuery, documents);
      // Cohere returns 0-1 scores; multiply by 10 for compatibility with 0-10 scale
      for (const r of results) {
        allScores.set(r.index, Math.round(r.score * 10 * 10) / 10); // one decimal
      }
      console.log(JSON.stringify({
        event: "rerank_cohere",
        inputDocs: previews.length,
        resultsReturned: results.length,
      }));

      // ── Hybrid pass: GPT-4o-mini rescores docs that Cohere scored low ──
      // Cohere can't do legal reasoning (e.g., "Russian citizens = foreign law").
      // GPT-4o-mini can infer this but has batch noise with large batches.
      // Solution: only send Cohere's low-scoring docs to GPT for a second opinion.
      const COHERE_GPT_THRESHOLD = 1.0; // on 0-10 scale — rescore docs below this
      const lowScoredPreviews = previews.filter(
        (p) => (allScores.get(p.idx) ?? 0) < COHERE_GPT_THRESHOLD,
      );

      if (lowScoredPreviews.length > 0) {
        rerankBackend = "cohere+gpt";
        console.log(JSON.stringify({
          event: "rerank_hybrid_gpt_pass",
          lowScoredCount: lowScoredPreviews.length,
          threshold: COHERE_GPT_THRESHOLD,
        }));

        // Score in batches of RERANK_BATCH_SIZE
        for (let i = 0; i < lowScoredPreviews.length; i += RERANK_BATCH_SIZE) {
          const batch = lowScoredPreviews.slice(i, i + RERANK_BATCH_SIZE);
          const gptScores = await gptScoreBatch(batch);

          // Merge: use max(cohereScore, gptScore) for each doc
          let upgraded = 0;
          for (const [idx, gptScore] of gptScores) {
            const cohereScore = allScores.get(idx) ?? 0;
            if (gptScore > cohereScore) {
              allScores.set(idx, gptScore);
              upgraded++;
            }
          }
          if (upgraded > 0) {
            console.log(JSON.stringify({
              event: "rerank_hybrid_upgrades",
              batchStart: i,
              batchSize: batch.length,
              upgraded,
            }));
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ event: "rerank_cohere_error", error: msg }));
      // Fall through to GPT-4o-mini fallback
      rerankBackend = "gpt-4o-mini-fallback";
    }
  }

  if (allScores.size === 0) {
    // ── GPT-4o-mini full fallback (no Cohere key): score ALL docs in batches ──
    for (let batchStart = 0; batchStart < previews.length; batchStart += RERANK_BATCH_SIZE) {
      const batch = previews.slice(batchStart, batchStart + RERANK_BATCH_SIZE);
      const batchScores = await gptScoreBatch(batch);
      for (const [idx, score] of batchScores) {
        allScores.set(idx, score);
      }
    }
  }

  // 3. Filter: keep docs with score >= threshold, sorted by reranker score (desc)
  //    Exception: docs with strong BM25 rank (from hybrid search) are force-kept
  //    even if Cohere scored them low — BM25 keyword match is a reliable signal.
  const BM25_FORCE_KEEP_RANK = 50; // force-keep docs in top 50 BM25 results
  // For hybrid (cohere+gpt), keep Cohere threshold — GPT rescoring lifts scores of
  // rescued docs so they naturally sort higher. The smart cutoff cap handles the rest.
  const minScore = (rerankBackend === "cohere" || rerankBackend === "cohere+gpt")
    ? RERANK_MIN_SCORE_COHERE
    : RERANK_MIN_SCORE_GPT;
  const scored: { doc: SearchResult; rerankScore: number }[] = [];
  const dropped: string[] = [];
  let bm25ForceKept = 0;
  for (const p of previews) {
    const score = allScores.get(p.idx) ?? 0;
    const original = docsToRerank[p.idx];
    const hasBm25Signal = original?.bm25Rank != null && original.bm25Rank <= BM25_FORCE_KEEP_RANK;

    if (score >= minScore || hasBm25Signal) {
      if (original) {
        scored.push({ doc: original, rerankScore: score });
        if (score < minScore && hasBm25Signal) bm25ForceKept++;
      }
    } else {
      dropped.push(p.docId);
    }
  }

  if (bm25ForceKept > 0) {
    console.log(JSON.stringify({ event: "rerank_bm25_force_kept", count: bm25ForceKept }));
  }

  // Sort by effective score: reranker score + BM25 rank boost (inverse of rank)
  // BM25 boost ensures keyword-matched docs aren't buried by Cohere's text-similarity scoring
  const BM25_BOOST_MAX = 5; // max boost on 0-10 scale for BM25 rank 1
  function effectiveScore(s: { doc: SearchResult; rerankScore: number }): number {
    const bm25Rank = s.doc.bm25Rank;
    const boost = bm25Rank != null && bm25Rank <= BM25_FORCE_KEEP_RANK
      ? BM25_BOOST_MAX * (1 - bm25Rank / BM25_FORCE_KEEP_RANK)
      : 0;
    return s.rerankScore + boost;
  }
  scored.sort((a, b) => effectiveScore(b) - effectiveScore(a) || (b.doc.score ?? 0) - (a.doc.score ?? 0));

  // Smart cutoff: keep at least SUMMARIZE_DOCS_MIN, extend up to MAX for high-scoring docs
  // This prevents losing relevant docs (B3 score=6, A3 score=3.5) that fall outside top 30
  let cutoffIdx = Math.min(scored.length, SUMMARIZE_DOCS_MIN);
  while (cutoffIdx < Math.min(scored.length, SUMMARIZE_DOCS_MAX)) {
    if (effectiveScore(scored[cutoffIdx]) < SMART_CUTOFF_SCORE) break;
    cutoffIdx++;
  }
  const kept = scored.slice(0, cutoffIdx).map((s) => s.doc);
  const cappedDocs = scored.length - cutoffIdx;

  // Build score details for logging and SSE — 'kept' reflects actual cap, not just score threshold
  const keptDocIds = new Set(kept.map((d) => d.doc_id));
  const scoreDetails = previews.map((p) => ({
    doc_id: p.docId,
    rerank_score: allScores.get(p.idx) ?? 0,
    kept: keptDocIds.has(p.docId),
  }));

  console.log(JSON.stringify({
    event: "rerank_complete",
    sessionId: _sessionId,
    userEmail: _userEmail,
    backend: rerankBackend,
    inputDocs: previews.length,
    batches: rerankBackend === "cohere" ? 1 : Math.ceil(previews.length / RERANK_BATCH_SIZE),
    keptByScore: scored.length,
    cappedTo: cutoffIdx,
    smartCutoffExtended: cutoffIdx > SUMMARIZE_DOCS_MIN,
    dropped: dropped.length,
    minScore: minScore,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  }));

  if (cappedDocs > 0) {
    console.log(JSON.stringify({
      event: "rerank_capped",
      droppedByCap: cappedDocs,
      summarizeDocsMin: SUMMARIZE_DOCS_MIN,
      summarizeDocsMax: SUMMARIZE_DOCS_MAX,
      smartCutoffScore: SMART_CUTOFF_SCORE,
    }));
  }

  // Emit reranker results via SSE for diagnostics
  if (emit) {
    emit({
      event: "reranked",
      data: {
        inputDocs: previews.length,
        keptCount: kept.length,
        droppedCount: dropped.length,
        cappedFrom: scored.length,
        threshold: minScore,
        scores: scoreDetails,
      },
    });
  }

  // If reranker would drop ALL docs, keep top 5 as fallback
  if (kept.length === 0) {
    console.log(JSON.stringify({ event: "rerank_fallback", reason: "all_dropped" }));
    return docsToRerank.slice(0, 5);
  }

  return kept;
}

// ── Search + Summarize Handler ─────────────────────────

let _fetchDocumentFn: FetchDocumentFn | null = null;
let _lastUserQuery = "";
let _legalContext = "";      // rich context from LLM tool calls (laws, regulations, case names)
let _sessionId = "unknown";
let _userEmail = "anonymous";

export function setFetchDocumentFn(fn: FetchDocumentFn) {
  _fetchDocumentFn = fn;
}

export function setLastUserQuery(query: string) {
  _lastUserQuery = query;
  _legalContext = "";  // reset per conversation turn
}

export function setSessionId(id: string) {
  _sessionId = id;
}

export function setUserEmail(email: string) {
  _userEmail = email;
}

/**
 * Phase 1: Search only — Vectorize search, deduplicate, return doc_ids.
 * Fast (~2s per call). No summarization.
 */
async function handleSearch(
  query: string,
  courtLevel: string | undefined,
  yearFrom: number | undefined,
  yearTo: number | undefined,
  searchFn: SearchFn,
  seenDocIds: Set<string>,
  allSources: SearchResult[],
  emit: (event: SSEYield) => void,
): Promise<SearchResult[]> {
  const searchResults = await searchFn(query, courtLevel, yearFrom, yearTo);

  // Deduplicate — skip already-seen docs
  const newResults = searchResults.filter(
    (r) => r.doc_id && !seenDocIds.has(r.doc_id),
  );

  // Track and emit sources immediately
  for (const r of newResults) {
    seenDocIds.add(r.doc_id);
    if (!allSources.some((s) => s.doc_id === r.doc_id)) {
      allSources.push({ ...r, text: r.text.slice(0, 400) });
    }
  }
  if (newResults.length > 0) {
    emit({ event: "sources", data: allSources });
  }

  return newResults;
}

/**
 * Phase 2: Summarize all collected documents.
 * Production: uses Summarizer Worker via Service Binding (each call = fresh connection pool).
 * Dev: falls back to direct OpenAI calls.
 */
async function summarizeAllDocs(
  client: OpenAI,
  docs: SearchResult[],
  emit: (event: SSEYield) => void,
  summarizerBinding?: Fetcher,
): Promise<{ inputTokens: number; outputTokens: number; count: number }> {
  if (docs.length === 0) {
    return { inputTokens: 0, outputTokens: 0, count: 0 };
  }

  // Use only user query as focus. Legal context was found to add noise —
  // summarizer can over-weight mention of specific regulations (false HIGH on C-docs)
  // or under-weight docs that address the topic but don't cite expected laws (false NONE on B-docs).
  const summarizerFocus = _lastUserQuery;

  emit({ event: "summarizing", data: { count: docs.length, focus: _lastUserQuery } });

  let totalIn = 0;
  let totalOut = 0;
  let summarized = 0;

  if (summarizerBinding) {
    // Production: send batches of 5 to Summarizer Worker via Service Binding
    // Each call = new request = fresh 6-connection pool
    const BATCH_SIZE = 5;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);

      // Emit progress to keep SSE connection alive and inform the UI
      emit({ event: "summarizing", data: { count: docs.length, progress: i, focus: _lastUserQuery } });

      try {
        const res = await summarizerBinding.fetch("https://summarizer/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            docIds: batch.map((d) => d.doc_id),
            userQuery: _lastUserQuery,
            focus: summarizerFocus,
            openaiApiKey: process.env.OPENAI_API_KEY,
          }),
        });

        if (!res.ok) {
          console.error("[Summarizer] Batch error:", await res.text());
          continue;
        }

        const data = await res.json() as {
          results: Array<{
            docId: string;
            summary: string;
            relevance: string;
            court: string;
            year: number;
            inputTokens: number;
            outputTokens: number;
          }>;
        };

        for (const result of data.results) {
          totalIn += result.inputTokens;
          totalOut += result.outputTokens;
          summarized++;
          emit({ event: "summaries", data: [{ docId: result.docId, summary: result.summary }] });
        }
      } catch (err) {
        console.error("[Summarizer] Service binding error:", err instanceof Error ? err.message : err);
      }
    }
  } else {
    // Dev fallback: direct OpenAI calls with higher concurrency
    const fetchDoc = _fetchDocumentFn;
    if (!fetchDoc) return { inputTokens: 0, outputTokens: 0, count: 0 };

    const CONCURRENCY = 5;
    for (let i = 0; i < docs.length; i += CONCURRENCY) {
      const batch = docs.slice(i, i + CONCURRENCY);

      // Emit progress to keep SSE connection alive
      emit({ event: "summarizing", data: { count: docs.length, progress: i, focus: _lastUserQuery } });

      await Promise.all(
        batch.map(async (r) => {
          const text = await fetchDoc(r.doc_id);
          if (!text) return;
          const result = await summarizeDocument(client, r.doc_id, text, summarizerFocus, _lastUserQuery);
          if (result) {
            totalIn += result.inputTokens;
            totalOut += result.outputTokens;
            summarized++;
            emit({ event: "summaries", data: [{ docId: result.docId, summary: result.summary }] });
          }
        }),
      );
    }
  }

  console.log(JSON.stringify({
    event: "summarize_batch",
    sessionId: _sessionId,
    userEmail: _userEmail,
    totalDocs: docs.length,
    summarized,
    inputTokens: totalIn,
    outputTokens: totalOut,
    viaServiceBinding: !!summarizerBinding,
  }));

  return { inputTokens: totalIn, outputTokens: totalOut, count: summarized };
}

// ── Main Chat Stream ───────────────────────────────────

export function chatStream(
  messages: ChatMessage[],
  modelKey: string,
  searchFn: SearchFn,
  summarizerBinding?: Fetcher,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const modelCfg = MODELS[modelKey];

  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (lastUserMsg) setLastUserQuery(lastUserMsg.content);

  return new ReadableStream({
    async start(controller) {
      function emit(event: SSEYield) {
        const dataStr =
          typeof event.data === "object"
            ? JSON.stringify(event.data)
            : String(event.data).replace(/\n/g, "\\n");
        controller.enqueue(
          encoder.encode(`event: ${event.event}\ndata: ${dataStr}\n\n`),
        );
      }

      if (!modelCfg) {
        emit({ event: "error", data: `Unknown model: ${modelKey}` });
        controller.close();
        return;
      }

      try {
        const system = getSystem();
        if (modelCfg.provider === "openai") {
          await streamOpenAI(messages, modelCfg, system, searchFn, emit, summarizerBinding);
        } else {
          await streamClaude(messages, modelCfg, system, searchFn, emit, summarizerBinding);
        }
      } catch (err) {
        emit({ event: "error", data: formatApiError(err) });
      }

      controller.close();
    },
  });
}

// ── OpenAI Provider ────────────────────────────────────

async function streamOpenAI(
  messages: ChatMessage[],
  modelCfg: ModelConfig,
  system: string,
  searchFn: SearchFn,
  emit: (event: SSEYield) => void,
  summarizerBinding?: Fetcher,
) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Phase 1: Search — LLM calls search_cases, we only do Vectorize (fast)
  const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...messages,
  ];

  const allSources: SearchResult[] = [];
  const seenDocIds = new Set<string>();
  const allFoundDocs: SearchResult[] = []; // all unique docs across all searches
  let searchStep = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // ── Query #0: Always search the user's raw query first ──
  // This catches exact statute/article/case number references that LLM paraphrasing might lose.
  if (_lastUserQuery && _lastUserQuery.trim().length > 2) {
    searchStep++;
    emit({
      event: "searching",
      data: {
        query: _lastUserQuery,
        step: searchStep,
        isRawQuery: true,
      },
    });
    const rawDocs = await handleSearch(
      _lastUserQuery,
      undefined,  // no court_level filter for raw query
      undefined,
      undefined,
      searchFn,
      seenDocIds,
      allSources,
      emit,
    );
    allFoundDocs.push(...rawDocs);
    emit({
      event: "search_result",
      data: { step: searchStep, found: rawDocs.length, total: allSources.length, isRawQuery: true },
    });
    console.log(JSON.stringify({
      event: "raw_query_search",
      query: _lastUserQuery.slice(0, 200),
      found: rawDocs.length,
    }));
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model: modelCfg.modelId,
      messages: apiMessages,
      tools: [SEARCH_TOOL],
      temperature: 0.1,
    });

    if (response.usage) {
      totalInputTokens += response.usage.prompt_tokens;
      totalOutputTokens += response.usage.completion_tokens;
    }

    const choice = response.choices[0];

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
      apiMessages.push(choice.message);

      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.type !== "function") continue;
        const args = JSON.parse(toolCall.function.arguments);

        if (toolCall.function.name === "search_cases") {
          searchStep++;
          // Capture legal_context from LLM — accumulate across searches for richer summarizer focus
          if (args.legal_context && args.legal_context !== _legalContext) {
            _legalContext = _legalContext
              ? `${_legalContext}; ${args.legal_context}`
              : args.legal_context;
          }
          emit({
            event: "searching",
            data: {
              query: args.query ?? "",
              step: searchStep,
              courtLevel: args.court_level,
              yearFrom: args.year_from,
              yearTo: args.year_to,
              legalContext: args.legal_context,
            },
          });

          // Phase 1: search only — no summarization
          const newDocs = await handleSearch(
            args.query ?? "",
            args.court_level,
            args.year_from,
            args.year_to,
            searchFn,
            seenDocIds,
            allSources,
            emit,
          );
          allFoundDocs.push(...newDocs);

          // Notify UI about search completion with doc count
          emit({
            event: "search_result",
            data: { step: searchStep, found: newDocs.length, total: allSources.length },
          });

          // Tool result: list of found docs so LLM can decide if more searches needed
          const docList = newDocs.slice(0, 5).map((r) => `${r.title} (${r.court}, ${r.year})`).join("; ");
          apiMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: newDocs.length > 0
              ? `Βρέθηκαν ${newDocs.length} νέα έγγραφα: ${docList}${newDocs.length > 5 ? "..." : ""}`
              : `Δεν βρέθηκαν νέα έγγραφα. Δοκιμάστε διαφορετικούς όρους.`,
          });
        }
      }
      continue;
    }

    // No more tool calls
    break;
  }

  // Sort by vector score (desc) so reranker evaluates best candidates first
  allFoundDocs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Phase 1.5: Lightweight rerank — filter out likely-irrelevant docs before expensive summarization
  const fetchDoc = _fetchDocumentFn;
  let docsToSummarize = allFoundDocs;
  if (fetchDoc && allFoundDocs.length > 3) {
    docsToSummarize = await rerankDocs(client, allFoundDocs, _lastUserQuery, fetchDoc, emit);
  }

  // Phase 2: Summarize only reranked docs
  const summarizerResult = await summarizeAllDocs(client, docsToSummarize, emit, summarizerBinding);

  // Final sources emit
  if (allSources.length > 0) {
    emit({ event: "sources", data: allSources });
  }

  const mainCost = calculateCost(modelCfg, totalInputTokens, totalOutputTokens);
  const summarizerCost = (summarizerResult.inputTokens / 1_000_000) * 2.5 +
                         (summarizerResult.outputTokens / 1_000_000) * 10;
  const totalCost = mainCost + summarizerCost;

  console.log(JSON.stringify({
    event: "chat_complete",
    sessionId: _sessionId,
    userEmail: _userEmail,
    provider: "openai",
    model: modelCfg.label,
    mainInputTokens: totalInputTokens,
    mainOutputTokens: totalOutputTokens,
    mainCostUsd: parseFloat(mainCost.toFixed(4)),
    summarizerDocsAnalyzed: summarizerResult.count,
    summarizerInputTokens: summarizerResult.inputTokens,
    summarizerOutputTokens: summarizerResult.outputTokens,
    summarizerCostUsd: parseFloat(summarizerCost.toFixed(4)),
    totalCostUsd: parseFloat(totalCost.toFixed(4)),
    searchSteps: searchStep,
    sourcesFound: allSources.length,
    rerankedFrom: allFoundDocs.length,
    rerankedTo: docsToSummarize.length,
  }));

  emit({
    event: "usage",
    data: {
      model: modelCfg.label,
      inputTokens: totalInputTokens + summarizerResult.inputTokens,
      outputTokens: totalOutputTokens + summarizerResult.outputTokens,
      totalTokens: totalInputTokens + totalOutputTokens + summarizerResult.inputTokens + summarizerResult.outputTokens,
      costUsd: totalCost,
      documentsAnalyzed: summarizerResult.count,
    } as UsageData,
  });
  emit({ event: "done", data: {} });
}

// ── Claude Provider ────────────────────────────────────

async function streamClaude(
  messages: ChatMessage[],
  modelCfg: ModelConfig,
  system: string,
  searchFn: SearchFn,
  emit: (event: SSEYield) => void,
  summarizerBinding?: Fetcher,
) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Phase 1: Search — LLM calls search_cases, we only do Vectorize (fast)
  const apiMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const allSources: SearchResult[] = [];
  const seenDocIds = new Set<string>();
  const allFoundDocs: SearchResult[] = [];
  let searchStep = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // ── Query #0: Always search the user's raw query first ──
  if (_lastUserQuery && _lastUserQuery.trim().length > 2) {
    searchStep++;
    emit({
      event: "searching",
      data: { query: _lastUserQuery, step: searchStep, isRawQuery: true },
    });
    const rawDocs = await handleSearch(
      _lastUserQuery, undefined, undefined, undefined,
      searchFn, seenDocIds, allSources, emit,
    );
    allFoundDocs.push(...rawDocs);
    emit({
      event: "search_result",
      data: { step: searchStep, found: rawDocs.length, total: allSources.length, isRawQuery: true },
    });
    console.log(JSON.stringify({
      event: "raw_query_search",
      query: _lastUserQuery.slice(0, 200),
      found: rawDocs.length,
    }));
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: modelCfg.modelId,
      max_tokens: 8192,
      system,
      messages: apiMessages,
      tools: [CLAUDE_SEARCH_TOOL],
      temperature: 0.1,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length > 0) {
      apiMessages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUses) {
        const args = toolUse.input as Record<string, unknown>;

        if (toolUse.name === "search_cases") {
          searchStep++;
          // Capture legal_context from LLM
          const lc = args.legal_context as string | undefined;
          if (lc && lc !== _legalContext) {
            _legalContext = _legalContext ? `${_legalContext}; ${lc}` : lc;
          }
          emit({
            event: "searching",
            data: {
              query: (args.query as string) ?? "",
              step: searchStep,
              courtLevel: args.court_level as string | undefined,
              yearFrom: args.year_from as number | undefined,
              yearTo: args.year_to as number | undefined,
              legalContext: args.legal_context as string | undefined,
            },
          });

          // Phase 1: search only — no summarization
          const newDocs = await handleSearch(
            (args.query as string) ?? "",
            args.court_level as string | undefined,
            args.year_from as number | undefined,
            args.year_to as number | undefined,
            searchFn,
            seenDocIds,
            allSources,
            emit,
          );
          allFoundDocs.push(...newDocs);

          // Notify UI about search completion with doc count
          emit({
            event: "search_result",
            data: { step: searchStep, found: newDocs.length, total: allSources.length },
          });

          const docList = newDocs.slice(0, 5).map((r) => `${r.title} (${r.court}, ${r.year})`).join("; ");
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: newDocs.length > 0
              ? `Βρέθηκαν ${newDocs.length} νέα έγγραφα: ${docList}${newDocs.length > 5 ? "..." : ""}`
              : `Δεν βρέθηκαν νέα έγγραφα.`,
          });
        }
      }

      apiMessages.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  // Sort by vector score (desc) so reranker evaluates best candidates first
  allFoundDocs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Phase 1.5: Lightweight rerank — filter out likely-irrelevant docs before expensive summarization
  const fetchDoc = _fetchDocumentFn;
  let docsToSummarize = allFoundDocs;
  if (fetchDoc && allFoundDocs.length > 3) {
    docsToSummarize = await rerankDocs(openaiClient, allFoundDocs, _lastUserQuery, fetchDoc, emit);
  }

  // Phase 2: Summarize only reranked docs
  const summarizerResult = await summarizeAllDocs(openaiClient, docsToSummarize, emit, summarizerBinding);

  // Final sources emit
  if (allSources.length > 0) emit({ event: "sources", data: allSources });

  const mainCost = calculateCost(modelCfg, totalInputTokens, totalOutputTokens);
  const summarizerCost = (summarizerResult.inputTokens / 1_000_000) * 2.5 +
                         (summarizerResult.outputTokens / 1_000_000) * 10;
  const totalCost = mainCost + summarizerCost;

  console.log(JSON.stringify({
    event: "chat_complete",
    sessionId: _sessionId,
    userEmail: _userEmail,
    provider: "anthropic",
    model: modelCfg.label,
    mainInputTokens: totalInputTokens,
    mainOutputTokens: totalOutputTokens,
    mainCostUsd: parseFloat(mainCost.toFixed(4)),
    summarizerDocsAnalyzed: summarizerResult.count,
    summarizerInputTokens: summarizerResult.inputTokens,
    summarizerOutputTokens: summarizerResult.outputTokens,
    summarizerCostUsd: parseFloat(summarizerCost.toFixed(4)),
    totalCostUsd: parseFloat(totalCost.toFixed(4)),
    searchSteps: searchStep,
    sourcesFound: allSources.length,
    rerankedFrom: allFoundDocs.length,
    rerankedTo: docsToSummarize.length,
  }));

  emit({
    event: "usage",
    data: {
      model: modelCfg.label,
      inputTokens: totalInputTokens + summarizerResult.inputTokens,
      outputTokens: totalOutputTokens + summarizerResult.outputTokens,
      totalTokens: totalInputTokens + totalOutputTokens + summarizerResult.inputTokens + summarizerResult.outputTokens,
      costUsd: totalCost,
      documentsAnalyzed: summarizerResult.count,
    } as UsageData,
  });
  emit({ event: "done", data: {} });
}

/** Phase 1 stub for production (until Vectorize is connected) */
export const stubSearchFn: SearchFn = async () => [];
