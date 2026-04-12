import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Memory, MemoryCategory, MemoryStore } from '@jarvis/shared';

/**
 * SQLite-backed MemoryStore using FTS5 for full-text search.
 *
 * Lightweight, fully local, zero external dependencies.
 * Swap to Mem0 or Qdrant later via the MemoryStore interface.
 */
export class SQLiteMemoryStore implements MemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL'); // Better concurrent performance
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- FTS5 virtual table for full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        category,
        content='memories',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS index in sync
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.rowid, new.content, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.rowid, old.content, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.rowid, old.content, old.category);
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.rowid, new.content, new.category);
      END;
    `);
  }

  async add(
    content: string,
    category: MemoryCategory = 'general',
    metadata: Record<string, any> = {}
  ): Promise<Memory> {
    const id = uuid();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO memories (id, content, category, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, content, category, JSON.stringify(metadata), now, now);

    return { id, content, category, metadata, createdAt: now, updatedAt: now };
  }

  async search(query: string, limit = 10): Promise<Memory[]> {
    // FTS5 search with ranking
    const rows = this.db
      .prepare(
        `SELECT m.id, m.content, m.category, m.metadata, m.created_at, m.updated_at,
                rank
         FROM memories_fts fts
         JOIN memories m ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(this.sanitiseFtsQuery(query), limit) as any[];

    return rows.map(this.rowToMemory);
  }

  async getAll(category?: MemoryCategory): Promise<Memory[]> {
    if (category) {
      const rows = this.db
        .prepare('SELECT * FROM memories WHERE category = ? ORDER BY created_at DESC')
        .all(category) as any[];
      return rows.map(this.rowToMemory);
    }

    const rows = this.db
      .prepare('SELECT * FROM memories ORDER BY created_at DESC')
      .all() as any[];
    return rows.map(this.rowToMemory);
  }

  async getRecent(limit = 20): Promise<Memory[]> {
    const rows = this.db
      .prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ?')
      .all(limit) as any[];
    return rows.map(this.rowToMemory);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  async update(
    id: string,
    content: string,
    metadata?: Record<string, any>
  ): Promise<Memory> {
    const now = new Date().toISOString();

    if (metadata) {
      this.db
        .prepare('UPDATE memories SET content = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .run(content, JSON.stringify(metadata), now, id);
    } else {
      this.db
        .prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?')
        .run(content, now, id);
    }

    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    return this.rowToMemory(row);
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM memories').get() as any;
    return row.count;
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private rowToMemory(row: any): Memory {
    return {
      id: row.id,
      content: row.content,
      category: row.category as MemoryCategory,
      metadata: JSON.parse(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Sanitise user input for FTS5 queries.
   * FTS5 has special syntax — we escape it for safety and
   * split words so partial matches work.
   */
  private sanitiseFtsQuery(query: string): string {
    // Remove FTS5 special chars, then join words with OR for broader recall
    const cleaned = query.replace(/['"*(){}[\]:^~!@#$%&\\]/g, '');
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length === 0) return '""';
    // Quote each word for exact token matching, join with OR
    return words.map((w) => `"${w}"`).join(' OR ');
  }
}
