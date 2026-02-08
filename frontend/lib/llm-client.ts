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

const MAX_TOOL_ROUNDS = 5;
const SUMMARIZER_MODEL = "gpt-4o";
const SUMMARIZER_MAX_TOKENS = 2000;
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

CRITICAL: The database contains court decisions written in CYPRIOT GREEK (κυπριακά ελληνικά). You MUST formulate search queries using Cypriot Greek legal terminology and phrasing patterns that appear in actual court decision texts.

SEARCH TRANSFORMATION EXAMPLES:
- "unfair dismissal" → "παράνομος τερματισμός απασχόλησης" or "αδικαιολόγητη απόλυση"
- "breach of contract" → "παράβαση σύμβασης" or "αθέτηση συμβατικών υποχρεώσεων"
- "right to property" → "δικαίωμα ιδιοκτησίας" or "Άρθρο 23 του Συντάγματος"
- "negligence in medical cases" → "ιατρική αμέλεια"
- "custody dispute" → "επιμέλεια τέκνου" or "γονική μέριμνα"

SEARCH RULES:
1. ALWAYS search using Cypriot Greek legal formulations.
2. Do exactly 3 searches with DIFFERENT query texts covering different angles or synonyms. NEVER repeat the same query.
3. Also search in English when relevant (JSC collection, older Supreme Court).
4. Use year_from/year_to filters when the user specifies a time range.

WORKFLOW — you have one tool:
**search_cases**: Search and analyze court cases. Each call automatically:
1. Searches the vector database for relevant cases
2. Reads the full text of each found case
3. Analyzes each case with a specialized AI agent
4. Returns only the relevant cases with AI-generated summaries

The summaries include a RELEVANCE RATING (HIGH/MEDIUM/LOW) and engagement level. Cases rated NONE are automatically filtered out.

ALWAYS follow this sequence:
1. Call search_cases 3 times with different query texts
2. Review the summaries — they contain the court's actual analysis, not just metadata
3. Compose your answer using the summaries

INTERPRETING CASE SUMMARIES — CRITICAL:
The summaries you receive are AI-generated from court documents. You MUST follow these rules:
1. Each summary contains a RELEVANCE RATING (HIGH/MEDIUM/LOW) and an engagement level (RULED/DISCUSSED/MENTIONED). Use them to STRUCTURE your answer:
   - HIGH (court RULED): Lead your answer with these. Describe the court's ruling in detail.
   - MEDIUM (court DISCUSSED): Present these prominently after HIGH cases. Describe WHAT the court analyzed, what arguments were considered, and WHY a conclusion was not reached.
   - LOW (only MENTIONED): Include in a "Related cases" section. Briefly note what the case was about and how the topic was mentioned.
2. For engagement levels in each summary:
   - RULED: You may describe the court's ruling using "the court held/decided/ruled".
   - DISCUSSED: You may describe the court's analysis using "the court considered/examined/analyzed" but MUST NOT say "the court held/decided/ruled".
   - MENTIONED: You MUST NOT say the court engaged with the topic — only "the topic was referenced/mentioned".
3. NEVER fabricate court holdings. If the summary says the court "did not decide" or "did not address" a topic, you MUST NOT present the case as if the court decided it.
4. Distinguish interim decisions from final decisions. An interim freezing order is NOT a ruling on property division.
5. If none of the summarized cases have HIGH relevance, say so honestly, then present MEDIUM and LOW cases.

RESPONSE STRUCTURE:
You MUST include EVERY summarized case in your answer — no exceptions. Organize by relevance first, then by year (newest first) within each level:
1. Start with HIGH cases from Supreme Court / Court of Appeal (binding precedents), then HIGH from other courts.
2. Then MEDIUM cases, newest first.
3. Then LOW cases under "Related cases", newest first.
4. For each case, indicate its relevance level naturally in the text.
5. Apply the same sorting in the Sources section at the end.

CRITICAL: Do NOT drop or skip any summarized case. Every case that was summarized MUST appear in the answer body.

RESPONSE FORMAT:
1. Answer in the SAME LANGUAGE as the user's question.
2. When mentioning a case in your answer text, ALWAYS make the case name a clickable link: [CASE_TITLE](/doc?doc_id=DOCUMENT_ID)
3. NEVER use empty links like [title](#) or [title]().
4. If a case is still pending or has no final ruling, state this clearly.
5. Do NOT add a "Sources" section at the end — sources are displayed separately by the UI.
6. Do NOT add concluding paragraphs summarizing or restating what was already said. End with the last case discussion.

WHEN NOT TO SEARCH:
- General legal knowledge questions — answer from your knowledge.
- Follow-up questions where the context already contains the answer.`;
}

const TRANSLATE_SUFFIX = `

IMPORTANT: Write your ENTIRE answer in English. Translate all Greek case excerpts to English. Keep original Greek case titles in parentheses.`;

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
          description: "Search query in Cypriot Greek or English legal terminology. Each search must use different query text — never repeat the same query.",
        },
        year_from: { type: "integer", description: "Filter: from this year" },
        year_to: { type: "integer", description: "Filter: up to this year" },
      },
      required: ["query"],
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
  court?: string,
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

function getSystem(translate: boolean): string {
  const prompt = buildSystemPrompt();
  return translate ? prompt + TRANSLATE_SUFFIX : prompt;
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
  if (message.includes("maximum context length")) return "The search returned too many documents. Try a more specific query.";
  if (message.includes("rate_limit") || message.includes("429")) return "The AI service is temporarily overloaded. Please wait and try again.";
  if (message.includes("timeout") || message.includes("ETIMEDOUT")) return "The request timed out. Please try again.";
  if (message.includes("401") || message.includes("auth")) return "API authentication error.";
  console.error("[LLM] API error:", message);
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

/**
 * Format summaries for LLM consumption — sorted by court level, relevance, year.
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

  return sorted
    .map((r, i) => {
      const courtLabel = COURT_NAMES[r.court] ?? r.court;
      return `══════════════════════════════════════════\n` +
        `[Case ${i + 1}] ${courtLabel} | ${r.year} | Relevance: ${r.relevance}\n` +
        `Document ID: ${r.docId}\n` +
        `══════════════════════════════════════════\n\n` +
        r.summary;
    })
    .join("\n\n");
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
   - If RULED: Quote the court's conclusion in original Greek + English translation.
   - If DISCUSSED: Describe what the court analyzed. Quote the most relevant passage.
   - If MENTIONED: Note the reference briefly.
   - If NOT ADDRESSED: Write "NOT ADDRESSED."
6. OUTCOME: What did the court order?
7. RELEVANCE RATING: Rate as HIGH / MEDIUM / LOW / NONE and explain in one sentence.

CRITICAL RULES:
- ONLY state what is EXPLICITLY written in the text.
- NEVER assume or infer a court's conclusion.
- Distinguish between what a PARTY ARGUED and what the COURT DECIDED.
- Include at least one EXACT QUOTE from the decision (in Greek) with English translation.
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
 * Search + summarize in one step.
 * 1. Run Vectorize search
 * 2. Deduplicate against already-summarized doc_ids
 * 3. Fetch full text from R2
 * 4. Summarize each document in parallel
 * 5. Filter out NONE relevance
 * 6. Sort by court level + relevance + year
 * 7. Return formatted summaries to LLM
 */
async function handleSearchAndSummarize(
  query: string,
  yearFrom: number | undefined,
  yearTo: number | undefined,
  searchFn: SearchFn,
  summarizedDocIds: Set<string>,
  allSources: SearchResult[],
  emit: (event: SSEYield) => void,
): Promise<{
  text: string;
  results: SummaryResult[];
  inputTokens: number;
  outputTokens: number;
}> {
  const fetchDoc = _fetchDocumentFn;

  // 1. Vectorize search
  const searchResults = await searchFn(query, undefined, yearFrom, yearTo);

  // 2. Deduplicate — skip already-summarized docs
  const newResults = searchResults.filter(
    (r) => r.doc_id && !summarizedDocIds.has(r.doc_id),
  );

  // Add to allSources for UI display
  for (const r of newResults) {
    if (!allSources.some((s) => s.doc_id === r.doc_id)) {
      allSources.push({ ...r, text: r.text.slice(0, 400) });
    }
  }

  if (newResults.length === 0 || !fetchDoc) {
    return { text: "No new results found for this query.", results: [], inputTokens: 0, outputTokens: 0 };
  }

  // Mark as summarized
  for (const r of newResults) {
    summarizedDocIds.add(r.doc_id);
  }

  emit({
    event: "summarizing",
    data: { count: newResults.length, focus: _lastUserQuery },
  });

  // 3. Fetch full texts in batches of 10 (avoid overwhelming R2/network)
  const FETCH_BATCH = 10;
  const docTexts: { id: string; text: string | null }[] = [];
  for (let i = 0; i < newResults.length; i += FETCH_BATCH) {
    const batch = newResults.slice(i, i + FETCH_BATCH);
    const batchTexts = await Promise.all(
      batch.map(async (r) => ({ id: r.doc_id, text: await fetchDoc(r.doc_id) })),
    );
    docTexts.push(...batchTexts);
  }

  // 4. Summarize in batches of 10 (avoid Worker timeout from too many parallel OpenAI calls)
  const SUMMARIZE_BATCH = 10;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const focus = _lastUserQuery;
  const docsToSummarize = docTexts.filter((d) => d.text !== null);
  const summaryResults: SummaryResult[] = [];

  for (let i = 0; i < docsToSummarize.length; i += SUMMARIZE_BATCH) {
    const batch = docsToSummarize.slice(i, i + SUMMARIZE_BATCH);
    const batchResults = await Promise.all(
      batch.map((d) => summarizeDocument(client, d.id, d.text!, focus, _lastUserQuery)),
    );
    summaryResults.push(...batchResults);
  }

  // Send summaries to UI for DocViewer
  emit({
    event: "summaries",
    data: summaryResults.map((r) => ({ docId: r.docId, summary: r.summary })),
  });

  // 5. Filter out NONE relevance, sort by court level + relevance + year, limit
  const relevant = summaryResults
    .filter((r) => r.relevance !== "NONE")
    .sort((a, b) => {
      const levelA = COURT_LEVEL_ORDER[a.courtLevel] ?? 4;
      const levelB = COURT_LEVEL_ORDER[b.courtLevel] ?? 4;
      if (levelA !== levelB) return levelA - levelB;
      const relA = RELEVANCE_ORDER[a.relevance] ?? 3;
      const relB = RELEVANCE_ORDER[b.relevance] ?? 3;
      if (relA !== relB) return relA - relB;
      return b.year - a.year;
    })
    .slice(0, MAX_RELEVANT_PER_SEARCH);

  // Log
  let totalIn = 0;
  let totalOut = 0;
  for (const r of summaryResults) {
    totalIn += r.inputTokens;
    totalOut += r.outputTokens;
  }

  console.log(JSON.stringify({
    event: "search_and_summarize",
    sessionId: _sessionId,
    query: query.slice(0, 200),
    yearFrom,
    yearTo,
    searched: searchResults.length,
    newDocs: newResults.length,
    summarized: summaryResults.length,
    relevant: relevant.length,
    filteredOut: summaryResults.length - relevant.length,
    inputTokens: totalIn,
    outputTokens: totalOut,
  }));

  // 6. Format for LLM (sorted by court level + relevance + year)
  const text = formatSummariesForLLM(relevant);

  return { text, results: summaryResults, inputTokens: totalIn, outputTokens: totalOut };
}

// ── Main Chat Stream ───────────────────────────────────

export function chatStream(
  messages: ChatMessage[],
  modelKey: string,
  translate: boolean,
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
        const system = getSystem(translate);
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

  const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...messages,
  ];

  const allSources: SearchResult[] = [];
  const summarizedDocIds = new Set<string>();
  let searchStep = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let summarizerInputTokens = 0;
  let summarizerOutputTokens = 0;
  let documentsAnalyzed = 0;

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
          emit({ event: "searching", data: { query: args.query ?? "", step: searchStep } });

          const result = await handleSearchAndSummarize(
            args.query ?? "",
            args.year_from,
            args.year_to,
            searchFn,
            summarizedDocIds,
            allSources,
            emit,
          );

          summarizerInputTokens += result.inputTokens;
          summarizerOutputTokens += result.outputTokens;
          documentsAnalyzed += result.results.length;

          apiMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result.text,
          });
        }
      }
      continue;
    }

    // No tool calls — stream the final answer
    if (allSources.length > 0) {
      emit({ event: "sources", data: allSources });
    }

    const stream = await client.chat.completions.create({
      model: modelCfg.modelId,
      messages: apiMessages,
      temperature: 0.1,
      stream: true,
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      if (chunk.choices[0]?.delta?.content) {
        emit({ event: "token", data: chunk.choices[0].delta.content });
      }
      if (chunk.usage) {
        totalInputTokens += chunk.usage.prompt_tokens;
        totalOutputTokens += chunk.usage.completion_tokens;
      }
    }

    const mainCost = calculateCost(modelCfg, totalInputTokens, totalOutputTokens);
    const summarizerCost = (summarizerInputTokens / 1_000_000) * 2.5 +
                           (summarizerOutputTokens / 1_000_000) * 10;
    const totalCost = mainCost + summarizerCost;

    console.log(JSON.stringify({
      event: "chat_complete",
      sessionId: _sessionId,
      provider: "openai",
      model: modelCfg.label,
      mainInputTokens: totalInputTokens,
      mainOutputTokens: totalOutputTokens,
      mainCostUsd: parseFloat(mainCost.toFixed(4)),
      summarizerDocsAnalyzed: documentsAnalyzed,
      summarizerInputTokens,
      summarizerOutputTokens,
      summarizerCostUsd: parseFloat(summarizerCost.toFixed(4)),
      totalCostUsd: parseFloat(totalCost.toFixed(4)),
      searchSteps: searchStep,
      sourcesFound: allSources.length,
    }));

    emit({
      event: "usage",
      data: {
        model: modelCfg.label,
        inputTokens: totalInputTokens + summarizerInputTokens,
        outputTokens: totalOutputTokens + summarizerOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens + summarizerInputTokens + summarizerOutputTokens,
        costUsd: totalCost,
        documentsAnalyzed,
      } as UsageData,
    });
    emit({ event: "done", data: {} });
    return;
  }

  // Exhausted rounds
  if (allSources.length > 0) emit({ event: "sources", data: allSources });
  console.log(JSON.stringify({
    event: "chat_exhausted_rounds",
    sessionId: _sessionId,
    provider: "openai",
    model: modelCfg.label,
    rounds: MAX_TOOL_ROUNDS,
    sourcesFound: allSources.length,
  }));
  emit({ event: "token", data: "I performed multiple searches but couldn't find a complete answer. Please try rephrasing your question." });
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

  const apiMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const allSources: SearchResult[] = [];
  const summarizedDocIds = new Set<string>();
  let searchStep = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let summarizerInputTokens = 0;
  let summarizerOutputTokens = 0;
  let documentsAnalyzed = 0;

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
          emit({ event: "searching", data: { query: (args.query as string) ?? "", step: searchStep } });

          const result = await handleSearchAndSummarize(
            (args.query as string) ?? "",
            args.year_from as number | undefined,
            args.year_to as number | undefined,
            searchFn,
            summarizedDocIds,
            allSources,
            emit,
          );

          summarizerInputTokens += result.inputTokens;
          summarizerOutputTokens += result.outputTokens;
          documentsAnalyzed += result.results.length;

          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result.text });
        }
      }

      apiMessages.push({ role: "user", content: toolResults });
      continue;
    }

    // Stream the answer
    if (allSources.length > 0) emit({ event: "sources", data: allSources });

    const stream = client.messages.stream({
      model: modelCfg.modelId,
      max_tokens: 8192,
      system,
      messages: apiMessages,
      temperature: 0.1,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        emit({ event: "token", data: event.delta.text });
      }
      if (event.type === "message_delta") {
        totalOutputTokens += event.usage.output_tokens;
      }
    }

    const finalMessage = await stream.finalMessage();
    totalInputTokens += finalMessage.usage.input_tokens;

    const mainCost = calculateCost(modelCfg, totalInputTokens, totalOutputTokens);
    const summarizerCost = (summarizerInputTokens / 1_000_000) * 2.5 +
                           (summarizerOutputTokens / 1_000_000) * 10;
    const totalCost = mainCost + summarizerCost;

    console.log(JSON.stringify({
      event: "chat_complete",
      sessionId: _sessionId,
      provider: "anthropic",
      model: modelCfg.label,
      mainInputTokens: totalInputTokens,
      mainOutputTokens: totalOutputTokens,
      mainCostUsd: parseFloat(mainCost.toFixed(4)),
      summarizerDocsAnalyzed: documentsAnalyzed,
      summarizerInputTokens,
      summarizerOutputTokens,
      summarizerCostUsd: parseFloat(summarizerCost.toFixed(4)),
      totalCostUsd: parseFloat(totalCost.toFixed(4)),
      searchSteps: searchStep,
      sourcesFound: allSources.length,
    }));

    emit({
      event: "usage",
      data: {
        model: modelCfg.label,
        inputTokens: totalInputTokens + summarizerInputTokens,
        outputTokens: totalOutputTokens + summarizerOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens + summarizerInputTokens + summarizerOutputTokens,
        costUsd: totalCost,
        documentsAnalyzed,
      } as UsageData,
    });
    emit({ event: "done", data: {} });
    return;
  }

  if (allSources.length > 0) emit({ event: "sources", data: allSources });
  console.log(JSON.stringify({
    event: "chat_exhausted_rounds",
    sessionId: _sessionId,
    provider: "anthropic",
    model: modelCfg.label,
    rounds: MAX_TOOL_ROUNDS,
    sourcesFound: allSources.length,
  }));
  emit({ event: "token", data: "Multiple searches performed but no complete answer found." });
  emit({ event: "done", data: {} });
}

/** Phase 1 stub for production (until Vectorize is connected) */
export const stubSearchFn: SearchFn = async () => [];
