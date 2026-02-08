"use client";

import { useState, useMemo } from "react";
import { marked } from "marked";
import type { SearchResult } from "@/lib/types";
import { COURT_NAMES } from "@/lib/types";

interface SourceCardProps {
  source: SearchResult;
  summary?: string;
  onClick: (docId: string) => void;
}

/**
 * Parse relevance level from summary text.
 * Looks for "RELEVANCE RATING: HIGH" or similar patterns.
 */
function parseRelevance(summary: string): string | null {
  const section = summary.split(/RELEVANCE RATING/i)[1] ?? "";
  for (const level of ["HIGH", "MEDIUM", "LOW", "NONE"]) {
    if (new RegExp(`\\b${level}\\b`).test(section)) return level;
  }
  return null;
}

const RELEVANCE_STYLES: Record<string, string> = {
  HIGH: "bg-emerald-950/80 text-emerald-400 border-emerald-500/30",
  MEDIUM: "bg-amber-950/80 text-amber-400 border-amber-500/30",
  LOW: "bg-zinc-800/80 text-zinc-400 border-zinc-500/30",
  NONE: "bg-zinc-800/80 text-zinc-600 border-zinc-600/30",
};

const RELEVANCE_LABELS: Record<string, string> = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  NONE: "Not relevant",
};

export function SourceCard({ source, summary, onClick }: SourceCardProps) {
  const [expanded, setExpanded] = useState(false);
  const courtLabel = COURT_NAMES[source.court] ?? source.court;
  const relevance = summary ? parseRelevance(summary) : null;

  const summaryHtml = useMemo(() => {
    if (!summary) return "";
    return marked.parse(summary, { async: false }) as string;
  }, [summary]);

  const relevanceStyle = relevance
    ? RELEVANCE_STYLES[relevance] ?? RELEVANCE_STYLES.NONE
    : "";

  return (
    <div className="bg-[#1a1d27] border border-zinc-700/60 rounded-xl overflow-hidden transition-colors hover:border-indigo-500/40">
      {/* Header — always visible */}
      <div className="flex items-start gap-2 p-3.5">
        {/* Expand toggle (only if summary exists) */}
        {summary ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-0.5 shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            aria-label={expanded ? "Collapse summary" : "Expand summary"}
          >
            <svg
              className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <div className="w-3.5 shrink-0" />
        )}

        {/* Title + court info */}
        <button
          type="button"
          className="flex-1 min-w-0 text-left cursor-pointer"
          onClick={() => onClick(source.doc_id)}
        >
          <div className="font-semibold text-sm leading-snug line-clamp-2 hover:text-indigo-300 transition-colors">
            {source.title}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span>{courtLabel}</span>
            <span>&middot;</span>
            <span>{source.year}</span>
          </div>
        </button>

        {/* Relevance badge + score */}
        <div className="flex items-center gap-1.5 ml-1 shrink-0">
          {relevance ? (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap border ${relevanceStyle}`}
            >
              {RELEVANCE_LABELS[relevance]}
            </span>
          ) : null}
          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono whitespace-nowrap bg-zinc-800/60 text-zinc-500">
            {(source.score * 100).toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Expanded summary */}
      {expanded && summary && (
        <div className="border-t border-zinc-700/40 px-4 py-3 bg-zinc-900/50">
          <div
            className="prose prose-invert prose-sm max-w-none text-zinc-400 leading-relaxed
              [&_strong]:text-zinc-200
              [&_h1]:text-sm [&_h1]:font-bold [&_h1]:text-zinc-200 [&_h1]:mt-0 [&_h1]:mb-2
              [&_h2]:text-sm [&_h2]:font-bold [&_h2]:text-zinc-200 [&_h2]:mt-3 [&_h2]:mb-1
              [&_p]:my-1.5 [&_p]:text-[13px]
              [&_ol]:my-1 [&_ol]:text-[13px]
              [&_li]:my-0.5"
            dangerouslySetInnerHTML={{ __html: summaryHtml }}
          />
          <button
            type="button"
            onClick={() => onClick(source.doc_id)}
            className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 transition-colors cursor-pointer"
          >
            Open full document &rarr;
          </button>
        </div>
      )}
    </div>
  );
}

interface SourceListProps {
  sources: SearchResult[];
  summaryCache?: Record<string, string>;
  onSourceClick: (docId: string) => void;
}

const RELEVANCE_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };

export function SourceList({ sources, summaryCache, onSourceClick }: SourceListProps) {
  const [expanded, setExpanded] = useState(false);

  // Sort: relevance (HIGH → MEDIUM → LOW → NONE) then year descending
  const sorted = useMemo(() => {
    return [...sources].sort((a, b) => {
      const sumA = summaryCache?.[a.doc_id];
      const sumB = summaryCache?.[b.doc_id];
      const relA = sumA ? parseRelevance(sumA) : null;
      const relB = sumB ? parseRelevance(sumB) : null;
      const orderA = relA ? (RELEVANCE_ORDER[relA] ?? 4) : 4;
      const orderB = relB ? (RELEVANCE_ORDER[relB] ?? 4) : 4;
      if (orderA !== orderB) return orderA - orderB;
      // Within same relevance: newest first
      const yearA = parseInt(a.year, 10) || 0;
      const yearB = parseInt(b.year, 10) || 0;
      return yearB - yearA;
    });
  }, [sources, summaryCache]);

  if (sources.length === 0) return null;

  // Count how many have summaries
  const summarized = summaryCache
    ? sources.filter((s) => summaryCache[s.doc_id]).length
    : 0;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
      >
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Sources ({sources.length} cases{summarized > 0 ? `, ${summarized} analyzed` : ""})
      </button>
      {expanded && (
        <div className="space-y-1.5 mt-2">
          {sorted.map((s) => (
            <SourceCard
              key={s.doc_id}
              source={s}
              summary={summaryCache?.[s.doc_id]}
              onClick={onSourceClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
