/**
 * Agentic LLM client with summarize-first pipeline.
 *
 * Flow:
 *   1. Main LLM calls search_cases → retriever finds docs → summarizer reads each → returns summaries
 *   2. Main LLM receives pre-summarized results (NONE filtered out) and composes answer
 *
 * Each search_cases call triggers inline summarization — no separate summarize step.
 * Documents are deduplicated across searches. Court-level boost applied to ordering.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ModelConfig, SearchResult, UsageData } from "./types";
import { MODELS, COURT_NAMES } from "./types";

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
- Άρειος Πάγος (Areios Pagos, "areiospagos") — 46,159 decisions (1968-2026)
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

Also identify:
1. What specific Cypriot laws the judge would CITE (e.g., Ν. 232/91, Δ.25 Θεσμών Πολιτικής Δικονομίας, Cap. 148)
2. What SYNONYMS different judges might use for the same concept

SEARCH RULES:
1. Each query must be a PHRASE that a judge would write in a decision about this topic — not an abstract legal category.
2. Do 3-5 searches with DIFFERENT query texts. NEVER repeat the same query. You may do more searches if needed for multiple court levels.
3. Use year_from/year_to filters when the user specifies a time range.
4. If the user mentions a specific law or article (e.g., "Cap. 148", "Άρθρο 47"), include the exact reference in at least one search query.
5. Fill legal_context with a BRIEF note of relevant laws and articles — this is supplementary context for the AI analyst, keep it short (1-2 sentences).
6. Use court_level when the user explicitly asks for a specific court (Ανώτατο Δικαστήριο → "supreme", Εφετείο → "appeal"). If the user asks for BOTH Supreme Court and Court of Appeal, do separate filtered searches for each. Always include at least 1-2 broad searches (no court_level).

WORKFLOW — you have one tool:
**search_cases**: Search and analyze court cases. Parameters:
- **query** (required): Search query in Cypriot Greek legal terminology
- **legal_context** (required): Your legal analysis — laws, articles, doctrines, key terms. This is passed to the AI analyst who reads each case.
- **court_level** (optional): "supreme" or "appeal" — use sparingly, only when user asks for specific court
- **year_from** / **year_to** (optional): Year range filter

Each call automatically searches the database, reads full texts, and analyzes each case. The results (relevant court decisions with AI-generated summaries) are displayed directly to the user by the application — you do NOT receive them and do NOT need to list them.

YOUR ONLY JOB: Call search_cases 3-5 times with different query texts (more if needed for multiple court levels). Do NOT write any text, analysis, or commentary — the application handles everything else.

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
          description: "Your legal analysis: specific Cypriot laws, articles, doctrines, and key legal terms relevant to this search. This helps the AI analyst understand what to look for in each court decision. Example: 'Δ.25 Θεσμών Πολιτικής Δικονομίας — τροποποίηση δικογράφου. Βασικές αποφάσεις: Φοινιώτης ν. Greenmar Navigation.'",
        },
        court_level: {
          type: "string",
          enum: ["supreme", "appeal"],
          description: "Filter by court level. Use when the user asks for a specific court (Ανώτατο Δικαστήριο = supreme, Εφετείο = appeal). Leave empty for broad search across all courts.",
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
  event: "searching" | "sources" | "summarizing" | "summaries" | "token" | "done" | "error" | "usage";
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
  // Always log the raw error for debugging
  console.error("[LLM] API error:", message);
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
    areiospagos: "supreme", jsc: "supreme", rscc: "supreme", clr: "supreme",
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
7. RELEVANCE RATING: Rate as HIGH / MEDIUM / LOW / NONE and explain in one sentence.

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

// ── Search + Summarize Handler ─────────────────────────

let _fetchDocumentFn: FetchDocumentFn | null = null;
let _lastUserQuery = "";
let _sessionId = "unknown";

export function setFetchDocumentFn(fn: FetchDocumentFn) {
  _fetchDocumentFn = fn;
}

export function setLastUserQuery(query: string) {
  _lastUserQuery = query;
}

export function setSessionId(id: string) {
  _sessionId = id;
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
 * Phase 2: Summarize all collected documents in one batch.
 * Called AFTER all searches complete. Each summary emitted to UI immediately.
 */
async function summarizeAllDocs(
  client: OpenAI,
  docs: SearchResult[],
  emit: (event: SSEYield) => void,
): Promise<{ inputTokens: number; outputTokens: number; count: number }> {
  const fetchDoc = _fetchDocumentFn;
  if (!fetchDoc || docs.length === 0) {
    return { inputTokens: 0, outputTokens: 0, count: 0 };
  }

  emit({ event: "summarizing", data: { count: docs.length, focus: _lastUserQuery } });

  const CONCURRENCY = 5;
  const focus = _lastUserQuery;
  let totalIn = 0;
  let totalOut = 0;
  let summarized = 0;

  for (let i = 0; i < docs.length; i += CONCURRENCY) {
    const batch = docs.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (r) => {
        const text = await fetchDoc(r.doc_id);
        if (!text) return;
        const result = await summarizeDocument(client, r.doc_id, text, focus, _lastUserQuery);
        if (result) {
          totalIn += result.inputTokens;
          totalOut += result.outputTokens;
          summarized++;
          // Send each summary to UI immediately
          emit({ event: "summaries", data: [{ docId: result.docId, summary: result.summary }] });
        }
      }),
    );
  }

  console.log(JSON.stringify({
    event: "summarize_batch",
    sessionId: _sessionId,
    totalDocs: docs.length,
    summarized,
    inputTokens: totalIn,
    outputTokens: totalOut,
  }));

  return { inputTokens: totalIn, outputTokens: totalOut, count: summarized };
}

// ── Main Chat Stream ───────────────────────────────────

export function chatStream(
  messages: ChatMessage[],
  modelKey: string,
  searchFn: SearchFn,
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
          await streamOpenAI(messages, modelCfg, system, searchFn, emit);
        } else {
          await streamClaude(messages, modelCfg, system, searchFn, emit);
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

  // Phase 2: Summarize all found docs in one batch
  const summarizerResult = await summarizeAllDocs(client, allFoundDocs, emit);

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

  // Phase 2: Summarize all found docs in one batch
  const summarizerResult = await summarizeAllDocs(openaiClient, allFoundDocs, emit);

  // Final sources emit
  if (allSources.length > 0) emit({ event: "sources", data: allSources });

  const mainCost = calculateCost(modelCfg, totalInputTokens, totalOutputTokens);
  const summarizerCost = (summarizerResult.inputTokens / 1_000_000) * 2.5 +
                         (summarizerResult.outputTokens / 1_000_000) * 10;
  const totalCost = mainCost + summarizerCost;

  console.log(JSON.stringify({
    event: "chat_complete",
    sessionId: _sessionId,
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
