/**
 * Agentic LLM client with multi-agent summarization.
 *
 * Flow:
 *   1. Main LLM calls search_cases → gets document metadata (no full text)
 *   2. Main LLM calls summarize_documents → parallel GPT-4o-mini summarizes each doc
 *   3. Main LLM composes final answer from summaries
 *
 * This avoids context overflow and is ~6x cheaper than sending full docs.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ModelConfig, SearchResult, UsageData } from "./types";
import { MODELS } from "./types";

const MAX_TOOL_ROUNDS = 7;
const SUMMARIZER_MODEL = "gpt-4o";
const SUMMARIZER_MAX_TOKENS = 2000;

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
2. Do multiple searches with DIFFERENT query texts covering different angles or synonyms. NEVER repeat the same query — each search must use distinct terms or phrasing.
3. Also search in English when relevant (JSC collection, older Supreme Court).
4. NEVER use the court filter parameter. The search returns relevant cases from ALL courts automatically. If the user mentions specific courts, include those terms in your query TEXT instead.
5. Use year_from/year_to filters when the user specifies a time range.

WORKFLOW — you have two tools:
1. **search_cases**: Find relevant cases. Returns metadata (title, court, year, score) but NOT full text.
2. **summarize_documents**: After search, call this with the doc_ids to get AI-generated summaries of each case focused on the user's question. This is how you read the cases.

ALWAYS follow this sequence:
1. Call search_cases with your query
2. Review the metadata results
3. Call summarize_documents with the relevant doc_ids and your analysis instructions
4. Use the summaries to compose your answer

RESPONSE FORMAT:
1. Answer in the SAME LANGUAGE as the user's question.
2. Cite ALL relevant cases — do not limit to 2-3.
3. When mentioning a case in your answer text, ALWAYS make the case name a clickable link using this format:
   [CASE_TITLE](/doc?doc_id=DOCUMENT_ID)
   Example: [E.R ν. P.R (Family Court, 2024)](/doc?doc_id=apofaseised/oik/2024/2320240403.md)
4. NEVER use empty links like [title](#) or [title](). Every case reference must link to its document.
5. End with a "Sources" section listing ALL cases with links.
6. If a case is still pending or has no final ruling, state this clearly — do not present interim orders as final decisions.
7. Suggest follow-up questions if helpful.

WHEN NOT TO SEARCH:
- General legal knowledge questions — answer from your knowledge.
- Follow-up questions where the context already contains the answer.`;
}

const TRANSLATE_SUFFIX = `

IMPORTANT: Write your ENTIRE answer in English. Translate all Greek case excerpts to English. Keep original Greek case titles in parentheses.`;

// ── Tool Definitions ───────────────────────────────────

const SEARCH_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_cases",
    description:
      "Search the Cypriot court case database. Returns case metadata (title, court, year, relevance score) but NOT full text. After reviewing results, use summarize_documents to read the actual cases.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query in Cypriot Greek legal terminology. Include court names in the query text if needed (e.g., 'Εφετείο', 'Ανώτατο Δικαστήριο'). Each search must use different query text — never repeat the same query.",
        },
        year_from: { type: "integer", description: "Filter: from this year" },
        year_to: { type: "integer", description: "Filter: up to this year" },
      },
      required: ["query"],
    },
  },
};

const SUMMARIZE_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "summarize_documents",
    description:
      "Analyze and summarize court case documents. Provide doc_ids from search results and instructions on what to focus on. Each document will be read and summarized by a specialized agent.",
    parameters: {
      type: "object",
      properties: {
        doc_ids: {
          type: "array",
          items: { type: "string" },
          description: "Document IDs from search_cases results to analyze.",
        },
        focus: {
          type: "string",
          description: "What to focus on when summarizing — the legal issues, principles, or aspects relevant to the user's question.",
        },
      },
      required: ["doc_ids", "focus"],
    },
  },
};

const CLAUDE_SEARCH_TOOL: Anthropic.Tool = {
  name: "search_cases",
  description: SEARCH_TOOL.function.description ?? "",
  input_schema: SEARCH_TOOL.function.parameters as Anthropic.Tool.InputSchema,
};

const CLAUDE_SUMMARIZE_TOOL: Anthropic.Tool = {
  name: "summarize_documents",
  description: SUMMARIZE_TOOL.function.description ?? "",
  input_schema: SUMMARIZE_TOOL.function.parameters as Anthropic.Tool.InputSchema,
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
  event: "searching" | "sources" | "summarizing" | "token" | "done" | "error" | "usage";
  data: unknown;
}

// ── Utilities ──────────────────────────────────────────

function getSystem(translate: boolean): string {
  const prompt = buildSystemPrompt();
  return translate ? prompt + TRANSLATE_SUFFIX : prompt;
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found for this query.";
  return results
    .map(
      (r, i) =>
        `[Case ${i + 1}] ${r.title}\n` +
        `Court: ${r.court} | Year: ${r.year} | Relevance: ${r.score}%\n` +
        `Document ID: ${r.doc_id}`,
    )
    .join("\n\n");
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

// ── Summarizer Agent ───────────────────────────────────

/**
 * Extract the actual court decision text, stripping references and metadata.
 * Then smart-truncate if still too long: keep beginning + end (where ruling is).
 */
function extractDecisionText(text: string, maxChars: number): string {
  // Find "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:" marker — everything after it is the decision
  const decisionMarker = "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:";
  const markerIdx = text.indexOf(decisionMarker);

  let decisionText: string;
  let title = "";

  // Extract title (first line)
  const firstNewline = text.indexOf("\n");
  if (firstNewline > 0) {
    title = text.slice(0, firstNewline).trim() + "\n\n";
  }

  if (markerIdx !== -1) {
    // Found marker — take title + everything after the marker
    decisionText = title + text.slice(markerIdx + decisionMarker.length).trim();
  } else {
    // No marker (e.g. Areios Pagos) — use full text
    decisionText = text;
  }

  // If it fits, return as-is
  if (decisionText.length <= maxChars) return decisionText;

  // Still too long — keep beginning (facts/parties) + end (ruling/conclusion)
  // Give MORE to the tail because the court's actual ruling is always at the end
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
): Promise<{ docId: string; summary: string; inputTokens: number; outputTokens: number }> {
  const systemPrompt = `You are a legal analyst summarizing a Cypriot court decision for a lawyer's research.

The lawyer's research question: "${userQuery}"
Analysis focus: "${focus}"

Summarize this court decision in 400-700 words:

1. CASE HEADER: Parties, court, date, case number (2 lines max)
2. STATUS: Final decision (ΑΠΟΦΑΣΗ) or interim (ΕΝΔΙΑΜΕΣΗ ΑΠΟΦΑΣΗ)?
3. FACTS: Brief background — what happened, who sued whom, what was claimed (3-4 sentences)
4. COURT'S FINDINGS on "${focus}":
   - What did the court say about this topic? Quote the key passage in original Greek.
   - Translate the quote to English.
   - If the court discussed this topic indirectly (e.g. in obiter dicta or as part of a broader ruling), still include it.
   - If the court did not address this topic, write: "The court did not directly address ${focus} in this decision."
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

  return {
    docId,
    summary: response.choices[0]?.message?.content ?? "[Summary unavailable]",
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

// ── Fetch + Summarize handler ──────────────────────────

let _fetchDocumentFn: FetchDocumentFn | null = null;
let _lastUserQuery = "";

export function setFetchDocumentFn(fn: FetchDocumentFn) {
  _fetchDocumentFn = fn;
}

export function setLastUserQuery(query: string) {
  _lastUserQuery = query;
}

async function handleSummarizeDocuments(
  args: { doc_ids: string[]; focus: string },
  emit: (event: SSEYield) => void,
): Promise<{ text: string; inputTokens: number; outputTokens: number; docCount: number }> {
  const fetchDoc = _fetchDocumentFn;
  if (!fetchDoc) {
    return { text: "Document fetching is not available.", inputTokens: 0, outputTokens: 0, docCount: 0 };
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const docIds = args.doc_ids.slice(0, 10); // Max 10 docs

  emit({
    event: "summarizing",
    data: { count: docIds.length, focus: args.focus },
  });

  // Fetch all documents in parallel
  const docTexts = await Promise.all(
    docIds.map(async (id) => ({ id, text: await fetchDoc(id) })),
  );

  // Summarize all documents in parallel
  const summaryResults = await Promise.all(
    docTexts
      .filter((d) => d.text !== null)
      .map((d) =>
        summarizeDocument(client, d.id, d.text!, args.focus, _lastUserQuery),
      ),
  );

  let totalIn = 0;
  let totalOut = 0;
  const parts: string[] = [];

  for (const result of summaryResults) {
    totalIn += result.inputTokens;
    totalOut += result.outputTokens;
    parts.push(
      `══════════════════════════════════════════\n` +
      `Document ID: ${result.docId}\n` +
      `══════════════════════════════════════════\n\n` +
      result.summary,
    );
  }

  const summarizerCost = (totalIn / 1_000_000) * 2.5 + (totalOut / 1_000_000) * 10;
  console.log(
    `[Summarizer] ${summaryResults.length} docs, in=${totalIn} out=${totalOut} cost=$${summarizerCost.toFixed(4)}`,
  );

  return {
    text: parts.join("\n\n"),
    inputTokens: totalIn,
    outputTokens: totalOut,
    docCount: summaryResults.length,
  };
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

  // Extract user query for summarizer context
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
      tools: [SEARCH_TOOL, SUMMARIZE_TOOL],
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

          const results = await searchFn(
            args.query ?? "", args.court, args.year_from, args.year_to,
          );

          for (const r of results) {
            if (r.doc_id && !allSources.some((s) => s.doc_id === r.doc_id)) {
              allSources.push({ ...r, text: r.text.slice(0, 400) });
            }
          }

          apiMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: formatSearchResults(results),
          });
        } else if (toolCall.function.name === "summarize_documents") {
          const result = await handleSummarizeDocuments(args, emit);
          summarizerInputTokens += result.inputTokens;
          summarizerOutputTokens += result.outputTokens;
          documentsAnalyzed += result.docCount;

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

    console.log(
      `[LLM] main: ${modelCfg.label} in=${totalInputTokens} out=${totalOutputTokens} cost=$${mainCost.toFixed(4)} | ` +
      `summarizer: ${documentsAnalyzed} docs in=${summarizerInputTokens} out=${summarizerOutputTokens} cost=$${summarizerCost.toFixed(4)} | ` +
      `total=$${totalCost.toFixed(4)}`,
    );

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
      tools: [CLAUDE_SEARCH_TOOL, CLAUDE_SUMMARIZE_TOOL],
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

          const results = await searchFn(
            (args.query as string) ?? "",
            args.court as string | undefined,
            args.year_from as number | undefined,
            args.year_to as number | undefined,
          );

          for (const r of results) {
            if (r.doc_id && !allSources.some((s) => s.doc_id === r.doc_id)) {
              allSources.push({ ...r, text: r.text.slice(0, 400) });
            }
          }

          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: formatSearchResults(results) });
        } else if (toolUse.name === "summarize_documents") {
          const result = await handleSummarizeDocuments(
            { doc_ids: args.doc_ids as string[], focus: args.focus as string },
            emit,
          );
          summarizerInputTokens += result.inputTokens;
          summarizerOutputTokens += result.outputTokens;
          documentsAnalyzed += result.docCount;

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

    emit({
      event: "usage",
      data: {
        model: modelCfg.label,
        inputTokens: totalInputTokens + summarizerInputTokens,
        outputTokens: totalOutputTokens + summarizerOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens + summarizerInputTokens + summarizerOutputTokens,
        costUsd: mainCost + summarizerCost,
        documentsAnalyzed,
      } as UsageData,
    });
    emit({ event: "done", data: {} });
    return;
  }

  if (allSources.length > 0) emit({ event: "sources", data: allSources });
  emit({ event: "token", data: "Multiple searches performed but no complete answer found." });
  emit({ event: "done", data: {} });
}

/** Phase 1 stub for production (until Vectorize is connected) */
export const stubSearchFn: SearchFn = async () => [];
