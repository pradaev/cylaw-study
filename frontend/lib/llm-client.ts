/**
 * Agentic LLM client with function calling for court case search.
 *
 * The LLM decides when to search the case database using the search_cases
 * tool. Supports multi-step reasoning (search -> analyze -> search again).
 * Streams the final answer as SSE events. Tracks token usage and cost.
 *
 * Ported from rag/llm_client.py
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ModelConfig, SearchResult, UsageData } from "./types";
import { MODELS } from "./types";

const MAX_TOOL_ROUNDS = 5;

const SYSTEM_PROMPT = `You are an expert legal research assistant specializing in Cypriot law and court cases. You are deeply knowledgeable about the Cypriot legal system, its courts, terminology, and procedures. You have access to a database of 150,000+ court decisions spanning 1960-2026.

CYPRIOT COURT SYSTEM (your knowledge base covers these courts):
- Ανώτατο Δικαστήριο (old Supreme Court, "aad") — 35,485 decisions (1961-2024). The largest collection. Divided into 4 parts: meros_1 (criminal), meros_2 (civil), meros_3 (labour/land), meros_4 (administrative law). Cases cited as "CLR" (Cyprus Law Reports) or "ΑΑΔ" (Αποφάσεις Ανωτάτου Δικαστηρίου).
- Άρειος Πάγος (Areios Pagos, "areiospagos") — 46,159 decisions (1968-2026). Supreme cassation court.
- Πρωτόδικα Δικαστήρια (First Instance Courts, "apofaseised") — 37,840 decisions (2005-2026). 5 categories: civil, criminal, family, rental, labour.
- Νέο Ανώτατο Δικαστήριο (new Supreme Court, "supreme") — 1,028 decisions (2023-2026). Replaced the old Supreme Court after the 2022 judicial reform.
- Εφετείο (Court of Appeal, "courtOfAppeal") — 1,111 decisions (2004-2026). Handles civil and criminal appeals.
- Ανώτατο Συνταγματικό Δικαστήριο (Supreme Constitutional Court, "supremeAdministrative") — 420 decisions (2023-2026). Constitutional review.
- Διοικητικό Δικαστήριο (Administrative Court, "administrative") — 5,782 decisions (2016-2026). Reviews administrative acts under Article 146 of the Constitution.
- Διοικητικό Δικαστήριο Διεθνούς Προστασίας (Admin Court for International Protection, "administrativeIP") — 6,889 decisions (2018-2026). Asylum and refugee cases.
- Επιτροπή Προστασίας Ανταγωνισμού (Competition Commission, "epa") — 785 decisions (2002-2025).
- Αναθεωρητική Αρχή Προσφορών (Tender Review Authority, "aap") — 2,596 decisions (2004-2025). Public procurement disputes.
- Judgments of the Supreme Court (JSC, "jsc") — 2,429 decisions in English (1964-1988).
- Ανώτατο Συνταγματικό Δικαστήριο 1960-1963 (RSCC, "rscc") — 122 decisions in English.
- Διοικητικό Εφετείο (Admin Court of Appeal, "administrativeCourtOfAppeal") — 69 decisions (2025-2026).
- Δικαστήριο Παίδων (Juvenile Court, "juvenileCourt") — 11 decisions (2023-2025).

KEY LEGAL CONCEPTS you should know:
- Article 146 of the Constitution — basis for judicial review of administrative acts (προσφυγή). Most administrative court cases cite this.
- Αρχή της νομιμότητας — principle of legality
- Ακύρωση διοικητικής πράξης — annulment of administrative act
- Υπέρβαση εξουσίας — excess of power
- Αιτιολογία — reasoning/justification of administrative decisions
- Πολιτική Έφεση — civil appeal, Ποινική Έφεση — criminal appeal
- Εφεση κατά απόφασης — appeal against decision

SEARCH STRATEGY:
1. ALWAYS search in Greek legal terminology first — the vast majority of cases are in Greek. For example, if user asks about "unfair dismissal", search for "αδικαιολόγητη απόλυση" or "παράνομη απόλυση".
2. Then search in English if relevant (older Supreme Court cases have English text).
3. Use specific legal terms, article numbers, or case names when possible.
4. You may call search_cases multiple times with different queries to cover different angles.
5. Filter by court when the legal domain is clear (e.g., administrative law -> court="administrative").

HOW TO HELP USERS FORMULATE QUERIES:
- If the user's request is vague or uses incorrect terminology, ask 1-2 clarifying questions BEFORE searching.
- Suggest the correct Greek legal terms when relevant.
- After providing an answer, suggest 2-3 follow-up questions the user might want to explore.

RESPONSE FORMAT:
1. Answer in the SAME LANGUAGE as the user's question.
2. Start with a direct, concise answer.
3. Support with specific case citations: *CASE_TITLE* (Court, Year).
4. Quote relevant passages in quotation marks.
5. End with a "Sources" section listing all cited cases.
6. If helpful, suggest follow-up questions.

WHEN NOT TO SEARCH:
- General legal knowledge questions ("what is Article 146?") — answer from your knowledge.
- Follow-up questions where the context already contains the answer.
- When the user is asking for clarification about your previous response.
- When the user asks about the structure of the legal system itself.`;

const TRANSLATE_SUFFIX = `

IMPORTANT: Write your ENTIRE answer in English. Translate all Greek case excerpts and quotes to English. Keep original Greek case titles in parentheses for reference.`;

/** OpenAI function calling tool definition */
const SEARCH_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_cases",
    description:
      "Search the Cypriot court case database by semantic similarity. Use Greek legal terms for best results. You can call this multiple times with different queries.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query — use specific legal terms, case names, or article references. Greek queries often yield better results for Greek case law.",
        },
        court: {
          type: "string",
          description: "Filter by court ID",
          enum: [
            "aad", "supreme", "courtOfAppeal", "supremeAdministrative",
            "administrative", "administrativeIP", "epa", "aap", "dioikitiko",
            "areiospagos", "apofaseised", "jsc", "rscc",
            "administrativeCourtOfAppeal", "juvenileCourt",
          ],
        },
        year_from: {
          type: "integer",
          description: "Filter: cases from this year onward",
        },
        year_to: {
          type: "integer",
          description: "Filter: cases up to this year",
        },
      },
      required: ["query"],
    },
  },
};

/** Anthropic tool definition (different format) */
const CLAUDE_SEARCH_TOOL: Anthropic.Tool = {
  name: "search_cases",
  description: SEARCH_TOOL.function.description ?? "",
  input_schema: SEARCH_TOOL.function.parameters as Anthropic.Tool.InputSchema,
};

export type SearchFn = (
  query: string,
  court?: string,
  yearFrom?: number,
  yearTo?: number,
) => Promise<SearchResult[]>;

interface SSEYield {
  event: "searching" | "sources" | "token" | "done" | "error" | "usage";
  data: unknown;
}

function getSystem(translate: boolean): string {
  return translate ? SYSTEM_PROMPT + TRANSLATE_SUFFIX : SYSTEM_PROMPT;
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No results found for this query.";
  }
  return results
    .map(
      (r, i) =>
        `══════════════════════════════════════════\n` +
        `[Case ${i + 1}] ${r.title}\n` +
        `Court: ${r.court} | Year: ${r.year} | Relevance: ${r.score}%\n` +
        `Document ID: ${r.doc_id}\n` +
        `══════════════════════════════════════════\n\n` +
        `${r.text}`,
    )
    .join("\n\n");
}

function calculateCost(
  modelCfg: ModelConfig,
  inputTokens: number,
  outputTokens: number,
): number {
  const inputCost = (inputTokens / 1_000_000) * modelCfg.pricing.input;
  const outputCost = (outputTokens / 1_000_000) * modelCfg.pricing.output;
  return inputCost + outputCost;
}

/**
 * Stream a chat response with function calling.
 * Emits usage/cost data at the end.
 */
export function chatStream(
  messages: ChatMessage[],
  modelKey: string,
  translate: boolean,
  searchFn: SearchFn,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const modelCfg = MODELS[modelKey];

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
        const message = err instanceof Error ? err.message : String(err);
        emit({ event: "error", data: message.slice(0, 300) });
      }

      controller.close();
    },
  });
}

async function streamOpenAI(
  messages: ChatMessage[],
  modelCfg: ModelConfig,
  system: string,
  searchFn: SearchFn,
  emit: (event: SSEYield) => void,
) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...messages,
  ];

  const allSources: SearchResult[] = [];
  let searchStep = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
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
        if (toolCall.function.name === "search_cases") {
          const args = JSON.parse(toolCall.function.arguments);
          searchStep++;

          emit({
            event: "searching",
            data: { query: args.query ?? "", step: searchStep },
          });

          const results = await searchFn(
            args.query ?? "",
            args.court,
            args.year_from,
            args.year_to,
          );

          const resultsText = formatSearchResults(results);
          documentsAnalyzed += results.length;

          for (const r of results) {
            if (!allSources.some((s) => s.doc_id === r.doc_id)) {
              allSources.push({ ...r, text: r.text.slice(0, 400) });
            }
          }

          apiMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: resultsText,
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
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        emit({ event: "token", data: delta.content });
      }
      if (chunk.usage) {
        totalInputTokens += chunk.usage.prompt_tokens;
        totalOutputTokens += chunk.usage.completion_tokens;
      }
    }

    const costUsd = calculateCost(modelCfg, totalInputTokens, totalOutputTokens);
    const usage: UsageData = {
      model: modelCfg.label,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      costUsd,
      documentsAnalyzed,
    };

    console.log(
      `[LLM] model=${modelCfg.label} docs=${documentsAnalyzed} in=${totalInputTokens} out=${totalOutputTokens} total=${totalInputTokens + totalOutputTokens} cost=$${costUsd.toFixed(4)}`,
    );

    emit({ event: "usage", data: usage });
    emit({ event: "done", data: {} });
    return;
  }

  // Exhausted rounds
  const costUsd = calculateCost(modelCfg, totalInputTokens, totalOutputTokens);
  emit({ event: "usage", data: { model: modelCfg.label, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens: totalInputTokens + totalOutputTokens, costUsd, documentsAnalyzed } as UsageData });

  if (allSources.length > 0) {
    emit({ event: "sources", data: allSources });
  }
  emit({
    event: "token",
    data: "I performed multiple searches but couldn't find a complete answer. Please try rephrasing your question.",
  });
  emit({ event: "done", data: {} });
}

async function streamClaude(
  messages: ChatMessage[],
  modelCfg: ModelConfig,
  system: string,
  searchFn: SearchFn,
  emit: (event: SSEYield) => void,
) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const apiMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const allSources: SearchResult[] = [];
  let searchStep = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
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
        if (toolUse.name === "search_cases") {
          const args = toolUse.input as Record<string, unknown>;
          searchStep++;

          emit({
            event: "searching",
            data: { query: (args.query as string) ?? "", step: searchStep },
          });

          const results = await searchFn(
            (args.query as string) ?? "",
            args.court as string | undefined,
            args.year_from as number | undefined,
            args.year_to as number | undefined,
          );

          const resultsText = formatSearchResults(results);
          documentsAnalyzed += results.length;

          for (const r of results) {
            if (!allSources.some((s) => s.doc_id === r.doc_id)) {
              allSources.push({ ...r, text: r.text.slice(0, 400) });
            }
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: resultsText,
          });
        }
      }

      apiMessages.push({ role: "user", content: toolResults });
      continue;
    }

    // No tool use — stream the answer
    if (allSources.length > 0) {
      emit({ event: "sources", data: allSources });
    }

    const stream = client.messages.stream({
      model: modelCfg.modelId,
      max_tokens: 8192,
      system,
      messages: apiMessages,
      temperature: 0.1,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        emit({ event: "token", data: event.delta.text });
      }
      if (event.type === "message_delta") {
        totalOutputTokens += event.usage.output_tokens;
      }
    }

    const finalMessage = await stream.finalMessage();
    totalInputTokens += finalMessage.usage.input_tokens;

    const costUsd = calculateCost(modelCfg, totalInputTokens, totalOutputTokens);
    const usage: UsageData = {
      model: modelCfg.label,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      costUsd,
      documentsAnalyzed,
    };

    console.log(
      `[LLM] model=${modelCfg.label} docs=${documentsAnalyzed} in=${totalInputTokens} out=${totalOutputTokens} total=${totalInputTokens + totalOutputTokens} cost=$${costUsd.toFixed(4)}`,
    );

    emit({ event: "usage", data: usage });
    emit({ event: "done", data: {} });
    return;
  }

  // Exhausted rounds
  const costUsd = calculateCost(modelCfg, totalInputTokens, totalOutputTokens);
  emit({ event: "usage", data: { model: modelCfg.label, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens: totalInputTokens + totalOutputTokens, costUsd, documentsAnalyzed } as UsageData });

  if (allSources.length > 0) {
    emit({ event: "sources", data: allSources });
  }
  emit({
    event: "token",
    data: "Multiple searches performed but no complete answer found.",
  });
  emit({ event: "done", data: {} });
}

/**
 * Phase 1 stub: returns empty results with an informational message.
 * Replace with real Vectorize-backed search in Phase 2.
 */
export const stubSearchFn: SearchFn = async () => {
  return [];
};
