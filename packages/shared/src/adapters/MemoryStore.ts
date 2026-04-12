// ─── Memory Types ────────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export type MemoryCategory =
  | 'fact'         // "User works at Acme Corp"
  | 'preference'   // "User prefers concise responses"
  | 'event'        // "User has a meeting tomorrow at 3pm"
  | 'goal'         // "User wants to learn Rust"
  | 'relationship' // "Alice is user's manager"
  | 'context'      // "User is stressed about a deadline"
  | 'general';     // Catch-all

// ─── Core Adapter Interface ─────────────────────────────────────────────────

/**
 * Stores and retrieves memories about the user.
 * Phase 1: SQLite with FTS5 full-text search.
 * Future: Swap to Mem0 (graph) or Qdrant (vector) via this interface.
 */
export interface MemoryStore {
  add(content: string, category?: MemoryCategory, metadata?: Record<string, any>): Promise<Memory>;
  search(query: string, limit?: number): Promise<Memory[]>;
  getAll(category?: MemoryCategory): Promise<Memory[]>;
  getRecent(limit?: number): Promise<Memory[]>;
  delete(id: string): Promise<void>;
  update(id: string, content: string, metadata?: Record<string, any>): Promise<Memory>;
  count(): Promise<number>;
}
