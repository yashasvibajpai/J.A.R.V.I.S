import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type ResearchLens = 'breadth' | 'depth' | 'tangent';
export type ClaimVerdict = 'single-source' | 'corroborated' | 'disputed' | 'under-review' | 'insufficient';
export type SourceFailure = 'forbidden' | 'size_limit' | 'access_required' | 'no_pdf_text';

export interface ResearchQuestion {
  id: string;
  lens: ResearchLens;
  question: string;
  rationale: string;
  priority: number;
  status: 'open' | 'answered' | 'exhausted' | 'deferred';
  tried: string[];
  sourceIds?: string[];
  leadSourceId?: string;
  noProgress?: number;
  nextQuery?: string;
  recoveryRoutes?: string[];
  publicCopyAttempts?: string[];
  closure?: string;
  reason?: string;
  claimId?: string;
}

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  family: string;
  retrievedAt: string;
  hash?: string;
  requestedUrl?: string;
  error?: string;
  failure?: SourceFailure;
  alternativeFor?: string;
  passages: { locator: string; text: string }[];
}

export interface ResearchClaim {
  id: string;
  questionId: string;
  text: string;
  verdict: ClaimVerdict;
  audit?: 'checked' | 'needs-review';
  supersededBy?: string;
  evidence: { sourceId: string; locator: string; quote: string; relation: 'supports' | 'contradicts' | 'qualifies' }[];
  previous?: { text: string; verdict: ClaimVerdict; evidence: ResearchClaim['evidence'] }[];
}

export interface ResearchInstruction {
  kind: 'focus' | 'explore' | 'fact-check';
  text: string;
  questionId: string;
  submittedAt: string;
}

export interface DeepResearchState {
  planned?: boolean;
  questions: ResearchQuestion[];
  sources: ResearchSource[];
  claims: ResearchClaim[];
  instructions: ResearchInstruction[];
  briefingId?: string;
  stopReason?: string;
  synthesis?: { status: 'draft' | 'ready'; briefing: ResearchBriefing } | { status: 'unavailable'; reason: string };
}

export interface ResearchBriefingPoint {
  text: string;
  claimIds: string[];
}

export interface ResearchBriefing {
  summary: ResearchBriefingPoint[];
  sections: { heading: string; points: ResearchBriefingPoint[] }[];
  implications: ResearchBriefingPoint[];
}

export interface ResearchDocument {
  id: string;
  sessionId: string;
  title: string;
  revision: number;
  markdown: string;
  operation: string;
  createdAt: string;
}

export class ResearchWorkspace {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_deep_state (
        session_id TEXT PRIMARY KEY REFERENCES research_sessions(id) ON DELETE CASCADE,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_documents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_research_documents_session ON research_documents(session_id);
      CREATE TABLE IF NOT EXISTS research_document_revisions (
        document_id TEXT NOT NULL REFERENCES research_documents(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        operation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (document_id, revision)
      );
    `);
  }

  getState(sessionId: string): DeepResearchState | undefined {
    const row = this.db.prepare('SELECT state FROM research_deep_state WHERE session_id = ?').get(sessionId) as { state: string } | undefined;
    return row && JSON.parse(row.state);
  }

  saveState(sessionId: string, state: DeepResearchState): void {
    this.db.prepare(`INSERT INTO research_deep_state VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET state = excluded.state`).run(sessionId, JSON.stringify(state));
  }

  listDocuments(sessionId: string): ResearchDocument[] {
    return this.db.prepare(`SELECT d.id, d.session_id AS sessionId, d.title, r.revision, r.markdown, r.operation, r.created_at AS createdAt
      FROM research_documents d JOIN research_document_revisions r ON r.document_id = d.id AND r.revision = d.revision
      WHERE d.session_id = ? ORDER BY d.rowid`).all(sessionId) as ResearchDocument[];
  }

  getDocument(sessionId: string, documentId: string, revision?: number): ResearchDocument | undefined {
    return this.db.prepare(`SELECT d.id, d.session_id AS sessionId, d.title, r.revision, r.markdown, r.operation, r.created_at AS createdAt
      FROM research_documents d JOIN research_document_revisions r ON r.document_id = d.id AND r.revision = COALESCE(?, d.revision)
      WHERE d.session_id = ? AND d.id = ?`).get(revision ?? null, sessionId, documentId) as ResearchDocument | undefined;
  }

  history(sessionId: string, documentId: string): Pick<ResearchDocument, 'revision' | 'operation' | 'createdAt'>[] {
    return this.db.prepare(`SELECT r.revision, r.operation, r.created_at AS createdAt
      FROM research_document_revisions r JOIN research_documents d ON r.document_id = d.id
      WHERE d.session_id = ? AND d.id = ? ORDER BY r.revision DESC`).all(sessionId, documentId) as ResearchDocument[];
  }

  createDocument(sessionId: string, title: string, markdown = `# ${title}\n`, operation = 'created'): ResearchDocument {
    return this.db.transaction(() => {
      const id = `doc_${randomUUID().slice(0, 8)}`;
      this.db.prepare('INSERT INTO research_documents VALUES (?, ?, ?, 1)').run(id, sessionId, title);
      return this.addRevision({ id, sessionId, title, revision: 1, markdown, operation, createdAt: new Date().toISOString() });
    }).immediate();
  }

  reviseDocument(document: ResearchDocument, markdown: string, operation: string): ResearchDocument {
    return this.db.transaction(() => {
      const revision = document.revision + 1;
      const changed = this.db.prepare('UPDATE research_documents SET revision = ? WHERE id = ? AND session_id = ? AND revision = ?')
        .run(revision, document.id, document.sessionId, document.revision);
      if (changed.changes !== 1) throw new Error('Document has a newer revision. Inspect it and retry your edit.');
      return this.addRevision({ ...document, revision, markdown, operation, createdAt: new Date().toISOString() });
    }).immediate();
  }

  private addRevision(document: ResearchDocument): ResearchDocument {
    this.db.prepare('INSERT INTO research_document_revisions VALUES (?, ?, ?, ?, ?)')
      .run(document.id, document.revision, document.markdown, document.operation, document.createdAt);
    return document;
  }
}
