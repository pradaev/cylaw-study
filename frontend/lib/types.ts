/** Shared TypeScript interfaces for CyCourt. */

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SearchResult {
  doc_id: string;
  title: string;
  court: string;
  year: string;
  text: string;
  score: number;
}

export interface SSEEvent {
  type: "token" | "sources" | "searching" | "error" | "done" | "usage";
  data: unknown;
}

export interface SearchingData {
  query: string;
  step: number;
}

export interface ActivityEntry {
  type: "sending" | "thinking" | "searching" | "found" | "analyzing" | "writing";
  text: string;
  timestamp: number;
}

export interface DocumentMeta {
  doc_id: string;
  title: string;
  court: string;
  year: string;
  score: number;
  chunk_count: number;
}

/** Cost per 1M tokens in USD */
interface ModelPricing {
  input: number;
  output: number;
}

export interface ModelConfig {
  provider: "openai" | "anthropic";
  modelId: string;
  label: string;
  contextWindow: number;
  pricing: ModelPricing;
}

export interface UsageData {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  documentsAnalyzed?: number;
}

export const MODELS: Record<string, ModelConfig> = {
  "gpt-4o": {
    provider: "openai",
    modelId: "gpt-4o",
    label: "GPT-4o (128K)",
    contextWindow: 128000,
    pricing: { input: 2.5, output: 10 },
  },
  "o3-mini": {
    provider: "openai",
    modelId: "o3-mini",
    label: "o3-mini (200K)",
    contextWindow: 200000,
    pricing: { input: 1.1, output: 4.4 },
  },
  claude: {
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    label: "Claude Sonnet 4 (200K)",
    contextWindow: 200000,
    pricing: { input: 3, output: 15 },
  },
};

export const COURT_NAMES: Record<string, string> = {
  aad: "Ανώτατο (old Supreme)",
  supreme: "Ανώτατο (new Supreme)",
  courtOfAppeal: "Εφετείο (Court of Appeal)",
  supremeAdministrative: "Ανώτατο Συνταγματικό",
  administrative: "Διοικητικό (Administrative)",
  administrativeIP: "Διοικ. Πρωτοδικείο (Admin First Inst.)",
  epa: "Επαρχιακά (District)",
  aap: "Αρχή Ανταγωνισμού (Competition)",
  dioikitiko: "Εφ. Διοικ. Δικαστηρίου",
  clr: "CLR (Cyprus Law Reports)",
  areiospagos: "Άρειος Πάγος (Areios Pagos)",
  apofaseised: "Πρωτόδικα (First Instance)",
  jsc: "JSC (Supreme Court English)",
  rscc: "RSCC (Constitutional 1960-63)",
  administrativeCourtOfAppeal: "Διοικ. Εφετείο (Admin Appeal)",
  juvenileCourt: "Δικαστήριο Παίδων (Juvenile)",
};
