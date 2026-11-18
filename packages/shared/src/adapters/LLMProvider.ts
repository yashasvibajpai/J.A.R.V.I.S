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

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /** Hint from the pipeline about what kind of task this is — used by SmartRouter for routing */
  taskHint?: TaskType;
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
