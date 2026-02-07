"use client";

import type { SearchResult } from "@/lib/types";
import { COURT_NAMES } from "@/lib/types";

interface SourceCardProps {
  source: SearchResult;
  onClick: (docId: string) => void;
}

export function SourceCard({ source, onClick }: SourceCardProps) {
  const scoreClass =
    source.score >= 60
      ? "bg-emerald-950 text-emerald-400"
      : source.score >= 40
        ? "bg-amber-950 text-amber-400"
        : "bg-zinc-800 text-zinc-400";

  const courtLabel = COURT_NAMES[source.court] ?? source.court;

  return (
    <button
      type="button"
      className="w-full text-left bg-[#1a1d27] border border-zinc-700/60 rounded-xl p-3.5 flex justify-between items-start cursor-pointer transition-colors hover:border-indigo-500/60"
      onClick={() => onClick(source.doc_id)}
    >
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm leading-snug truncate">
          {source.title.slice(0, 120)}
        </div>
        <div className="text-xs text-zinc-500 mt-0.5">
          {courtLabel} &middot; {source.year}
        </div>
      </div>
      <div
        className={`text-[11px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap ml-2 shrink-0 ${scoreClass}`}
      >
        {source.score}%
      </div>
    </button>
  );
}

interface SourceListProps {
  sources: SearchResult[];
  onSourceClick: (docId: string) => void;
}

export function SourceList({ sources, onSourceClick }: SourceListProps) {
  if (sources.length === 0) return null;

  return (
    <div className="mt-3">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
        Sources ({sources.length} cases found)
      </div>
      <div className="space-y-1.5">
        {sources.map((s) => (
          <SourceCard key={s.doc_id} source={s} onClick={onSourceClick} />
        ))}
      </div>
    </div>
  );
}
