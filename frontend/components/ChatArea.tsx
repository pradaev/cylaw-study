"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { MessageBubble } from "./MessageBubble";
import { DocViewer } from "./DocViewer";
import type { ChatMessage, SearchResult, SearchingData, UsageData } from "@/lib/types";
import { MODELS } from "@/lib/types";

interface AssistantState {
  content: string;
  sources: SearchResult[];
  searching: SearchingData | null;
  isStreaming: boolean;
  usage: UsageData | null;
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  sources?: SearchResult[];
  usage?: UsageData | null;
}

const EXAMPLE_QUERIES = [
  "Find cases where court annulled administrative decisions under Article 146",
  "What is the precedent for unfair dismissal compensation in Cyprus?",
  "\u0392\u03c1\u03b5\u03c2 \u03b1\u03c0\u03bf\u03c6\u03ac\u03c3\u03b5\u03b9\u03c2 \u03c3\u03c7\u03b5\u03c4\u03b9\u03ba\u03ac \u03bc\u03b5 \u03b1\u03ba\u03cd\u03c1\u03c9\u03c3\u03b7 \u03b4\u03b9\u03bf\u03b9\u03ba\u03b7\u03c4\u03b9\u03ba\u03ce\u03bd \u03c0\u03c1\u03ac\u03be\u03b5\u03c9\u03bd",
  "Compare how different courts have ruled on property rights disputes",
];

function formatCost(costUsd: number): string {
  if (costUsd < 0.001) return `$${costUsd.toFixed(5)}`;
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(3)}`;
}

export function ChatArea() {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("gpt-4o");
  const [translate, setTranslate] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [docViewerId, setDocViewerId] = useState<string | null>(null);
  const [assistant, setAssistant] = useState<AssistantState>({
    content: "",
    sources: [],
    searching: null,
    isStreaming: false,
    usage: null,
  });

  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages, assistant.content]);

  // Auto-resize textarea
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

      setInput("");
      setIsStreaming(true);

      // Add user message
      const userMsg: HistoryMessage = { role: "user", content: messageText };
      setMessages((prev) => [...prev, userMsg]);

      // Build conversation history for API
      const apiMessages: ChatMessage[] = [
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: messageText },
      ];

      // Reset assistant state
      setAssistant({
        content: "",
        sources: [],
        searching: { query: "", step: 0 },
        isStreaming: true,
        usage: null,
      });

      let lastUsage: UsageData | null = null;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: apiMessages,
            model,
            translate,
          }),
        });

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";
        let answerText = "";
        let currentSources: SearchResult[] = [];
        let currentEvent = "";

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
                  setAssistant((prev) => ({
                    ...prev,
                    searching: searchData,
                  }));
                  break;
                }
                case "sources": {
                  const sources: SearchResult[] = JSON.parse(data);
                  currentSources = sources;
                  setAssistant((prev) => ({
                    ...prev,
                    sources,
                    searching: null,
                  }));
                  break;
                }
                case "token": {
                  const token = data.replace(/\\n/g, "\n");
                  answerText += token;
                  setAssistant((prev) => ({
                    ...prev,
                    content: answerText,
                    searching: null,
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
                    searching: null,
                  }));
                  break;
                }
                case "error": {
                  answerText = `Error: ${data}`;
                  setAssistant((prev) => ({
                    ...prev,
                    content: answerText,
                    isStreaming: false,
                    searching: null,
                  }));
                  break;
                }
              }
              currentEvent = "";
            }
          }
        }

        // Save completed assistant message to history
        if (answerText) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: answerText,
              sources: currentSources,
              usage: lastUsage,
            },
          ]);
          setAssistant({
            content: "",
            sources: [],
            searching: null,
            isStreaming: false,
            usage: null,
          });
        }
      } catch (err) {
        setAssistant({
          content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
          sources: [],
          searching: null,
          isStreaming: false,
          usage: null,
        });
      }

      setIsStreaming(false);
      inputRef.current?.focus();
    },
    [input, isStreaming, messages, model, translate],
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
      searching: null,
      isStreaming: false,
      usage: null,
    });
  }, []);

  const showWelcome = messages.length === 0 && !assistant.isStreaming;

  return (
    <>
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 bg-[#1a1d27] shrink-0">
        <h1 className="text-base font-bold">Cyprus Case Law</h1>
        <div className="flex items-center gap-3">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded-md px-2.5 py-1.5 text-xs text-zinc-200 cursor-pointer"
          >
            {Object.entries(MODELS).map(([key, cfg]) => (
              <option key={key} value={key}>
                {cfg.label}
              </option>
            ))}
          </select>

          <label
            className={`flex items-center gap-1 text-xs cursor-pointer select-none px-2.5 py-1.5 border rounded-md transition-colors ${
              translate
                ? "border-indigo-500 text-zinc-200"
                : "border-zinc-700 text-zinc-500"
            }`}
          >
            <input
              type="checkbox"
              checked={translate}
              onChange={(e) => setTranslate(e.target.checked)}
              className="hidden"
            />
            EN
          </label>

          <button
            type="button"
            onClick={newChat}
            className="text-xs text-zinc-400 border border-zinc-700 rounded-md px-2.5 py-1.5 hover:border-indigo-500 hover:text-zinc-200 transition-colors"
          >
            New chat
          </button>
        </div>
      </header>

      {/* Chat Messages */}
      <div ref={chatRef} className="flex-1 overflow-y-auto px-5 py-6 scroll-smooth">
        {showWelcome && (
          <div className="text-center py-16 text-zinc-500">
            <h2 className="text-xl font-semibold text-zinc-200 mb-2">
              Cyprus Case Law
            </h2>
            <p className="text-base mb-6">
              Search 150,000+ Cypriot court decisions in any language
            </p>
            <div className="flex flex-wrap gap-2 justify-center max-w-2xl mx-auto">
              {EXAMPLE_QUERIES.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => sendMessage(q)}
                  className="bg-[#1a1d27] border border-zinc-700/60 rounded-lg text-zinc-400 px-3.5 py-2.5 text-sm text-left leading-snug max-w-[280px] hover:border-indigo-500/60 hover:text-zinc-200 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Rendered history messages */}
        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            role={msg.role}
            content={msg.content}
            sources={msg.sources}
            usage={msg.usage}
            onSourceClick={setDocViewerId}
          />
        ))}

        {/* Currently streaming assistant message */}
        {(assistant.isStreaming || assistant.content) && (
          <MessageBubble
            role="assistant"
            content={assistant.content}
            sources={assistant.sources}
            searching={assistant.searching}
            isStreaming={assistant.isStreaming}
            usage={assistant.usage}
            onSourceClick={setDocViewerId}
          />
        )}
      </div>

      {/* Input Bar */}
      <div className="border-t border-zinc-800 bg-[#1a1d27] px-5 py-3 shrink-0">
        <div className="flex gap-2 max-w-[800px] mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask about Cypriot court cases..."
            rows={1}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2.5 text-[15px] text-zinc-200 outline-none resize-none leading-snug min-h-[42px] max-h-[150px] focus:border-indigo-500 transition-colors placeholder:text-zinc-600"
          />
          <button
            type="button"
            onClick={() => sendMessage()}
            disabled={isStreaming || !input.trim()}
            className="bg-indigo-500 text-white border-none rounded-xl px-5 text-base font-semibold h-[42px] self-end hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>

      {/* Document Viewer Modal */}
      <DocViewer docId={docViewerId} onClose={() => setDocViewerId(null)} />
    </>
  );
}
