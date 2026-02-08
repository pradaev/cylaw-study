"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { MessageBubble } from "./MessageBubble";
import { DocViewer } from "./DocViewer";
import type { ChatMessage, SearchResult, UsageData, ActivityEntry, SummaryEntry } from "@/lib/types";
import { MODELS } from "@/lib/types";

interface AssistantState {
  content: string;
  sources: SearchResult[];
  activityLog: ActivityEntry[];
  isStreaming: boolean;
  usage: UsageData | null;
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  sources?: SearchResult[];
  activityLog?: ActivityEntry[];
  usage?: UsageData | null;
}

const EXAMPLE_QUERIES = [
  "Βρες τις κυρίες αποφάσεις του Ανώτατου Δικαστηρίου που αναλύουν τις βασικές αρχές για την τροποποίηση δικογράφου μετά την καταχώρηση.",
  "Βρες αποφάσεις σχετικά με την αποκλειστική χρήση κατοικίας από ένα σύζυγο.",
  "Βρες αποφάσεις σχετικά με το άρθρο 47 του περί Αστικών Αδικημάτων Νόμου ΚΕΦ. 148",
  "Η εφαρμογή του αλλοδαπού δικαίου σε υποθέσεις περιουσιακών διαφορών στο πλαίσιο διαδικασιών διαζυγίου κατά την τελευταία πενταετία",
  "Πώς εφαρμόζουν τα δικαστήρια το τεκμήριο του ενός τρίτου σε υποθέσεις περιουσιακών διαφορών σε διαζύγια;",
];

function addActivity(
  prev: AssistantState,
  type: ActivityEntry["type"],
  text: string,
): AssistantState {
  return {
    ...prev,
    activityLog: [
      ...prev.activityLog,
      { type, text, timestamp: Date.now() },
    ],
  };
}

export function ChatArea() {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("gpt-4o");
  const [isStreaming, setIsStreaming] = useState(false);
  const [docViewerId, setDocViewerId] = useState<string | null>(null);
  const [assistant, setAssistant] = useState<AssistantState>({
    content: "",
    sources: [],
    activityLog: [],
    isStreaming: false,
    usage: null,
  });

  // Stores summarizer output per doc_id — survives across messages
  const [summaryCache, setSummaryCache] = useState<Record<string, string>>({});

  // Stable session ID for logging — persists across messages within a page session
  const sessionId = useMemo(() => crypto.randomUUID(), []);

  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // No auto-scroll — let the user control scroll position

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      e.target.style.height = "auto";
      e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
    },
    [],
  );

  const sendMessage = useCallback(
    async (text?: string) => {
      const messageText = text ?? input.trim();
      if (!messageText || isStreaming) return;

      const selectedModel = MODELS[model];
      const modelLabel = selectedModel?.label ?? model;

      setInput("");
      setIsStreaming(true);

      const userMsg: HistoryMessage = { role: "user", content: messageText };
      setMessages((prev) => [...prev, userMsg]);

      const apiMessages: ChatMessage[] = [
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: messageText },
      ];

      // Initialize with first activity entry
      setAssistant({
        content: "",
        sources: [],
        activityLog: [
          { type: "sending", text: `Αποστολή στο ${modelLabel}...`, timestamp: Date.now() },
        ],
        isStreaming: true,
        usage: null,
      });

      let lastUsage: UsageData | null = null;
      let lastActivityLog: ActivityEntry[] = [
        { type: "sending", text: `Αποστολή στο ${modelLabel}...`, timestamp: Date.now() },
      ];

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: apiMessages, model, sessionId }),
        });

        // Update: request sent, model is thinking
        setAssistant((prev) => {
          const updated = addActivity(prev, "thinking", `Το ${modelLabel} αναλύει το ερώτημά σας...`);
          lastActivityLog = updated.activityLog;
          return updated;
        });

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";
        let answerText = "";
        let currentSources: SearchResult[] = [];
        let currentEvent = "";
        let searchCount = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7);
            } else if (line.startsWith("data: ") && currentEvent) {
              const data = line.slice(6);

              switch (currentEvent) {
                case "searching": {
                  const searchData = JSON.parse(data);
                  searchCount++;
                  // Build search info string with filters
                  const filters: string[] = [];
                  if (searchData.courtLevel) {
                    const courtLabels: Record<string, string> = { supreme: "Ανώτατο", appeal: "Εφετείο" };
                    filters.push(courtLabels[searchData.courtLevel] ?? searchData.courtLevel);
                  }
                  if (searchData.yearFrom || searchData.yearTo) {
                    filters.push(`${searchData.yearFrom ?? "..."}-${searchData.yearTo ?? "..."}`);
                  }
                  const filterStr = filters.length > 0 ? ` [${filters.join(", ")}]` : "";

                  setAssistant((prev) => {
                    // Add search line
                    let updated = addActivity(
                      prev,
                      "searching",
                      `Αναζήτηση #${searchData.step}: "${searchData.query}"${filterStr}`,
                    );
                    // Add legal context if present
                    if (searchData.legalContext && searchData.step === 1) {
                      updated = addActivity(
                        updated,
                        "thinking",
                        `Νομικό πλαίσιο: ${searchData.legalContext}`,
                      );
                    }
                    lastActivityLog = updated.activityLog;
                    return updated;
                  });
                  break;
                }
                case "sources": {
                  const sources: SearchResult[] = JSON.parse(data);
                  currentSources = sources;
                  setAssistant((prev) => ({
                    ...prev,
                    sources,
                  }));
                  break;
                }
                case "summarizing": {
                  const sumData = JSON.parse(data) as { count: number; focus: string };
                  setAssistant((prev) => {
                    const updated = addActivity(
                      prev,
                      "analyzing",
                      `Ανάλυση ${sumData.count} αποφάσεων...`,
                    );
                    lastActivityLog = updated.activityLog;
                    return updated;
                  });
                  break;
                }
                case "summaries": {
                  const entries = JSON.parse(data) as SummaryEntry[];
                  setSummaryCache((prev) => {
                    const next = { ...prev };
                    for (const entry of entries) {
                      next[entry.docId] = entry.summary;
                    }
                    return next;
                  });
                  break;
                }
                case "token": {
                  const token = data.replace(/\\n/g, "\n");
                  if (!answerText) {
                    setAssistant((prev) => {
                      const updated = addActivity(prev, "writing", "Σύνταξη απάντησης...");
                      lastActivityLog = updated.activityLog;
                      return updated;
                    });
                  }
                  answerText += token;
                  setAssistant((prev) => ({
                    ...prev,
                    content: answerText,
                  }));
                  break;
                }
                case "usage": {
                  lastUsage = JSON.parse(data) as UsageData;
                  setAssistant((prev) => ({
                    ...prev,
                    usage: lastUsage,
                  }));
                  break;
                }
                case "done": {
                  setAssistant((prev) => ({
                    ...prev,
                    isStreaming: false,
                  }));
                  break;
                }
                case "error": {
                  const errorMsg = data.replace(/\\n/g, "\n");
                  answerText = errorMsg;
                  setAssistant((prev) => {
                    const updated = addActivity(prev, "found", `Σφάλμα: ${errorMsg.slice(0, 80)}`);
                    lastActivityLog = updated.activityLog;
                    return {
                      ...updated,
                      content: `**Κάτι πήγε στραβά:** ${errorMsg}`,
                      isStreaming: false,
                    };
                  });
                  break;
                }
              }
              currentEvent = "";
            }
          }
        }

        if (answerText || currentSources.length > 0) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: answerText,
              sources: currentSources,
              activityLog: lastActivityLog,
              usage: lastUsage,
            },
          ]);
          setAssistant({
            content: "",
            sources: [],
            activityLog: [],
            isStreaming: false,
            usage: null,
          });
        }
      } catch (err) {
        setAssistant((prev) => ({
          ...prev,
          content: `Σφάλμα: ${err instanceof Error ? err.message : "Άγνωστο σφάλμα"}`,
          isStreaming: false,
        }));
      }

      setIsStreaming(false);
      inputRef.current?.focus();
    },
    [input, isStreaming, messages, model],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  const newChat = useCallback(() => {
    setMessages([]);
    setAssistant({
      content: "",
      sources: [],
      activityLog: [],
      isStreaming: false,
      usage: null,
    });
  }, []);

  const showWelcome = messages.length === 0 && !assistant.isStreaming;

  return (
    <>
      <header className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-white shrink-0">
        <h1 className="text-base font-bold text-gray-900">Κυπριακή Νομολογία</h1>
        <div className="flex items-center gap-3">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="bg-gray-50 border border-gray-300 rounded-md px-2.5 py-1.5 text-xs text-gray-900 cursor-pointer"
          >
            {Object.entries(MODELS).map(([key, cfg]) => (
              <option key={key} value={key}>
                {cfg.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={newChat}
            className="text-xs text-gray-500 border border-gray-300 rounded-md px-2.5 py-1.5 hover:border-indigo-500 hover:text-gray-900 transition-colors"
          >
            Νέα συνομιλία
          </button>
        </div>
      </header>

      <div ref={chatRef} className="flex-1 overflow-y-auto px-5 py-6 scroll-smooth">
        {showWelcome && (
          <div className="text-center py-16 text-gray-500">
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Κυπριακή Νομολογία
            </h2>
            <p className="text-base mb-6">
              Αναζήτηση σε 150.000+ κυπριακές δικαστικές αποφάσεις
            </p>
            <div className="flex flex-wrap gap-2 justify-center max-w-2xl mx-auto">
              {EXAMPLE_QUERIES.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => sendMessage(q)}
                  className="bg-gray-50 border border-gray-200 rounded-lg text-gray-600 px-3.5 py-2.5 text-sm text-left leading-snug max-w-[280px] hover:border-indigo-400 hover:text-gray-900 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            role={msg.role}
            content={msg.content}
            sources={msg.sources}
            summaryCache={summaryCache}
            activityLog={msg.activityLog}
            usage={msg.usage}
            onSourceClick={setDocViewerId}
          />
        ))}

        {(assistant.isStreaming || assistant.content || assistant.sources.length > 0) && (
          <MessageBubble
            role="assistant"
            content={assistant.content}
            sources={assistant.sources}
            summaryCache={summaryCache}
            activityLog={assistant.activityLog}
            isStreaming={assistant.isStreaming}
            usage={assistant.usage}
            onSourceClick={setDocViewerId}
          />
        )}
      </div>

      <div className="border-t border-gray-200 bg-white px-5 py-3 shrink-0">
        <div className="flex gap-2 max-w-[800px] mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Αναζητήστε κυπριακές δικαστικές αποφάσεις..."
            rows={1}
            className="flex-1 bg-gray-50 border border-gray-300 rounded-xl px-4 py-2.5 text-[15px] text-gray-900 outline-none resize-none leading-snug min-h-[42px] max-h-[150px] focus:border-indigo-500 transition-colors placeholder:text-gray-400"
          />
          <button
            type="button"
            onClick={() => sendMessage()}
            disabled={isStreaming || !input.trim()}
            className="bg-indigo-500 text-white border-none rounded-xl px-5 text-base font-semibold h-[42px] self-end hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Αποστολή
          </button>
        </div>
      </div>

      <DocViewer
        docId={docViewerId}
        onClose={() => setDocViewerId(null)}
        summary={docViewerId ? summaryCache[docViewerId] : undefined}
      />
    </>
  );
}
