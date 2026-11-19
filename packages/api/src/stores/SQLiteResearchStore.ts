import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export interface ResearchFinding {
  claim: string;
  source: string;
  url?: string;
  timestamp?: string;
}

export interface ResearchStep {
  id: string;
  sessionId: string;
  stepNumber: number;
  stepType: 'decompose' | 'search_explore' | 'fact_check' | 'synthesize';
  title: string;
  query?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  evidence?: any;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ResearchSession {
  id: string;
  topic: string;
  status: 'pending' | 'in_progress' | 'completed' | 'paused' | 'failed';
  progress: number;
  currentStepTitle?: string;
  totalSteps: number;
  findings: ResearchFinding[];
  finalReport?: string;
  reportPath?: string;
  pdfPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export class SQLiteResearchStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_sessions (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        progress INTEGER NOT NULL DEFAULT 0,
        current_step_title TEXT,
        total_steps INTEGER NOT NULL DEFAULT 5,
        findings TEXT NOT NULL DEFAULT '[]',
        final_report TEXT,
        report_path TEXT,
        pdf_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_steps (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        title TEXT NOT NULL,
        query TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        evidence TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES research_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_research_steps_session ON research_steps(session_id, step_number);
    `);
  }

  async createSession(topic: string, totalSteps = 5): Promise<ResearchSession> {
    const id = `res_${uuid().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO research_sessions (
          id, topic, status, progress, current_step_title, total_steps, findings, created_at, updated_at
        ) VALUES (?, ?, 'pending', 0, 'Mission Initialized', ?, '[]', ?, ?)`
      )
      .run(id, topic, totalSteps, now, now);

    return {
      id,
      topic,
      status: 'pending',
      progress: 0,
      currentStepTitle: 'Mission Initialized',
      totalSteps,
      findings: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async getSession(id: string): Promise<ResearchSession | null> {
    const row = this.db.prepare(`SELECT * FROM research_sessions WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return this.mapSessionRow(row);
  }

  async getActiveSession(): Promise<ResearchSession | null> {
    const row = this.db
      .prepare(`SELECT * FROM research_sessions WHERE status = 'in_progress' ORDER BY updated_at ASC LIMIT 1`)
      .get() as any;
    if (!row) return null;
    return this.mapSessionRow(row);
  }

  async getNextPendingSession(): Promise<ResearchSession | null> {
    const row = this.db
      .prepare(`SELECT * FROM research_sessions WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`)
      .get() as any;
    if (!row) return null;
    return this.mapSessionRow(row);
  }

  async listSessions(limit = 10): Promise<ResearchSession[]> {
    const rows = this.db
      .prepare(`SELECT * FROM research_sessions ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => this.mapSessionRow(r));
  }

  async updateSession(id: string, updates: Partial<ResearchSession>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.progress !== undefined) {
      fields.push('progress = ?');
      values.push(updates.progress);
    }
    if (updates.currentStepTitle !== undefined) {
      fields.push('current_step_title = ?');
      values.push(updates.currentStepTitle);
    }
    if (updates.totalSteps !== undefined) {
      fields.push('total_steps = ?');
      values.push(updates.totalSteps);
    }
    if (updates.findings !== undefined) {
      fields.push('findings = ?');
      values.push(JSON.stringify(updates.findings));
    }
    if (updates.finalReport !== undefined) {
      fields.push('final_report = ?');
      values.push(updates.finalReport);
    }
    if (updates.reportPath !== undefined) {
      fields.push('report_path = ?');
      values.push(updates.reportPath);
    }
    if (updates.pdfPath !== undefined) {
      fields.push('pdf_path = ?');
      values.push(updates.pdfPath);
    }
    if (updates.error !== undefined) {
      fields.push('error = ?');
      values.push(updates.error);
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());

    values.push(id);
    this.db.prepare(`UPDATE research_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  async addStep(step: Omit<ResearchStep, 'id' | 'createdAt' | 'completedAt'>): Promise<ResearchStep> {
    const id = `step_${uuid().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO research_steps (
          id, session_id, step_number, step_type, title, query, status, evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        step.sessionId,
        step.stepNumber,
        step.stepType,
        step.title,
        step.query || null,
        step.status || 'pending',
        step.evidence ? JSON.stringify(step.evidence) : null,
        now
      );

    return {
      id,
      sessionId: step.sessionId,
      stepNumber: step.stepNumber,
      stepType: step.stepType,
      title: step.title,
      query: step.query,
      status: step.status || 'pending',
      evidence: step.evidence,
      createdAt: now,
    };
  }

  async getSteps(sessionId: string): Promise<ResearchStep[]> {
    const rows = this.db
      .prepare(`SELECT * FROM research_steps WHERE session_id = ? ORDER BY step_number ASC`)
      .all(sessionId) as any[];
    return rows.map((r) => this.mapStepRow(r));
  }

  async getNextPendingStep(sessionId: string): Promise<ResearchStep | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM research_steps 
         WHERE session_id = ? AND status = 'pending' 
         ORDER BY step_number ASC LIMIT 1`
      )
      .get(sessionId) as any;
    if (!row) return null;
    return this.mapStepRow(row);
  }

  async updateStep(id: string, updates: Partial<ResearchStep>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.evidence !== undefined) {
      fields.push('evidence = ?');
      values.push(JSON.stringify(updates.evidence));
    }
    if (updates.error !== undefined) {
      fields.push('error = ?');
      values.push(updates.error);
    }
    if (updates.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(updates.completedAt);
    }

    values.push(id);
    this.db.prepare(`UPDATE research_steps SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  private mapSessionRow(row: any): ResearchSession {
    return {
      id: row.id,
      topic: row.topic,
      status: row.status,
      progress: row.progress,
      currentStepTitle: row.current_step_title,
      totalSteps: row.total_steps,
      findings: row.findings ? JSON.parse(row.findings) : [],
      finalReport: row.final_report,
      reportPath: row.report_path,
      pdfPath: row.pdf_path,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapStepRow(row: any): ResearchStep {
    return {
      id: row.id,
      sessionId: row.session_id,
      stepNumber: row.step_number,
      stepType: row.step_type,
      title: row.title,
      query: row.query,
      status: row.status,
      evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
      error: row.error,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}
