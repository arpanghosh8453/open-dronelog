export interface TokenPricing { input_per_million: number; output_per_million: number; cached_input_per_million?: number | null; cache_write_per_million?: number | null }
export interface ChatUsageRound { prompt_tokens?: number | null; completion_tokens?: number | null; input_tokens?: number | null; output_tokens?: number | null; cost?: number | null; currency?: string; cost_kind?: string }
export interface ChatColumnMeta { field: string; op: string; bucket?: string | null }
export interface ChatConnection {
  provider: 'openai' | 'custom' | '';
  base_url: string;
  api_format: 'responses' | 'chat_completions' | '';
  model: string;
  has_api_key: boolean;
  pricing?: TokenPricing | null;
}
export type ConnectionInput = Omit<ChatConnection, 'has_api_key'> & { api_key?: string };
export interface ChatModel { id: string }
export interface ChartSpec { kind: 'bar' | 'line' | 'donut' | 'scatter' | 'boxplot' | 'heatmap' | 'timeline' | 'map'; x: string; y: string[]; series?: string | null; annotations?: { x: number; label: string }[]; band?: { lower: string; upper: string } | null }
export interface ChatResultMetadata {
  version: number;
  units: Record<string, { unit: string | null; field?: string; operation?: string; bucket?: string | null; status?: string; unit_column?: string; metric_column?: string; row_units?: { row_index: number; unit: string | null }[] }>;
  coverage: { returned_rows: number; limit: number | null; offset: number | null; truncated: boolean; any_section_truncated: boolean; complete_result: boolean; page_complete: boolean; complete_sections: boolean; population_total: number | null; aggregated: boolean; scope: string; null_counts: Record<string, number>; null_count_scope: string; missing_is_zero: boolean };
  quality: { status: string; checks: Record<string, unknown>[]; flags: Record<string, unknown>[]; any_section_flags: boolean; scope: string; physical_health_assessed: boolean };
  provenance: { source: string; timezone: string; request: unknown; generated_at: string; snapshot_scope: string; read_only: boolean };
}
export interface ChatResult {
  id: string;
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_flight_ids?: (number | null)[];
  column_meta?: Record<string, ChatColumnMeta>;
  truncated: boolean;
  source: string;
  timezone: string;
  request: unknown;
  chart?: ChartSpec | null;
  note: string;
  sections?: ChatResult[];
  metadata?: ChatResultMetadata;
}
export interface ChatMessage { role: 'user' | 'assistant'; text: string; results: ChatResult[]; usage?: unknown }
export interface ChatConversation { id: string; title: string; updated_at: string; messages: ChatMessage[] }
export type ConversationSummary = Pick<ChatConversation, 'id' | 'title' | 'updated_at'>;
export interface ChatRequest { request_id: string; conversation_id?: string | null; message: string; timezone: string; unit_system: string }
export type ChatEvent =
  | { type: 'conversation'; id: string; title: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_started'; name: string }
  | { type: 'result'; result: ChatResult }
  | { type: 'usage'; usage: unknown }
  | { type: 'completed' }
  | { type: 'error'; message: string };
