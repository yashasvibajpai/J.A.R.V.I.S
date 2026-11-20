import Database from 'better-sqlite3';
import type { ProviderState } from '../engine/SmartRouter.js';

type StoredState = Omit<ProviderState, 'cooldownUntil' | 'lastUsed'> & {
  cooldownUntil: string | null;
  lastUsed: string | null;
};

export class SQLiteProviderQuota {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS provider_quota (
      provider_id TEXT PRIMARY KEY,
      state TEXT NOT NULL
    )`);
  }

  read(providerId: string): ProviderState | undefined {
    const row = this.db.prepare('SELECT state FROM provider_quota WHERE provider_id = ?').get(providerId) as { state: string } | undefined;
    if (!row) return;
    const state = JSON.parse(row.state) as StoredState;
    return {
      ...state,
      cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil) : null,
      lastUsed: state.lastUsed ? new Date(state.lastUsed) : null,
    };
  }

  update<T>(providerId: string, initial: ProviderState, apply: (state: ProviderState) => T): T {
    return this.db.transaction(() => {
      const state = this.read(providerId) ?? initial;
      const result = apply(state);
      this.db.prepare(`INSERT INTO provider_quota VALUES (?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET state = excluded.state`).run(providerId, JSON.stringify(state));
      return result;
    }).immediate();
  }
}
