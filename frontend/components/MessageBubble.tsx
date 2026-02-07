"use client";

import { useMemo } from "react";
import { marked } from "marked";
import type { SearchResult, SearchingData, UsageData } from "@/lib/types";
import { SourceList } from "./SourceCard";
import { SearchIndicator } from "./SearchIndicator";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  sources?: SearchResult[];
  searching?: SearchingData | null;
  isStreaming?: boolean;
  usage?: UsageData | null;
  onSourceClick: (docId: string) => void;
}

function formatCost(costUsd: number): string {
  if (costUsd < 0.001) return `$${costUsd.toFixed(5)}`;
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(3)}`;
}

export function MessageBubble({
  role,
  content,
  sources,
  searching,
  isStreaming,
  usage,
  onSourceClick,
}: MessageBubbleProps) {
  const renderedHtml = useMemo(() => {
    if (!content) return "";
    return marked.parse(content) as string;
  }, [content]);

  const isUser = role === "user";

  return (
    <div className="mb-6 max-w-[800px] mx-auto">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 pl-1">
        {isUser ? "You" : "Assistant"}
      </div>
      <div className={isUser ? "ml-12" : ""}>
        <div
          className={
            isUser
              ? "bg-slate-800/60 rounded-xl rounded-br-sm px-4 py-3"
              : "py-2"
          }
        >
          {/* Searching indicator — only while actively searching */}
          {searching && searching.step > 0 && (
            <SearchIndicator query={searching.query} step={searching.step} />
          )}

          {/* Thinking indicator — shown while waiting for first token */}
          {isStreaming && !content && !searching && (
            <div className="flex items-center gap-2.5 text-sm text-zinc-400 py-2">
              <div className="w-4 h-4 border-2 border-zinc-600 border-t-indigo-500 rounded-full animate-spin" />
              <span>Thinking...</span>
            </div>
          )}

          {/* Message text */}
          {content && (
            <div
              className="msg-text text-[15px] leading-relaxed"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          )}

          {/* Typing cursor */}
          {isStreaming && content && (
            <span className="inline-block w-0.5 h-4 bg-indigo-500 animate-pulse align-text-bottom ml-0.5" />
          )}
        </div>

        {/* Source cards */}
        {sources && sources.length > 0 && (
          <SourceList sources={sources} onSourceClick={onSourceClick} />
        )}

        {/* Usage / cost info */}
        {usage && !isStreaming && (
          <div className="mt-2 flex items-center gap-3 text-[11px] text-zinc-600">
            <span>{usage.model}</span>
            {usage.documentsAnalyzed != null && usage.documentsAnalyzed > 0 && (
              <span>{usage.documentsAnalyzed} cases analyzed</span>
            )}
            <span>{usage.totalTokens.toLocaleString()} tokens</span>
            <span className="text-zinc-500 font-medium">{formatCost(usage.costUsd)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
