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
 */
function parseRelevance(summary: string): string | null {
  const section = summary.split(/RELEVANCE RATING/i)[1] ?? "";
  for (const level of ["HIGH", "MEDIUM", "LOW", "NONE"]) {
    if (new RegExp(`\\b${level}\\b`).test(section)) return level;
  }
  return null;
}

/**
 * Extract Court Findings (ΕΥΡΗΜΑΤΑ ΔΙΚΑΣΤΗΡΙΟΥ) from summary — section 5.
 */
function extractFindings(summary: string): string {
  const lines = summary.split("\n");
  const contentLines: string[] = [];
  let inFindings = false;

  for (const line of lines) {
    // Start capturing at section 5 (ΕΥΡΗΜΑΤΑ / COURT'S FINDINGS)
    if (/^5\.|ΕΥΡΗΜΑΤΑ|COURT'S FINDINGS/i.test(line.trim())) {
      inFindings = true;
      // Clean the header itself
      const cleaned = line.replace(/^5\.\s*(ΕΥΡΗΜΑΤΑ ΔΙΚΑΣΤΗΡΙΟΥ|COURT'S FINDINGS)[^:]*:\s*/i, "").trim();
      if (cleaned.length > 10) contentLines.push(cleaned);
      continue;
    }
    // Stop at section 6 or 7
    if (inFindings && /^[6-7]\.|ΑΠΟΤΕΛΕΣΜΑ|OUTCOME|RELEVANCE RATING/i.test(line.trim())) {
      break;
    }
    if (inFindings) {
      const trimmed = line.trim();
      if (trimmed.length > 0) contentLines.push(trimmed);
    }
  }

  const text = contentLines.join(" ").slice(0, 400);
  return text.length > 0 ? text + (text.length >= 400 ? "..." : "") : "";
}

const RELEVANCE_STYLES: Record<string, string> = {
  HIGH: "bg-emerald-50 text-emerald-700 border-emerald-300",
  MEDIUM: "bg-amber-50 text-amber-700 border-amber-300",
  LOW: "bg-gray-100 text-gray-600 border-gray-300",
};

const RELEVANCE_LABELS: Record<string, string> = {
  HIGH: "Υψηλή",
  MEDIUM: "Μέτρια",
  LOW: "Χαμηλή",
};

export function SourceCard({ source, summary, onClick }: SourceCardProps) {
  const [expanded, setExpanded] = useState(false);
  const courtLabel = COURT_NAMES[source.court] ?? source.court;
  const relevance = summary ? parseRelevance(summary) : null;
  const findings = summary ? extractFindings(summary) : "";
  const isReady = !!summary;

  const summaryHtml = useMemo(() => {
    if (!summary) return "";
    return marked.parse(summary, { async: false }) as string;
  }, [summary]);

  const relevanceStyle = relevance
    ? RELEVANCE_STYLES[relevance] ?? ""
    : "";

  return (
    <div className={`bg-white border rounded-xl overflow-hidden transition-all ${
      isReady ? "border-gray-200 hover:border-indigo-400 opacity-100" : "border-gray-100 opacity-40"
    }`}>
      {/* Header — always visible */}
      <div className="flex items-start gap-2 p-3.5">
        {/* Expand toggle (only if summary exists) */}
        {isReady ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-0.5 shrink-0 text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
            aria-label={expanded ? "Σύμπτυξη" : "Ανάπτυξη"}
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
          <div className="w-3.5 shrink-0 mt-0.5">
            <div className="w-3 h-3 border-[1.5px] border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
          </div>
        )}

        {/* Title + court info + findings */}
        <div className="flex-1 min-w-0">
          {isReady ? (
            <button
              type="button"
              className="text-left cursor-pointer w-full"
              onClick={() => onClick(source.doc_id)}
            >
              <div className="font-semibold text-sm leading-snug line-clamp-2 text-gray-900 hover:text-indigo-600 transition-colors">
                {source.title}
              </div>
            </button>
          ) : (
            <div className="font-semibold text-sm leading-snug line-clamp-2 text-gray-400">
              {source.title}
            </div>
          )}
          <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span>{courtLabel}</span>
            <span>&middot;</span>
            <span>{source.year}</span>
          </div>
          {/* Court findings — always visible */}
          {findings && (
            <p className="text-[13px] text-gray-600 mt-1.5 leading-relaxed">
              {findings}
            </p>
          )}
        </div>

        {/* Relevance badge + score */}
        <div className="flex items-center gap-1.5 ml-1 shrink-0">
          {relevance && relevanceStyle ? (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap border ${relevanceStyle}`}
            >
              {RELEVANCE_LABELS[relevance]}
            </span>
          ) : null}
          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono whitespace-nowrap bg-gray-100 text-gray-500">
            {(source.score * 100).toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Full summary — expanded */}
      {expanded && summary && (
        <div className="border-t border-gray-200 px-4 py-3 bg-gray-50">
          <div
            className="prose prose-sm max-w-none text-gray-600 leading-relaxed
              [&_strong]:text-gray-900
              [&_h1]:text-sm [&_h1]:font-bold [&_h1]:text-gray-900 [&_h1]:mt-0 [&_h1]:mb-2
              [&_h2]:text-sm [&_h2]:font-bold [&_h2]:text-gray-900 [&_h2]:mt-3 [&_h2]:mb-1
              [&_p]:my-1.5 [&_p]:text-[13px]
              [&_ol]:my-1 [&_ol]:text-[13px]
              [&_li]:my-0.5"
            dangerouslySetInnerHTML={{ __html: summaryHtml }}
          />
          <button
            type="button"
            onClick={() => onClick(source.doc_id)}
            className="mt-2 text-xs text-indigo-600 hover:text-indigo-500 transition-colors cursor-pointer"
          >
            Δείτε πλήρες κείμενο &rarr;
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
  // Filter out NONE relevance — only show HIGH, MEDIUM, LOW
  const filtered = useMemo(() => {
    return sources.filter((s) => {
      const summary = summaryCache?.[s.doc_id];
      if (!summary) return true; // no summary yet = keep (might be loading)
      const rel = parseRelevance(summary);
      return rel !== "NONE" && rel !== null;
    });
  }, [sources, summaryCache]);

  // Sort: relevance (HIGH → MEDIUM → LOW) then year descending
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const sumA = summaryCache?.[a.doc_id];
      const sumB = summaryCache?.[b.doc_id];
      const relA = sumA ? parseRelevance(sumA) : null;
      const relB = sumB ? parseRelevance(sumB) : null;
      const orderA = relA ? (RELEVANCE_ORDER[relA] ?? 4) : 4;
      const orderB = relB ? (RELEVANCE_ORDER[relB] ?? 4) : 4;
      if (orderA !== orderB) return orderA - orderB;
      const yearA = parseInt(a.year, 10) || 0;
      const yearB = parseInt(b.year, 10) || 0;
      return yearB - yearA;
    });
  }, [filtered, summaryCache]);

  if (filtered.length === 0) return null;

  // Count by relevance
  const summarized = summaryCache
    ? filtered.filter((s) => summaryCache[s.doc_id]).length
    : 0;

  return (
    <div className="mt-4">
      <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">
        Πηγές ({filtered.length} αποφάσεις{summarized > 0 ? `, ${summarized} αναλυμένες` : ""})
      </div>
      <div className="space-y-1.5">
        {sorted.map((s) => (
          <SourceCard
            key={s.doc_id}
            source={s}
            summary={summaryCache?.[s.doc_id]}
            onClick={onSourceClick}
          />
        ))}
      </div>
    </div>
  );
}
