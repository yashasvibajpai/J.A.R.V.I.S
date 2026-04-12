import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { UserProfile, ProfileStore } from '@jarvis/shared';

/**
 * SQLite-backed ProfileStore with version history.
 *
 * Every profile update creates a history snapshot so we can track
 * how JARVIS's understanding of the user evolves over time.
 */
export class SQLiteProfileStore implements ProfileStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        preferred_name TEXT,
        preferences TEXT NOT NULL DEFAULT '{}',
        context TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS profile_history (
        history_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        name TEXT NOT NULL,
        preferred_name TEXT,
        preferences TEXT NOT NULL,
        context TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES profiles(id)
      );

      CREATE INDEX IF NOT EXISTS idx_profile_history_id
        ON profile_history(profile_id, version DESC);
    `);
  }

  async initProfile(id: string, name: string): Promise<UserProfile> {
    const now = new Date().toISOString();
    const existing = await this.getProfile(id);
    if (existing) return existing;

    this.db
      .prepare(
        `INSERT INTO profiles (id, name, preferences, context, updated_at, version)
         VALUES (?, ?, '{}', '{}', ?, 1)`
      )
      .run(id, name, now);

    return {
      id,
      name,
      preferences: {},
      context: {},
      updatedAt: now,
      version: 1,
    };
  }

  async getProfile(id: string): Promise<UserProfile | null> {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToProfile(row);
  }

  async updateProfile(id: string, updates: Partial<UserProfile>): Promise<UserProfile> {
    const current = await this.getProfile(id);
    if (!current) {
      throw new Error(`Profile ${id} not found. Call initProfile() first.`);
    }

    // Deep merge preferences and context
    const merged: UserProfile = {
      ...current,
      ...updates,
      preferences: { ...current.preferences, ...(updates.preferences ?? {}) },
      context: { ...current.context, ...(updates.context ?? {}) },
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    // Save current state to history before updating
    this.db
      .prepare(
        `INSERT INTO profile_history (history_id, profile_id, name, preferred_name, preferences, context, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        uuid(),
        current.id,
        current.name,
        current.preferredName ?? null,
        JSON.stringify(current.preferences),
        JSON.stringify(current.context),
        current.updatedAt,
        current.version
      );

    // Update the current profile
    this.db
      .prepare(
        `UPDATE profiles
         SET name = ?, preferred_name = ?, preferences = ?, context = ?, updated_at = ?, version = ?
         WHERE id = ?`
      )
      .run(
        merged.name,
        merged.preferredName ?? null,
        JSON.stringify(merged.preferences),
        JSON.stringify(merged.context),
        merged.updatedAt,
        merged.version,
        merged.id
      );

    return merged;
  }

  async getProfileHistory(id: string, limit = 10): Promise<UserProfile[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM profile_history WHERE profile_id = ? ORDER BY version DESC LIMIT ?`
      )
      .all(id, limit) as any[];

    return rows.map((row: any) => ({
      id: row.profile_id,
      name: row.name,
      preferredName: row.preferred_name ?? undefined,
      preferences: JSON.parse(row.preferences),
      context: JSON.parse(row.context),
      updatedAt: row.updated_at,
      version: row.version,
    }));
  }

  close(): void {
    this.db.close();
  }

  private rowToProfile(row: any): UserProfile {
    return {
      id: row.id,
      name: row.name,
      preferredName: row.preferred_name ?? undefined,
      preferences: JSON.parse(row.preferences),
      context: JSON.parse(row.context),
      updatedAt: row.updated_at,
      version: row.version,
    };
  }
}
