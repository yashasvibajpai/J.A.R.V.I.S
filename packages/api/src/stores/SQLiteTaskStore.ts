import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Task, TaskStore } from '@jarvis/shared';

export class SQLiteTaskStore implements TaskStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        due_date TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async createTask(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<Task> {
    const id = uuid();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO tasks (id, description, status, priority, due_date, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        task.description,
        task.status,
        task.priority,
        task.dueDate || null,
        JSON.stringify(task.tags || []),
        now,
        now
      );

    return {
      id,
      description: task.description,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      tags: task.tags || [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task> {
    const now = new Date().toISOString();
    
    const currentTask = await this.getTask(id);
    if (!currentTask) throw new Error(`Task ${id} not found`);

    const updatedTask = { ...currentTask, ...updates, updatedAt: now };

    this.db
      .prepare(
        `UPDATE tasks 
         SET description = ?, status = ?, priority = ?, due_date = ?, tags = ?, updated_at = ? 
         WHERE id = ?`
      )
      .run(
        updatedTask.description,
        updatedTask.status,
        updatedTask.priority,
        updatedTask.dueDate || null,
        JSON.stringify(updatedTask.tags),
        now,
        id
      );

    return updatedTask;
  }

  async deleteTask(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async getTask(id: string): Promise<Task | null> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToTask(row);
  }

  async queryTasks(options?: { status?: Task['status']; tags?: string[] }): Promise<Task[]> {
    let query = 'SELECT * FROM tasks WHERE 1=1';
    const params: any[] = [];

    if (options?.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }
    
    query += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(query).all(...params) as any[];
    let tasks = rows.map(this.rowToTask);

    if (options?.tags && options.tags.length > 0) {
      tasks = tasks.filter((t) => options.tags!.some((tag) => t.tags.includes(tag)));
    }

    return tasks;
  }

  close(): void {
    this.db.close();
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id,
      description: row.description,
      status: row.status as Task['status'],
      priority: row.priority as Task['priority'],
      dueDate: row.due_date,
      tags: JSON.parse(row.tags),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
