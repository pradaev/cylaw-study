"use client";

import { useEffect, useCallback, useState } from "react";

interface DocViewerProps {
  docId: string | null;
  onClose: () => void;
}

export function DocViewer({ docId, onClose }: DocViewerProps) {
  const [title, setTitle] = useState("Loading...");
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDoc = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setTitle("Loading...");
    setHtml("");

    try {
      const res = await fetch(`/api/doc?doc_id=${encodeURIComponent(id)}`);
      const data = (await res.json()) as {
        error?: string;
        title?: string;
        html?: string;
      };

      if (data.error) {
        setError(data.error);
        return;
      }

      setTitle(data.title ?? id);
      setHtml(data.html ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load document");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (docId) {
      fetchDoc(docId);
    }
  }, [docId, fetchDoc]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (docId) {
      document.addEventListener("keydown", handleKey);
      return () => document.removeEventListener("keydown", handleKey);
    }
  }, [docId, onClose]);

  if (!docId) return null;

  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex justify-center items-center p-4 md:p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#1a1d27] border border-zinc-700/60 rounded-xl w-full max-w-[900px] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center px-5 py-3 border-b border-zinc-700/60">
          <h3 className="text-sm font-medium flex-1 truncate mr-4">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-zinc-400 border border-zinc-700/60 rounded-md px-2.5 py-1 hover:border-indigo-500 hover:text-zinc-200 transition-colors"
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto text-sm leading-relaxed font-serif">
          {loading && (
            <div className="flex items-center gap-2 text-zinc-400">
              <div className="w-4 h-4 border-2 border-zinc-600 border-t-indigo-500 rounded-full animate-spin" />
              <span>Loading document...</span>
            </div>
          )}

          {error && <p className="text-red-400">{error}</p>}

          {!loading && !error && (
            <div
              className="doc-content prose prose-invert prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
