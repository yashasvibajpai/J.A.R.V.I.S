import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Reminder, ReminderStore } from '@jarvis/shared';

export class SQLiteReminderStore implements ReminderStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        trigger_time TEXT,
        trigger_context TEXT,
        snoozed_until TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
  }

  async createReminder(reminder: Omit<Reminder, 'id' | 'createdAt'>): Promise<Reminder> {
    const id = uuid();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO reminders (id, description, trigger_time, trigger_context, snoozed_until, completed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        reminder.description,
        reminder.triggerTime || null,
        reminder.triggerContext || null,
        reminder.snoozedUntil || null,
        reminder.completed ? 1 : 0,
        now
      );

    return {
      id,
      ...reminder,
      createdAt: now,
    };
  }

  async updateReminder(id: string, updates: Partial<Reminder>): Promise<Reminder> {
    const row = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    if (!row) throw new Error(`Reminder ${id} not found`);

    const currentReminder = this.rowToReminder(row);
    const updated = { ...currentReminder, ...updates };

    this.db
      .prepare(
        `UPDATE reminders 
         SET description = ?, trigger_time = ?, trigger_context = ?, snoozed_until = ?, completed = ? 
         WHERE id = ?`
      )
      .run(
        updated.description,
        updated.triggerTime || null,
        updated.triggerContext || null,
        updated.snoozedUntil || null,
        updated.completed ? 1 : 0,
        id
      );

    return updated;
  }

  async deleteReminder(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async getPendingReminders(): Promise<Reminder[]> {
    const rows = this.db
      .prepare('SELECT * FROM reminders WHERE completed = 0 ORDER BY created_at ASC')
      .all() as any[];
    return rows.map(this.rowToReminder);
  }

  close(): void {
    this.db.close();
  }

  private rowToReminder(row: any): Reminder {
    return {
      id: row.id,
      description: row.description,
      triggerTime: row.trigger_time,
      triggerContext: row.trigger_context,
      snoozedUntil: row.snoozed_until,
      completed: row.completed === 1,
      createdAt: row.created_at,
    };
  }
}
