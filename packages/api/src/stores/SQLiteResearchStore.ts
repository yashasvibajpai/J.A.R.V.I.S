import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { LLMTokenUsage, Message } from '@jarvis/shared';
import type { ResearchAttemptOutcome } from '../engine/SmartRouter.js';
import { ResearchWorkspace, type ClaimVerdict } from './ResearchWorkspace.js';

export interface ResearchFinding {
  claim: string;
  source: string;
  url?: string;
  timestamp?: string;
  claimId?: string;
  verdict?: ClaimVerdict;
}

export type ResearchDepth = 'brief' | 'deep';

export interface ResearchStep {
  id: string;
  sessionId: string;
  stepNumber: number;
  stepType: 'decompose' | 'search_explore' | 'fact_check' | 'synthesize'
    | 'deep_plan' | 'deep_search' | 'deep_open' | 'deep_review' | 'deep_verify' | 'deep_publish';
  title: string;
  query?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'superseded';
  evidence?: any;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ResearchUsage extends LLMTokenUsage {
  providerId: string;
  modelId: string;
  phase: ResearchStep['stepType'];
  outcome: ResearchAttemptOutcome | 'in_flight';
  retry: boolean;
  estimated: boolean;
}

export interface ResearchSession {
  id: string;
  topic: string;
  depth: ResearchDepth;
  status: 'pending' | 'in_progress' | 'completed' | 'paused' | 'failed' | 'stopping' | 'stopped' | 'cancelled';
  progress: number;
  currentStepTitle?: string;
  totalSteps: number;
  findings: ResearchFinding[];
  finalReport?: string;
  reportPath?: string;
  pdfPath?: string;
  error?: string;
  retryAt?: number;
  createdAt: string;
  updatedAt: string;
}

export class SQLiteResearchStore {
  private db: Database.Database;
  readonly workspace: ResearchWorkspace;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.workspace = new ResearchWorkspace(this.db);
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

      CREATE TABLE IF NOT EXISTS research_model_attempts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL REFERENCES research_steps(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'in_flight',
        retry INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        estimated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_research_attempts_session ON research_model_attempts(session_id);

      CREATE TABLE IF NOT EXISTS research_worker (
        slot INTEGER PRIMARY KEY CHECK(slot = 1),
        owner TEXT NOT NULL,
        pid INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    const migrateColumns = this.db.transaction(() => {
      const sessionColumns = this.db.pragma('table_info(research_sessions)') as Array<{ name: string }>;
      const stepColumns = this.db.pragma('table_info(research_steps)') as Array<{ name: string }>;
      const attemptColumns = this.db.pragma('table_info(research_model_attempts)') as Array<{ name: string }>;
      for (const column of ['started_at', 'finished_at', 'error_detail', 'prompt', 'response']) {
        if (!attemptColumns.some(item => item.name === column)) this.db.exec(`ALTER TABLE research_model_attempts ADD COLUMN ${column} TEXT`);
      }
      if (!sessionColumns.some(column => column.name === 'retry_at')) {
        this.db.exec('ALTER TABLE research_sessions ADD COLUMN retry_at INTEGER');
      }
      if (!sessionColumns.some(column => column.name === 'depth')) {
        this.db.exec("ALTER TABLE research_sessions ADD COLUMN depth TEXT NOT NULL DEFAULT 'brief'");
      }
      if (!stepColumns.some(column => column.name === 'attempt_token')) {
        this.db.exec('ALTER TABLE research_steps ADD COLUMN attempt_token TEXT; ALTER TABLE research_steps ADD COLUMN lease_until INTEGER');
      }
    });
    migrateColumns.immediate();
  }

  workerPid(): number | undefined {
    const row = this.db.prepare('SELECT pid FROM research_worker WHERE expires_at > ?').get(Date.now()) as { pid: number } | undefined;
    return row?.pid;
  }

  acquireWorker(owner: string, pid: number): boolean {
    return this.db.transaction(() => {
      const existing = this.workerPid();
      if (existing) {
        try {
          process.kill(existing, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
        }
      }
      this.db.prepare('REPLACE INTO research_worker VALUES (1, ?, ?, ?)').run(owner, pid, Date.now() + 15_000);
      this.db.prepare("UPDATE research_model_attempts SET outcome = 'aborted' WHERE outcome = 'in_flight'").run();
      this.db.prepare(`UPDATE research_steps SET status = 'pending', attempt_token = NULL, lease_until = NULL WHERE status = 'running'`).run();
      this.db.prepare(`UPDATE research_sessions SET status = 'failed', error = 'No executable research checkpoint was found'
        WHERE status IN ('pending', 'in_progress')
        AND NOT EXISTS (SELECT 1 FROM research_steps WHERE session_id = research_sessions.id AND status = 'pending')`).run();
      return true;
    }).immediate();
  }

  renewWorker(owner: string): boolean {
    return Boolean(this.db.prepare('UPDATE research_worker SET expires_at = ? WHERE owner = ?')
      .run(Date.now() + 15_000, owner).changes);
  }

  hasUnfinishedWork(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM research_sessions WHERE status IN ('pending', 'in_progress', 'stopping') LIMIT 1").get());
  }

  releaseWorkerWhenIdle(owner: string): boolean {
    return this.db.transaction(() => {
      if (this.hasUnfinishedWork()) return false;
      this.db.prepare('DELETE FROM research_worker WHERE owner = ?').run(owner);
      return true;
    }).immediate();
  }

  acquireStop(id: string, recovery = false): boolean {
    return this.db.transaction(() => {
      if (recovery) {
        const changed = this.db.prepare(`UPDATE research_sessions SET retry_at = ? WHERE id = ? AND status = 'stopping'
          AND (retry_at IS NULL OR retry_at <= ?)`).run(Date.now() + 20_000, id, Date.now());
        return Boolean(changed.changes);
      }
      if (!this.transition(id, 'stopping', ['pending', 'paused', 'in_progress'])) return false;
      this.updateSession(id, { retryAt: Date.now() + 20_000 });
      return true;
    }).immediate();
  }

  interruptedStop(): string | undefined {
    const row = this.db.prepare(`SELECT id FROM research_sessions WHERE status = 'stopping'
      AND (retry_at IS NULL OR retry_at <= ?) ORDER BY updated_at LIMIT 1`).get(Date.now()) as { id: string } | undefined;
    return row?.id;
  }

  completeStop(id: string, apply: () => void): void {
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM research_sessions WHERE id = ? AND status = 'stopping'").get(id)) apply();
    }).immediate();
  }

  steerDeepMission<T>(id: string, reopen: boolean, apply: (session: ResearchSession) => T): T {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM research_sessions WHERE id = ?').get(id);
      if (!row) throw new Error('Research mission was not found');
      const session = this.mapSessionRow(row);
      if (session.depth !== 'deep') throw new Error('Live steering is available on deep missions');
      if (reopen ? !['completed', 'stopped', 'failed'].includes(session.status)
        : !['pending', 'in_progress', 'paused'].includes(session.status)) {
        throw new Error('This instruction cannot be applied in the current state');
      }
      this.db.prepare(`UPDATE research_steps SET status = 'superseded', attempt_token = NULL, lease_until = NULL
        WHERE session_id = ? AND status IN ('pending', 'running')`).run(id);
      const result = apply(session);
      this.updateSession(id, {
        status: reopen ? 'pending' : session.status,
        currentStepTitle: reopen ? 'Research reopened' : 'Research plan updated',
        retryAt: 0,
        error: '',
      });
      return result;
    }).immediate();
  }

  enqueueStep(sessionId: string, stepType: ResearchStep['stepType'], title: string, evidence?: unknown, query?: string): ResearchStep {
    const row = this.db.prepare('SELECT COALESCE(MAX(step_number), 0) + 1 AS next FROM research_steps WHERE session_id = ?')
      .get(sessionId) as { next: number };
    const step = this.addStep({ sessionId, stepNumber: row.next, stepType, title, evidence, query, status: 'pending' });
    this.updateSession(sessionId, { totalSteps: row.next });
    return step;
  }

  startModelAttempt(step: ResearchStep, providerId: string, modelId: string, retry: boolean, messages?: Message[]): string {
    const id = uuid();
    this.db.prepare(`INSERT INTO research_model_attempts (id, session_id, step_id, provider_id, model_id, retry, started_at, prompt)
      VALUES (?, ?, ?, ?, ?, CASE WHEN ? OR EXISTS (
        SELECT 1 FROM research_model_attempts WHERE step_id = ?
      ) THEN 1 ELSE 0 END, ?, ?)`)
      .run(id, step.sessionId, step.id, providerId, modelId, Number(retry), step.id, new Date().toISOString(),
        messages && process.env.JARVIS_RESEARCH_TRACE === 'true' ? JSON.stringify(messages) : null);
    return id;
  }

  finishModelAttempt(id: string, outcome: ResearchAttemptOutcome, usage?: LLMTokenUsage, estimated = false, details?: { error?: string; response?: string }): void {
    const error = details?.error?.replace(/(bearer\s+|api[_ -]?key[=: ]+|token[=: ]+)[^\s"',]+/gi, '$1[redacted]').slice(0, 500);
    this.db.prepare(`UPDATE research_model_attempts SET outcome = ?, input_tokens = ?, output_tokens = ?,
      total_tokens = ?, estimated = ?, finished_at = ?, error_detail = ?, response = ? WHERE id = ? AND outcome = 'in_flight'`)
      .run(outcome, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.totalTokens ?? null, Number(estimated),
        new Date().toISOString(), error ?? null, process.env.JARVIS_RESEARCH_TRACE === 'true' ? details?.response ?? null : null, id);
  }

  getAttemptDetails(sessionId: string, traces = false) {
    return this.db.prepare(`SELECT a.id, s.step_number AS step, a.provider_id AS provider, a.model_id AS model, a.outcome,
      a.started_at AS startedAt, a.finished_at AS finishedAt, a.error_detail AS error
      ${traces ? ', a.prompt, a.response' : ''}
      FROM research_model_attempts a JOIN research_steps s ON s.id = a.step_id WHERE a.session_id = ? ORDER BY a.rowid`)
      .all(sessionId) as { id: string; step: number; provider: string; model: string; outcome: string;
        startedAt: string | null; finishedAt: string | null; error: string | null; prompt?: string; response?: string }[];
  }

  getUsage(sessionId: string): ResearchUsage[] {
    const rows = this.db.prepare(`SELECT a.provider_id AS providerId, a.model_id AS modelId, s.step_type AS phase,
      a.outcome, a.retry, a.input_tokens AS inputTokens, a.output_tokens AS outputTokens,
      a.total_tokens AS totalTokens, a.estimated FROM research_model_attempts a
      JOIN research_steps s ON a.step_id = s.id WHERE a.session_id = ? ORDER BY a.rowid`)
      .all(sessionId) as Array<{
        providerId: string; modelId: string; phase: ResearchUsage['phase']; outcome: ResearchUsage['outcome'];
        retry: number; estimated: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
      }>;
    return rows.map(row => ({
      ...row,
      retry: Boolean(row.retry),
      estimated: Boolean(row.estimated),
      inputTokens: row.inputTokens ?? undefined,
      outputTokens: row.outputTokens ?? undefined,
      totalTokens: row.totalTokens ?? undefined,
    }));
  }

  transition(id: string, status: ResearchSession['status'], allowed: ResearchSession['status'][]): boolean {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const updated = this.db.prepare(`UPDATE research_sessions SET status = ?, updated_at = ?, retry_at = NULL
        WHERE id = ? AND status IN (${allowed.map(() => '?').join(',')})`).run(status, now, id, ...allowed);
      if (!updated.changes) return false;
      this.db.prepare(`UPDATE research_steps SET status = 'pending', attempt_token = NULL, lease_until = NULL
        WHERE session_id = ? AND status = 'running'`).run(id);
      return true;
    }).immediate();
  }

  claimStep(step: ResearchStep): string | null {
    const token = uuid();
    const claim = this.db.prepare(`UPDATE research_steps SET status = 'running', attempt_token = ?, lease_until = ?
      WHERE id = ? AND status = 'pending' AND EXISTS (
        SELECT 1 FROM research_sessions WHERE id = ? AND status = 'in_progress'
      ) AND NOT EXISTS (
        SELECT 1 FROM research_steps WHERE session_id = ? AND status = 'running'
      )`).run(token, Date.now() + 600_000, step.id, step.sessionId, step.sessionId);
    return claim.changes ? token : null;
  }

  isCurrent(step: ResearchStep, token: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM research_steps s JOIN research_sessions m ON s.session_id = m.id
      WHERE s.id = ? AND s.status = 'running' AND s.attempt_token = ? AND m.status = 'in_progress'`).get(step.id, token));
  }

  commitStep(step: ResearchStep, token: string, apply: () => void, status: ResearchStep['status'] = 'completed'): boolean {
    return this.db.transaction(() => {
      if (!this.isCurrent(step, token)) return false;
      apply();
      this.updateStep(step.id, {
        status,
        ...(status !== 'pending' && { completedAt: new Date().toISOString() }),
      });
      return true;
    }).immediate();
  }

  recoverExpiredSteps(): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE research_model_attempts SET outcome = 'aborted' WHERE outcome = 'in_flight'
        AND step_id IN (SELECT id FROM research_steps WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ?))`).run(Date.now());
      this.db.prepare(`UPDATE research_steps SET status = 'pending', attempt_token = NULL, lease_until = NULL
        WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ?)`).run(Date.now());
    }).immediate();
  }

  createMission(topic: string, depth: ResearchDepth = 'brief'): ResearchSession {
    return this.db.transaction(() => {
      const session = this.createSession(topic, depth === 'deep' ? 1 : 6, depth);
      this.addStep({
        sessionId: session.id,
        stepNumber: 1,
        stepType: depth === 'deep' ? 'deep_plan' : 'decompose',
        title: 'Plan research questions',
        status: 'pending',
      });
      return session;
    }).immediate();
  }

  createSession(topic: string, totalSteps = 5, depth: ResearchDepth = 'brief'): ResearchSession {
    const id = `res_${uuid().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO research_sessions (
          id, topic, status, progress, current_step_title, total_steps, findings, created_at, updated_at, depth
        ) VALUES (?, ?, 'pending', 0, 'Mission Initialized', ?, '[]', ?, ?, ?)`
      )
      .run(id, topic, totalSteps, now, now, depth);

    return {
      id,
      topic,
      depth,
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

  async getActiveSession(eligibleOnly = false): Promise<ResearchSession | null> {
    const row = this.db
      .prepare(`SELECT * FROM research_sessions WHERE status = 'in_progress'
        AND (? = 0 OR (
          (retry_at IS NULL OR retry_at <= ?)
          AND EXISTS (SELECT 1 FROM research_steps WHERE session_id = research_sessions.id AND status = 'pending')
          AND NOT EXISTS (SELECT 1 FROM research_steps WHERE session_id = research_sessions.id AND status = 'running')
        )) ORDER BY updated_at ASC LIMIT 1`)
      .get(Number(eligibleOnly), Date.now()) as any;
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

  updateSession(id: string, updates: Partial<ResearchSession>, expectedStatus?: ResearchSession['status']): void {
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
    if (updates.retryAt !== undefined) {
      fields.push('retry_at = ?');
      values.push(updates.retryAt || null);
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());

    values.push(id);
    if (expectedStatus) values.push(expectedStatus);
    this.db.prepare(`UPDATE research_sessions SET ${fields.join(', ')} WHERE id = ?${expectedStatus ? ' AND status = ?' : ''}`).run(...values);
  }

  addStep(step: Omit<ResearchStep, 'id' | 'createdAt' | 'completedAt'>): ResearchStep {
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

  updateStep(id: string, updates: Partial<ResearchStep>): void {
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
      depth: row.depth === 'deep' ? 'deep' : 'brief',
      status: row.status,
      progress: row.progress,
      currentStepTitle: row.current_step_title,
      totalSteps: row.total_steps,
      findings: row.findings ? JSON.parse(row.findings) : [],
      finalReport: row.final_report,
      reportPath: row.report_path,
      pdfPath: row.pdf_path,
      error: row.error,
      retryAt: row.retry_at ?? undefined,
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
