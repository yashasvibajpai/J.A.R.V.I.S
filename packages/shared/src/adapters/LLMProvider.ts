// ─── Message Types ───────────────────────────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  name?: string;
  timestamp?: string;
}

// ─── LLM Configuration ──────────────────────────────────────────────────────

/** Task categories used by the SmartRouter for intelligent provider selection */
export type TaskType = 'general' | 'coding' | 'reasoning' | 'creative' | 'quick' | 'tool_use' | 'embedding';

/** Reasoning effort levels supported by thinking/reasoning models */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface LLMTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /** Hint from the pipeline about what kind of task this is — used by SmartRouter for routing */
  taskHint?: TaskType;
  /** Effort level allocated to internal reasoning / chain-of-thought tokens */
  reasoningEffort?: ReasoningEffort;
  /** Explicit thinking token budget if supported (e.g. Gemini / Claude) */
  thinkingBudget?: number;
  /** Restrict provider selection strictly to free / local tiers */
  freeOnly?: boolean;
  /** Report usage for an individually tracked request. The caller owns retries. */
  onUsage?: (usage: LLMTokenUsage) => void;
  signal?: AbortSignal;
}

export interface LLMCapabilities {
  supportsTools: boolean;
  supportsStreaming: boolean;
  contextWindow: number;
  providerId: string;
  modelId: string;
}

// ─── Core Adapter Interface ─────────────────────────────────────────────────

/**
 * Every LLM integration implements this interface.
 * Swap the adapter, swap the brain — nothing else changes.
 */
export interface LLMProvider {
  /** One-shot completion */
  chat(messages: Message[], options?: LLMOptions): Promise<string>;

  /** Streaming completion — yields text chunks as they arrive */
  stream(messages: Message[], options?: LLMOptions): AsyncGenerator<string>;

  /** Optional: generate embeddings for a text string */
  embed?(text: string): Promise<number[]>;

  /** Declare what this provider can do */
  getCapabilities(): LLMCapabilities;

  /** Health check — can we reach this provider right now? */
  isAvailable(): Promise<boolean>;
}
