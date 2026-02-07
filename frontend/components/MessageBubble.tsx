"use client";

import { useMemo } from "react";
import { marked } from "marked";
import type { SearchResult, UsageData, ActivityEntry } from "@/lib/types";
import { SourceList } from "./SourceCard";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  sources?: SearchResult[];
  activityLog?: ActivityEntry[];
  isStreaming?: boolean;
  usage?: UsageData | null;
  onSourceClick: (docId: string) => void;
}

function formatCost(costUsd: number): string {
  if (costUsd < 0.001) return `$${costUsd.toFixed(5)}`;
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(3)}`;
}

const ACTIVITY_ICONS: Record<ActivityEntry["type"], string> = {
  sending: "\u2191",   // up arrow
  thinking: "\u2022",  // bullet
  searching: "\u25CB", // circle
  found: "\u2713",     // checkmark
  analyzing: "\u2026", // ellipsis
  writing: "\u270E",   // pencil
};

function ActivityLog({ entries, isActive }: { entries: ActivityEntry[]; isActive: boolean }) {
  if (entries.length === 0 && !isActive) return null;

  return (
    <div className="mb-3 space-y-1">
      {entries.map((entry, i) => {
        const isLast = i === entries.length - 1;
        const showSpinner = isActive && isLast;
        return (
          <div
            key={i}
            className={`flex items-center gap-2 text-xs ${
              isLast && isActive ? "text-zinc-300" : "text-zinc-600"
            }`}
          >
            {showSpinner ? (
              <div className="w-3 h-3 border-[1.5px] border-zinc-600 border-t-indigo-500 rounded-full animate-spin shrink-0" />
            ) : (
              <span className="w-3 text-center shrink-0 text-[10px]">
                {ACTIVITY_ICONS[entry.type]}
              </span>
            )}
            <span>{entry.text}</span>
          </div>
        );
      })}
    </div>
  );
}

export function MessageBubble({
  role,
  content,
  sources,
  activityLog,
  isStreaming,
  usage,
  onSourceClick,
}: MessageBubbleProps) {
  const renderedHtml = useMemo(() => {
    if (!content) return "";
    return marked.parse(content) as string;
  }, [content]);

  const isUser = role === "user";
  const showActivity = activityLog && activityLog.length > 0;
  const isActivityActive = isStreaming === true && !content;

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
          {/* Activity log — shows what's happening step by step */}
          {showActivity && (
            <ActivityLog entries={activityLog} isActive={isActivityActive} />
          )}

          {/* Message text — doc links open in viewer */}
          {content && (
            <div
              className="msg-text text-[15px] leading-relaxed"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
              onClick={(e) => {
                const target = e.target as HTMLElement;
                const anchor = target.closest("a");
                if (anchor) {
                  const href = anchor.getAttribute("href");
                  if (href?.startsWith("/doc?doc_id=")) {
                    e.preventDefault();
                    const docId = new URL(href, "http://localhost").searchParams.get("doc_id");
                    if (docId) onSourceClick(docId);
                  }
                }
              }}
            />
          )}

          {/* Typing cursor */}
          {isStreaming && content && (
            <span className="inline-block w-0.5 h-4 bg-indigo-500 animate-pulse align-text-bottom ml-0.5" />
          )}
        </div>

        {/* Source cards — collapsed by default */}
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
