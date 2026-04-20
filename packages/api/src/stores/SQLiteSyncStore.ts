import Database from 'better-sqlite3';

export class SQLiteSyncStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_hashes (
        file_path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        last_synced DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  getHash(filePath: string): string | null {
    const stmt = this.db.prepare('SELECT hash FROM file_hashes WHERE file_path = ?');
    const row = stmt.get(filePath) as { hash: string } | undefined;
    return row ? row.hash : null;
  }

  setHash(filePath: string, hash: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO file_hashes (file_path, hash)
      VALUES (?, ?)
      ON CONFLICT(file_path) DO UPDATE SET hash = excluded.hash, last_synced = CURRENT_TIMESTAMP
    `);
    stmt.run(filePath, hash);
  }

  removeHash(filePath: string): void {
    const stmt = this.db.prepare('DELETE FROM file_hashes WHERE file_path = ?');
    stmt.run(filePath);
  }
}
