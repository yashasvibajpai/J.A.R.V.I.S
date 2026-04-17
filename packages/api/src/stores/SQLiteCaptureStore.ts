import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Capture, CaptureStore } from '@jarvis/shared';

export class SQLiteCaptureStore implements CaptureStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'thought',
        processed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
  }

  async createCapture(capture: Omit<Capture, 'id' | 'createdAt' | 'processed'>): Promise<Capture> {
    const id = uuid();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO captures (id, content, category, processed, created_at)
         VALUES (?, ?, ?, 0, ?)`
      )
      .run(id, capture.content, capture.category, now);

    return {
      id,
      content: capture.content,
      category: capture.category,
      processed: false,
      createdAt: now,
    };
  }

  async markProcessed(id: string): Promise<Capture> {
    const row = this.db.prepare('SELECT * FROM captures WHERE id = ?').get(id) as any;
    if (!row) throw new Error(`Capture ${id} not found`);

    this.db.prepare('UPDATE captures SET processed = 1 WHERE id = ?').run(id);

    return {
      ...this.rowToCapture(row),
      processed: true,
    };
  }

  async deleteCapture(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM captures WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async getUnprocessedCaptures(): Promise<Capture[]> {
    const rows = this.db
      .prepare('SELECT * FROM captures WHERE processed = 0 ORDER BY created_at ASC')
      .all() as any[];
    return rows.map(this.rowToCapture);
  }

  close(): void {
    this.db.close();
  }

  private rowToCapture(row: any): Capture {
    return {
      id: row.id,
      content: row.content,
      category: row.category as Capture['category'],
      processed: row.processed === 1,
      createdAt: row.created_at,
    };
  }
}
