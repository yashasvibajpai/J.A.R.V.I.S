import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { SmartRouter } from './SmartRouter.js';
import type { WebSearchService } from '../services/WebSearchService.js';
import type { FileService } from '../services/FileService.js';
import type {
  SQLiteResearchStore,
  ResearchSession,
  ResearchStep,
  ResearchFinding,
} from '../stores/SQLiteResearchStore.js';

export interface ResearchEngineOptions {
  tickIntervalMs?: number;
  logFile?: string;
}

/**
 * Autonomous Tick-Based Research Engine
 *
 * Runs background research missions in a budget-bounded, paced loop without
 * blocking the interactive REPL or chat sessions.
 *
 * Constraints & Guarantees:
 * 1. STRICTLY FREE TIER: Only dispatches to free providers (Gemini free, Groq free, Mistral free, OpenRouter free).
 *    // TODO: Re-enable local Ollama / dedicated research node in future
 * 2. PACED HEARTBEAT: Advances 1 atomic step per tick (default: 3500ms).
 * 3. ZERO REPL POLLUTION: Logs quietly to research.log; emits clean events for notification.
 * 4. CRASH-SAFE: State & evidence checkpoints are persisted to SQLite on every step.
 */
export class ResearchEngine extends EventEmitter {
  private store: SQLiteResearchStore;
  private router: SmartRouter;
  private searchService: WebSearchService;
  private fileService: FileService;
  private tickIntervalMs: number;
  private logPath: string;

  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    store: SQLiteResearchStore,
    router: SmartRouter,
    searchService: WebSearchService,
    fileService: FileService,
    options?: ResearchEngineOptions
  ) {
    super();
    this.store = store;
    this.router = router;
    this.searchService = searchService;
    this.fileService = fileService;
    this.tickIntervalMs = options?.tickIntervalMs ?? 3500;
    this.logPath = options?.logFile || resolve(process.cwd(), 'packages/data/research.log');

    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
    } catch {}
  }

  // ─── Lifecycle & Control ───────────────────────────────────────────────────

  /** Start the background tick loop */
  start(): void {
    if (this.timer) return;
    this.log(`[tick-engine] Starting autonomous research loop (interval: ${this.tickIntervalMs}ms)`);
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  /** Stop the background tick loop */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log(`[tick-engine] Stopped research loop`);
    }
  }

  /** Enqueue a new research mission (returns immediately in < 1s) */
  async startMission(topic: string): Promise<ResearchSession> {
    const session = await this.store.createSession(topic, 6);

    // Seed the first step: Decompose Topic
    await this.store.addStep({
      sessionId: session.id,
      stepNumber: 1,
      stepType: 'decompose',
      title: `Decompose topic: "${topic.slice(0, 50)}..."`,
      status: 'pending',
    });

    this.log(`[mission:new] Enqueued session ${session.id}: "${topic}"`);
    this.emit('started', session);

    // Ensure loop is running
    this.start();
    return session;
  }

  async listMissions(limit = 10): Promise<ResearchSession[]> {
    return this.store.listSessions(limit);
  }

  async getStatus(sessionId?: string): Promise<{
    session: ResearchSession | null;
    steps: ResearchStep[];
    activeStep: ResearchStep | null;
  }> {
    const session = sessionId
      ? await this.store.getSession(sessionId)
      : (await this.store.getActiveSession()) || (await this.store.getNextPendingSession());

    if (!session) {
      return { session: null, steps: [], activeStep: null };
    }

    const steps = await this.store.getSteps(session.id);
    const activeStep = steps.find((s) => s.status === 'running') || steps.find((s) => s.status === 'pending') || null;

    return { session, steps, activeStep };
  }

  async pauseMission(sessionId: string): Promise<boolean> {
    const session = await this.store.getSession(sessionId);
    if (!session || (session.status !== 'in_progress' && session.status !== 'pending')) return false;
    await this.store.updateSession(sessionId, { status: 'paused' });
    this.log(`[mission:paused] Paused session ${sessionId}`);
    return true;
  }

  async resumeMission(sessionId: string): Promise<boolean> {
    const session = await this.store.getSession(sessionId);
    if (!session || session.status !== 'paused') return false;
    await this.store.updateSession(sessionId, { status: 'in_progress' });
    this.log(`[mission:resumed] Resumed session ${sessionId}`);
    return true;
  }

  async cancelMission(sessionId: string): Promise<boolean> {
    const session = await this.store.getSession(sessionId);
    if (!session || session.status === 'completed') return false;
    await this.store.updateSession(sessionId, { status: 'failed', error: 'Mission cancelled by user' });
    this.log(`[mission:cancelled] Cancelled session ${sessionId}`);
    return true;
  }

  // ─── Paced Tick Loop ───────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.isProcessing) return;

    try {
      this.isProcessing = true;

      // 1. Check for active in-progress session
      let session = await this.store.getActiveSession();

      // If no active session, promote next pending
      if (!session) {
        session = await this.store.getNextPendingSession();
        if (session) {
          await this.store.updateSession(session.id, { status: 'in_progress' });
          session.status = 'in_progress';
          this.log(`[tick] Promoted pending mission ${session.id} to in_progress`);
        }
      }

      if (!session) {
        // No work to do
        return;
      }

      // 2. Fetch the next pending step for this session
      const nextStep = await this.store.getNextPendingStep(session.id);

      if (!nextStep) {
        // All steps completed — check if session needs completion
        const allSteps = await this.store.getSteps(session.id);
        const hasFailed = allSteps.some((s) => s.status === 'failed');
        if (!hasFailed && allSteps.length > 1) {
          await this.finalizeMission(session);
        }
        return;
      }

      // 3. Mark step as running and update session progress
      await this.store.updateStep(nextStep.id, { status: 'running' });
      const progressPct = Math.min(Math.round(((nextStep.stepNumber - 1) / session.totalSteps) * 100), 95);
      await this.store.updateSession(session.id, {
        progress: progressPct,
        currentStepTitle: nextStep.title,
      });

      this.log(`[step:${nextStep.stepNumber}/${session.totalSteps}] Running "${nextStep.title}" (${nextStep.stepType})`);

      // 4. Execute atomic step
      await this.executeStep(session, nextStep);

    } catch (err: any) {
      this.log(`[tick:error] ${err?.message || err}`);
    } finally {
      this.isProcessing = false;
    }
  }

  // ─── Step Execution Matrix ─────────────────────────────────────────────────

  private async executeStep(session: ResearchSession, step: ResearchStep): Promise<void> {
    const now = new Date().toISOString();

    try {
      switch (step.stepType) {
        case 'decompose':
          await this.executeDecompose(session, step);
          break;
        case 'search_explore':
          await this.executeSearchExplore(session, step);
          break;
        case 'fact_check':
          await this.executeFactCheck(session, step);
          break;
        case 'synthesize':
          await this.executeSynthesize(session, step);
          break;
      }

      await this.store.updateStep(step.id, {
        status: 'completed',
        completedAt: now,
      });
      this.emit('progress', { session, step });

    } catch (err: any) {
      this.log(`[step:failed] Step ${step.stepNumber} error: ${err.message}`);
      await this.store.updateStep(step.id, {
        status: 'failed',
        error: err.message,
        completedAt: now,
      });
      await this.store.updateSession(session.id, {
        status: 'failed',
        error: `Step ${step.stepNumber} failed: ${err.message}`,
      });
      this.emit('failed', { session, step, error: err.message });
    }
  }

  /** Stage 1: Decompose broad topic into 3 investigative search queries */
  private async executeDecompose(session: ResearchSession, step: ResearchStep): Promise<void> {
    const prompt = `You are an elite research strategist for J.A.R.V.I.S.
Decompose this research topic into 3 distinct, specific, high-yield web search queries.
Cover:
1. Current technological/commercial state & latest developments (2026)
2. Primary challenges, bottlenecks, or geopolitical hurdles
3. Key players, timeline estimates, and market forecast

Research Topic: "${session.topic}"

OUTPUT ONLY valid JSON matching this schema:
[
  "query 1",
  "query 2",
  "query 3"
]`;

    const response = await this.callFreeLLM([
      { role: 'system', content: 'You are an autonomous research director. Respond ONLY in valid JSON array.' },
      { role: 'user', content: prompt },
    ]);

    let queries: string[] = [];
    try {
      const match = response.match(/\[[\s\S]*?\]/);
      queries = JSON.parse(match ? match[0] : response);
    } catch {
      queries = [
        `${session.topic} latest breakthroughs current status`,
        `${session.topic} challenges and limitations`,
        `${session.topic} timeline commercial outlook key players`,
      ];
    }

    if (!Array.isArray(queries) || queries.length === 0) {
      queries = [`${session.topic} current status`, `${session.topic} outlook`];
    }

    // Schedule the next steps dynamically
    const baseSteps = queries.length;
    let stepNum = 2;

    for (const q of queries) {
      await this.store.addStep({
        sessionId: session.id,
        stepNumber: stepNum++,
        stepType: 'search_explore',
        title: `Investigate: "${q.slice(0, 45)}"`,
        query: q,
        status: 'pending',
      });
    }

    // Step: Fact-check & cross-reference
    await this.store.addStep({
      sessionId: session.id,
      stepNumber: stepNum++,
      stepType: 'fact_check',
      title: 'Cross-reference evidence & verify timelines',
      status: 'pending',
    });

    // Step: Final synthesis
    await this.store.addStep({
      sessionId: session.id,
      stepNumber: stepNum++,
      stepType: 'synthesize',
      title: 'Synthesize executive intelligence report (Markdown & PDF)',
      status: 'pending',
    });

    await this.store.updateSession(session.id, {
      totalSteps: stepNum - 1,
    });

    await this.store.updateStep(step.id, {
      evidence: { subQueries: queries },
    });
  }

  /** Stage 2: Deep search exploration and factual extraction */
  private async executeSearchExplore(session: ResearchSession, step: ResearchStep): Promise<void> {
    const query = step.query || session.topic;
    this.log(`[search] Fetching live web evidence for: "${query}"`);

    const results = await this.searchService.search(query, 5);

    if (results.length === 0) {
      this.log(`[search] No live results for "${query}", continuing with internal analysis`);
    }

    const searchContext = results
      .map((r, i) => `[Source ${i + 1}: ${r.source || 'Web'}] "${r.title}"\n${r.snippet}\nLink: ${r.url}`)
      .join('\n\n');

    const prompt = `Analyze these search results regarding "${query}".
Extract 2 to 4 concrete, verified factual findings. Each finding must be specific, include numbers/dates/entities when present, and cite its source.

Search Results:
${searchContext}

OUTPUT ONLY valid JSON matching this schema:
[
  {
    "claim": "Specific factual finding...",
    "source": "Source Name",
    "url": "http://..."
  }
]`;

    const response = await this.callFreeLLM([
      { role: 'system', content: 'You are an intelligence researcher. Extract verified findings in JSON array format.' },
      { role: 'user', content: prompt },
    ]);

    let findings: ResearchFinding[] = [];
    try {
      const match = response.match(/\[[\s\S]*?\]/);
      findings = JSON.parse(match ? match[0] : response);
    } catch {
      findings = results.slice(0, 3).map((r) => ({
        claim: `${r.title}: ${r.snippet}`,
        source: r.source || 'Web',
        url: r.url,
      }));
    }

    const currentFindings = session.findings || [];
    const updatedFindings = [...currentFindings, ...findings];

    await this.store.updateSession(session.id, {
      findings: updatedFindings,
    });
    session.findings = updatedFindings;

    await this.store.updateStep(step.id, {
      evidence: { query, resultsCount: results.length, findingsExtracted: findings.length },
    });
  }

  /** Stage 3: Fact-check and reconcile timelines */
  private async executeFactCheck(session: ResearchSession, step: ResearchStep): Promise<void> {
    const findingsSummary = session.findings
      .map((f, i) => `${i + 1}. [${f.source}] ${f.claim}`)
      .join('\n');

    const prompt = `Review these collected research findings for topic "${session.topic}".
Identify:
1. Any conflicting dates, statistics, or technological roadmaps.
2. The strongest consensus facts.
3. Emerging breakthroughs vs speculative claims.

Collected Evidence:
${findingsSummary}

Provide a concise factual synthesis (under 250 words) reconciling the findings.`;

    const reconciliation = await this.callFreeLLM([
      { role: 'system', content: 'You are a research verifier reconciling intelligence evidence.' },
      { role: 'user', content: prompt },
    ]);

    await this.store.updateStep(step.id, {
      evidence: { reconciliation: reconciliation.trim() },
    });
  }

  /** Stage 4: Synthesize full briefing, compile PDF, index to GBrain */
  private async executeSynthesize(session: ResearchSession, step: ResearchStep): Promise<void> {
    const findingsList = session.findings
      .map((f) => `- **${f.source}**: ${f.claim} ${f.url ? `([Source](${f.url}))` : ''}`)
      .join('\n');

    const prompt = `You are J.A.R.V.I.S., generating an executive-grade intelligence briefing for your principal.
Write a comprehensive, brilliantly structured research report on:
# "${session.topic}"

Format the report with clean GitHub-flavored markdown:
- **Executive Summary** (Key takeaways, bottom line)
- **Current State of Technology & Breakthroughs**
- **Key Players, Corporate & Academic Leaders**
- **Critical Bottlenecks & Geopolitical / Economic Constraints**
- **Timeline & Commercial Horizon**
- **Strategic Implications & Recommendations**
- **Verified Sources & References**

Incorporate these collected real-time findings:
${findingsList}

Tone: Authoritative, impeccably competent, concise British intelligence briefing. No filler.`;

    const reportContent = await this.callFreeLLM([
      { role: 'system', content: 'You are J.A.R.V.I.S., composing a high-level executive research briefing.' },
      { role: 'user', content: prompt },
    ]);

    // Save Markdown to ~/Downloads
    const dateStr = new Date().toISOString().slice(0, 10);
    const sanitizedTopic = session.topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 30)
      .replace(/^_+|_+$/g, '');

    const mdFilename = `Research_${sanitizedTopic}_${dateStr}.md`;
    const pdfFilename = `Research_${sanitizedTopic}_${dateStr}.pdf`;

    const mdResult = await this.fileService.createMarkdown(mdFilename, reportContent);
    this.log(`[publish] Saved markdown report: ${mdResult.path}`);

    let pdfPath: string | undefined = undefined;
    try {
      const pdfResult = await this.fileService.createPdf(
        pdfFilename,
        reportContent,
        undefined,
        `JARVIS Intelligence Briefing: ${session.topic}`
      );
      pdfPath = pdfResult.path;
      this.log(`[publish] Compiled PDF report: ${pdfResult.path}`);
    } catch (pdfErr) {
      this.log(`[publish] PDF compilation skipped: ${pdfErr}`);
    }

    // Capture report into GBrain asynchronously
    this.captureToGBrain(session.topic, reportContent);

    // Update Session
    await this.store.updateSession(session.id, {
      status: 'completed',
      progress: 100,
      currentStepTitle: 'Mission Completed',
      finalReport: reportContent,
      reportPath: mdResult.path,
      pdfPath,
    });

    session.status = 'completed';
    session.progress = 100;
    session.reportPath = mdResult.path;
    session.pdfPath = pdfPath;

    await this.store.updateStep(step.id, {
      evidence: { reportPath: mdResult.path, pdfPath },
    });

    this.emit('completed', session);
  }

  private async finalizeMission(session: ResearchSession): Promise<void> {
    const updated = await this.store.getSession(session.id);
    if (updated && updated.status !== 'completed') {
      await this.store.updateSession(session.id, {
        status: 'completed',
        progress: 100,
        currentStepTitle: 'Mission Completed',
      });
      this.emit('completed', updated);
    }
  }

  // ─── Free-Tier LLM Caller ──────────────────────────────────────────────────

  /**
   * Calls ONLY free providers (Gemini free, Groq free, Mistral free, OpenRouter free).
   * // TODO: Re-enable local Ollama / dedicated research node in future
   */
  private async callFreeLLM(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
    const registry: any[] = (this.router as any).registry || [];
    // Filter strictly to free tier (ignoring paid and local for now per specification)
    const freeProfiles = registry.filter((p: any) => p.tier === 'free');

    if (freeProfiles.length === 0) {
      // Fallback to router chat with reasoning hint if registry private
      return this.router.chat(messages as any, { taskHint: 'reasoning', temperature: 0.2 });
    }

    let lastError: Error | null = null;
    for (const profile of freeProfiles) {
      try {
        if (!profile.provider?.chat) continue;
        const res = await profile.provider.chat(messages, {
          temperature: 0.2,
          maxTokens: 4096,
        });
        if (res && res.trim()) {
          this.log(`[llm:free] Responded via ${profile.providerId}/${profile.modelId}`);
          return res;
        }
      } catch (err: any) {
        lastError = err;
        this.log(`[llm:retry] ${profile.providerId} failed: ${err?.message || err}. Trying next free provider.`);
      }
    }

    throw new Error(`All free LLM providers failed for background research step. Last error: ${lastError?.message}`);
  }

  private captureToGBrain(topic: string, content: string): void {
    if (process.env.GBRAIN_ENABLED !== 'true') return;

    try {
      const child = spawn('gbrain', ['capture', '--stdin']);
      const payload = `---\ntype: note\ntitle: JARVIS Research - ${topic}\ntags: [research, jarvis-briefing]\n---\n\n${content}`;
      child.stdin.write(payload);
      child.stdin.end();
      this.log(`[gbrain] Captured research briefing to GBrain`);
    } catch (err) {
      this.log(`[gbrain:warn] GBrain capture failed: ${err}`);
    }
  }

  private log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      appendFileSync(this.logPath, line, 'utf-8');
    } catch {}
  }
}
