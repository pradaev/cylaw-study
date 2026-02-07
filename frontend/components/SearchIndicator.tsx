"use client";

interface SearchIndicatorProps {
  query: string;
  step: number;
}

export function SearchIndicator({ query, step }: SearchIndicatorProps) {
  return (
    <div className="flex items-center gap-2.5 text-sm text-zinc-400 py-2">
      <div className="w-4 h-4 border-2 border-zinc-600 border-t-indigo-500 rounded-full animate-spin" />
      <span>
        Searching: &ldquo;{query}&rdquo; (step {step})
      </span>
    </div>
  );
}
