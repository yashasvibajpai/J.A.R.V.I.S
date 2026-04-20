import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Message } from '@jarvis/shared';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
}

export class SQLiteSessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    `);
  }

  createSession(title: string = 'New Chat'): ChatSession {
    const session: ChatSession = {
      id: uuidv4(),
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const stmt = this.db.prepare(
      'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    );
    stmt.run(session.id, session.title, session.createdAt, session.updatedAt);

    return session;
  }

  getAllSessions(): ChatSession[] {
    const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
    const rows = stmt.all() as any[];
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getSession(id: string): ChatSession | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  deleteSession(id: string): void {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    stmt.run(id);
  }

  updateSessionTitle(id: string, title: string): void {
    const stmt = this.db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?');
    stmt.run(title, Date.now(), id);
  }

  getMessages(sessionId: string): Message[] {
    const stmt = this.db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(sessionId) as any[];
    return rows.map(r => ({
      role: r.role,
      content: r.content,
    }));
  }

  appendMessage(sessionId: string, message: Message): void {
    const stmt = this.db.prepare(
      'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run(uuidv4(), sessionId, message.role, message.content, Date.now());

    // Update session timestamp
    const updateStmt = this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
    updateStmt.run(Date.now(), sessionId);
  }
}
