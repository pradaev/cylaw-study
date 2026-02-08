"use client";

import { useEffect, useCallback, useState, useMemo } from "react";
import { marked } from "marked";

interface DocViewerProps {
  docId: string | null;
  onClose: () => void;
  summary?: string;
}

export function DocViewer({ docId, onClose, summary }: DocViewerProps) {
  const [title, setTitle] = useState("Φόρτωση...");
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(true);

  const summaryHtml = useMemo(() => {
    if (!summary) return "";
    return marked.parse(summary) as string;
  }, [summary]);

  const fetchDoc = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setTitle("Φόρτωση...");
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
      setError(err instanceof Error ? err.message : "Αποτυχία φόρτωσης εγγράφου");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (docId) {
      fetchDoc(docId);
      setSummaryExpanded(true);
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
      className="fixed inset-0 bg-black/40 z-50 flex justify-center items-center p-4 md:p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-gray-200 shadow-xl rounded-xl w-full max-w-[900px] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center px-5 py-3 border-b border-gray-200">
          <h3 className="text-sm font-medium flex-1 truncate mr-4 text-gray-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-gray-500 border border-gray-200 rounded-md px-2.5 py-1 hover:border-indigo-500 hover:text-gray-900 transition-colors"
          >
            Κλείσιμο
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto text-sm leading-relaxed">
          {/* AI Summary section */}
          {summary && (
            <div className="mb-5">
              <button
                type="button"
                onClick={() => setSummaryExpanded(!summaryExpanded)}
                className="flex items-center gap-2 text-xs uppercase tracking-wider text-indigo-600 hover:text-indigo-500 transition-colors cursor-pointer mb-2"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${summaryExpanded ? "rotate-90" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                Ανάλυση AI
              </button>
              {summaryExpanded && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-3">
                  <div
                    className="prose prose-sm max-w-none text-gray-700 [&_strong]:text-gray-900"
                    dangerouslySetInnerHTML={{ __html: summaryHtml }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Document content */}
          {loading && (
            <div className="flex items-center gap-2 text-gray-500">
              <div className="w-4 h-4 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
              <span>Φόρτωση εγγράφου...</span>
            </div>
          )}

          {error && <p className="text-red-500">{error}</p>}

          {!loading && !error && (
            <div
              className="doc-content prose prose-sm max-w-none font-serif text-gray-800"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
