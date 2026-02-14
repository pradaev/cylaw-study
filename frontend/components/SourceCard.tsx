"use client";

import { useState, useMemo } from "react";
import type { SearchResult, StructuredSummary } from "@/lib/types";
import { COURT_NAMES } from "@/lib/types";

interface SourceCardProps {
  source: SearchResult;
  summary?: StructuredSummary;
  onClick: (docId: string) => void;
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

const ENGAGEMENT_LABELS: Record<string, string> = {
  RULED: "ΑΠΟΦΑΝΘΗΚΕ",
  DISCUSSED: "ΑΝΑΛΥΘΗΚΕ",
  MENTIONED: "ΑΝΑΦΕΡΘΗΚΕ",
  NOT_ADDRESSED: "ΔΕΝ ΕΞΕΤΑΣΤΗΚΕ",
};

const ENGAGEMENT_STYLES: Record<string, string> = {
  RULED: "text-emerald-600",
  DISCUSSED: "text-blue-600",
  MENTIONED: "text-gray-500",
  NOT_ADDRESSED: "text-gray-400",
};

export function SourceCard({ source, summary, onClick }: SourceCardProps) {
  const [expanded, setExpanded] = useState(false);
  const courtLabel = COURT_NAMES[source.court] ?? source.court;
  const isReady = !!summary;

  const relevance = summary?.relevance.rating ?? null;
  const relevanceStyle = relevance ? RELEVANCE_STYLES[relevance] ?? "" : "";

  // Build findings preview — shown in collapsed state
  const findingsPreview = useMemo(() => {
    if (!summary) return "";
    const { engagement, analysis } = summary.findings;
    if (engagement === "NOT_ADDRESSED") return "";
    return analysis.slice(0, 300) + (analysis.length > 300 ? "..." : "");
  }, [summary]);

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

        {/* Title + court info + findings preview */}
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
            {summary && (
              <>
                <span>&middot;</span>
                <span className={ENGAGEMENT_STYLES[summary.findings.engagement] ?? ""}>
                  {ENGAGEMENT_LABELS[summary.findings.engagement] ?? summary.findings.engagement}
                </span>
              </>
            )}
          </div>
          {/* Findings preview — always visible (collapsed) */}
          {findingsPreview && (
            <p className="text-[13px] text-gray-600 mt-1.5 leading-relaxed">
              {findingsPreview}
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
        <div className="border-t border-gray-200 px-4 py-3 bg-gray-50 space-y-3">
          {/* Core issue */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-gray-400 mb-0.5">Κύριο νομικό ζήτημα</div>
            <p className="text-[13px] text-gray-700 leading-relaxed">{summary.coreIssue}</p>
          </div>

          {/* Facts */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-gray-400 mb-0.5">Ιστορικό</div>
            <p className="text-[13px] text-gray-600 leading-relaxed">{summary.facts}</p>
          </div>

          {/* Court findings */}
          {summary.findings.engagement !== "NOT_ADDRESSED" && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-gray-400 mb-0.5">
                Ευρήματα δικαστηρίου
                <span className={`ml-1.5 ${ENGAGEMENT_STYLES[summary.findings.engagement]}`}>
                  [{ENGAGEMENT_LABELS[summary.findings.engagement]}]
                </span>
              </div>
              <p className="text-[13px] text-gray-700 leading-relaxed">{summary.findings.analysis}</p>
              {summary.findings.quote && (
                <blockquote className="mt-1.5 pl-3 border-l-2 border-indigo-300 text-[13px] text-gray-600 italic leading-relaxed">
                  «{summary.findings.quote}»
                </blockquote>
              )}
            </div>
          )}

          {/* Outcome */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-gray-400 mb-0.5">Αποτέλεσμα</div>
            <p className="text-[13px] text-gray-600 leading-relaxed">{summary.outcome}</p>
          </div>

          {/* Relevance reasoning */}
          <div className="pt-1 border-t border-gray-200">
            <p className="text-[12px] text-gray-500 italic">{summary.relevance.reasoning}</p>
          </div>

          <button
            type="button"
            onClick={() => onClick(source.doc_id)}
            className="text-xs text-indigo-600 hover:text-indigo-500 transition-colors cursor-pointer"
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
  summaryCache?: Record<string, StructuredSummary>;
  summarizeTotal?: number | null;
  onSourceClick: (docId: string) => void;
}

const RELEVANCE_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };

export function SourceList({ sources, summaryCache, summarizeTotal, onSourceClick }: SourceListProps) {
  const summarizedCount = summaryCache
    ? sources.filter((s) => summaryCache[s.doc_id]).length
    : 0;
  const expectedTotal = summarizeTotal ?? sources.length;
  const allDone = expectedTotal > 0 && summarizedCount >= expectedTotal;

  // Only show cards after ALL summaries are ready — filter NONE + LOW, sort by relevance
  const displayList = useMemo(() => {
    if (!allDone) return [];
    return [...sources]
      .filter((s) => {
        const summary = summaryCache?.[s.doc_id];
        if (!summary) return false;
        const rel = summary.relevance.rating;
        // Filter out NONE and LOW — keep only HIGH and MEDIUM
        return rel === "HIGH" || rel === "MEDIUM";
      })
      .sort((a, b) => {
        const sumA = summaryCache?.[a.doc_id];
        const sumB = summaryCache?.[b.doc_id];
        const relA = sumA?.relevance.rating;
        const relB = sumB?.relevance.rating;
        const orderA = relA ? (RELEVANCE_ORDER[relA] ?? 4) : 4;
        const orderB = relB ? (RELEVANCE_ORDER[relB] ?? 4) : 4;
        if (orderA !== orderB) return orderA - orderB;
        const yearA = parseInt(a.year, 10) || 0;
        const yearB = parseInt(b.year, 10) || 0;
        return yearB - yearA;
      });
  }, [sources, summaryCache, allDone]);

  if (sources.length === 0) return null;

  // While loading: show progress bar
  if (!allDone) {
    const pct = expectedTotal > 0 ? Math.round((summarizedCount / expectedTotal) * 100) : 0;
    return (
      <div className="mt-4">
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <div className="w-4 h-4 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin shrink-0" />
          <span>Ανάλυση αποφάσεων: {summarizedCount}/{expectedTotal} ({pct}%)</span>
        </div>
        <div className="mt-2 w-full bg-gray-100 rounded-full h-1.5">
          <div
            className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (displayList.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">
        Πηγές ({displayList.length} σχετικές αποφάσεις από {sources.length} που αναλύθηκαν)
      </div>
      <div className="space-y-1.5">
        {displayList.map((s) => (
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
