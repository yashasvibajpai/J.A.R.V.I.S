import type { LLMProvider, LLMOptions, LLMCapabilities, LLMTokenUsage, Message } from '@jarvis/shared';
import { normalizeMessages } from './pipeline.js';
import type { SQLiteProviderQuota } from '../stores/SQLiteProviderQuota.js';

// ─── Task Classification ─────────────────────────────────────────────────────

/** Task categories for intelligent routing */
export type TaskType = 'general' | 'coding' | 'reasoning' | 'creative' | 'quick' | 'tool_use' | 'embedding';

/** Keyword sets for heuristic classification — zero LLM cost */
const CODING_KEYWORDS = [
  'function', 'error', 'debug', 'code', 'compile', 'syntax',
  'typescript', 'javascript', 'python', 'rust', 'java', 'import',
  'class', 'const ', 'let ', 'var ', 'def ', 'async', 'await',
  'npm', 'pnpm', 'yarn', 'git', 'docker', 'api', 'endpoint',
  'bug', 'fix', 'refactor', 'test', 'module', 'package',
  'script', 'scripts',
  '```', 'stacktrace', 'traceback', 'exception', '.ts', '.js', '.py',
];

const REASONING_KEYWORDS = [
  'analyze', 'compare', 'explain why', 'step by step', 'evaluate',
  'trade-off', 'pros and cons', 'difference between', 'best approach',
  'architecture', 'design', 'strategy', 'plan', 'think through',
  'implications', 'consequences', 'reasoning', 'logic',
  'investigate', 'investigation', 'root cause', 'post-mortem',
  'incident report', 'outage', 'outages', 'downtime', 'impact',
  'reasons', 'comprehensive', 'deep dive', 'audit', 'findings',
  'timeline', 'assessment', 'synthesis', 'breakdown', 'why did',
];

const CREATIVE_KEYWORDS = [
  'write', 'story', 'poem', 'draft', 'compose', 'brainstorm',
  'creative', 'imagine', 'fiction', 'essay', 'blog', 'article',
  'rewrite', 'rephrase', 'tone', 'headline', 'slogan', 'email',
  'letter', 'speech', 'lyrics',
];

const TOOL_USE_KEYWORDS = [
  'search the web', 'look up', 'browse', 'open', 'run command',
  'execute', 'list files', 'read file', 'write file', 'schedule',
  'search online', 'google', 'fetch', 'download',
  'latest on', 'latest news', 'what is the latest', "what's the latest",
  'breaking news', 'current events', 'today in', 'news on', 'weather in',
  'stock price', 'price of',
  'create pdf', 'generate pdf', 'compile pdf', 'save pdf', '.pdf', 'pdf report', 'pdf',
  'create file', 'save to file', 'save as', 'write to file',
];

/**
 * Classify a user query into a task type using keyword heuristics.
 * Fast, deterministic, zero API cost.
 */
export function classifyTask(userMessage: string, _history?: Message[]): TaskType {
  const lower = userMessage.toLowerCase();
  const wordCount = userMessage.trim().split(/\s+/).length;

  const isDocumentOrFileAction =
    TOOL_USE_KEYWORDS.some(k => lower.includes(k)) ||
    /\b(create|generate|compile|save|make|produce)\b.*\b(pdf|report|file|document|briefing|summary)\b/i.test(lower);

  const hasAnalyticalIntent =
    /\b(analysis|report|investigat(e|ion|ing)|impact|reasons?|outages?|downtimes?|root\s*cause|post-?mortem|audit|assessment|comprehensive|deep\s*dive|trade-?offs?|benchmark)\b/i.test(lower);

  // 1. Coding check first if explicit programming keywords exist
  const codingScore = CODING_KEYWORDS.filter(k => lower.includes(k)).length;
  if (codingScore >= 2 || lower.includes('```') || (codingScore >= 1 && /\b(script|function|code|debug|refactor)\b/i.test(lower))) {
    return 'coding';
  }

  // 2. If an analytical or investigative document/report is requested,
  // classify as 'reasoning' so the model spends deliberate thinking effort BEFORE generating the document!
  if (isDocumentOrFileAction && hasAnalyticalIntent) {
    return 'reasoning';
  }

  // 3. Pure utility / file writing / real-time search action
  if (isDocumentOrFileAction) {
    return 'tool_use';
  }

  // 4. Pure analytical / reasoning questions
  const reasoningScore = REASONING_KEYWORDS.filter(k => lower.includes(k)).length;
  if (reasoningScore >= 2 || hasAnalyticalIntent) {
    return 'reasoning';
  }

  // 5. Quick queries — short, simple questions
  if (wordCount <= 12 && !lower.includes('```') && !lower.includes('code')) {
    const isSimple = !REASONING_KEYWORDS.some(k => lower.includes(k))
      && !CREATIVE_KEYWORDS.some(k => lower.includes(k));
    if (isSimple) return 'quick';
  }

  // 6. Creative — writing/composition keywords
  const creativeScore = CREATIVE_KEYWORDS.filter(k => lower.includes(k)).length;
  if (creativeScore >= 1) return 'creative';

  // Default fallback
  return 'general';
}

// ─── Provider Profile ─────────────────────────────────────────────────────────

/** Capability scores per task type (0–10) */
export interface TaskScores {
  general: number;
  coding: number;
  reasoning: number;
  creative: number;
  quick: number;      // latency-weighted
  tool_use: number;
  embedding: number;
}

/** Rate limit budget definition */
export interface RateLimits {
  rpm: number;          // requests per minute
  rpd: number;          // requests per day
  tokensPerDay: number; // daily token budget
  tokensPerMinute?: number;
}

/** Live mutable state for a provider */
export interface ProviderState {
  requestsThisMinute: number;
  requestsToday: number;
  tokensToday: number;
  tokensThisMinute?: number;
  cooldownUntil: Date | null;
  consecutiveFailures: number;
  lastUsed: Date | null;
  minuteWindowStart: number; // epoch ms
  dayWindowStart: number;    // epoch ms
}

/** Full profile for a registered provider */
export interface ProviderProfile {
  provider: LLMProvider;
  providerId: string;
  modelId: string;
  scores: TaskScores;
  limits: RateLimits;
  state: ProviderState;
  tier: 'free' | 'paid' | 'local';
  contextWindow: number;
}

// ─── Rate Limit Gate ──────────────────────────────────────────────────────────

/** Manages per-provider rate limit budgets and cooldowns */
class RateLimitGate {
  constructor(private readonly quota?: SQLiteProviderQuota) {}

  refresh(profile: ProviderProfile): void {
    const state = profile.tier === 'local' ? undefined : this.quota?.read(profile.providerId);
    if (state) profile.state = state;
    this.maybeResetWindows(profile);
  }

  private update<T>(profile: ProviderProfile, apply: () => T): T {
    if (!this.quota || profile.tier === 'local') return apply();
    return this.quota.update(profile.providerId, profile.state, state => {
      profile.state = state;
      return apply();
    });
  }

  /** Check if a provider can handle a request right now */
  canUse(profile: ProviderProfile): boolean {
    this.refresh(profile);
    return this.hasCapacity(profile);
  }

  private hasCapacity(profile: ProviderProfile): boolean {
    this.maybeResetWindows(profile);

    // In cooldown?
    if (profile.state.cooldownUntil && new Date() < profile.state.cooldownUntil) {
      return false;
    }

    // Per-minute limit
    if (profile.state.requestsThisMinute >= profile.limits.rpm ||
      (profile.state.tokensThisMinute ?? 0) >= (profile.limits.tokensPerMinute ?? Infinity)) {
      return false;
    }

    // Per-day request limit
    if (profile.state.requestsToday >= profile.limits.rpd) {
      return false;
    }

    // Daily token budget
    if (profile.state.tokensToday >= profile.limits.tokensPerDay) {
      return false;
    }

    return true;
  }

  reserve(profile: ProviderProfile, estimatedTokens: number): { day: number; minute: number } | null {
    return this.update(profile, () => {
      if (!this.hasCapacity(profile) || profile.state.tokensToday + estimatedTokens > profile.limits.tokensPerDay ||
        (profile.state.tokensThisMinute ?? 0) + estimatedTokens > (profile.limits.tokensPerMinute ?? Infinity)) return null;
      profile.state.requestsThisMinute++;
      profile.state.requestsToday++;
      profile.state.tokensToday += estimatedTokens;
      profile.state.tokensThisMinute = (profile.state.tokensThisMinute ?? 0) + estimatedTokens;
      return { day: profile.state.dayWindowStart, minute: profile.state.minuteWindowStart };
    });
  }

  reconcile(profile: ProviderProfile, window: { day: number; minute: number }, reserved: number, actual: number): void {
    this.update(profile, () => {
      if (profile.state.dayWindowStart === window.day) profile.state.tokensToday += actual - reserved;
      if (profile.state.minuteWindowStart === window.minute) {
        profile.state.tokensThisMinute = (profile.state.tokensThisMinute ?? 0) + actual - reserved;
      }
    });
  }

  nextAvailability(profile: ProviderProfile, estimatedTokens = 0): number {
    this.refresh(profile);
    return Math.max(
      Date.now(),
      profile.state.cooldownUntil?.getTime() ?? 0,
      profile.state.requestsThisMinute >= profile.limits.rpm ||
        (profile.state.tokensThisMinute ?? 0) + estimatedTokens > (profile.limits.tokensPerMinute ?? Infinity)
        ? profile.state.minuteWindowStart + 60_001 : 0,
      profile.state.requestsToday >= profile.limits.rpd || profile.state.tokensToday + estimatedTokens > profile.limits.tokensPerDay
        ? profile.state.dayWindowStart + 86_400_001
        : 0,
    );
  }

  complete(profile: ProviderProfile): void {
    this.update(profile, () => {
      profile.state.consecutiveFailures = 0;
      profile.state.lastUsed = new Date();
    });
  }

  fail(profile: ProviderProfile): void {
    this.update(profile, () => { profile.state.consecutiveFailures++; });
  }

  /** Trigger a cooldown after a rate limit (429) error */
  triggerCooldown(profile: ProviderProfile, retryAfterMs?: number, log = true): void {
    const cooldownMs = this.update(profile, () => {
      const backoff = Math.min(30_000 * Math.pow(2, profile.state.consecutiveFailures), 300_000);
      const until = Math.max(profile.state.cooldownUntil?.getTime() ?? 0, Date.now() + (retryAfterMs ?? backoff));
      profile.state.cooldownUntil = new Date(until);
      profile.state.consecutiveFailures++;
      return until - Date.now();
    });
    if (log) console.log(
      `[gate] ⏳ ${profile.providerId}/${profile.modelId} cooling down for ${Math.round(cooldownMs / 1000)}s`
    );
  }

  /** Automatically reset windowed counters when the window expires */
  private maybeResetWindows(profile: ProviderProfile): void {
    const now = Date.now();

    // Reset per-minute window
    if (now - profile.state.minuteWindowStart > 60_000) {
      profile.state.requestsThisMinute = 0;
      profile.state.tokensThisMinute = 0;
      profile.state.minuteWindowStart = now;
    }

    // Reset per-day window (24 hours)
    if (now - profile.state.dayWindowStart > 86_400_000) {
      profile.state.requestsToday = 0;
      profile.state.tokensToday = 0;
      profile.state.dayWindowStart = now;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type ResearchAttemptOutcome = 'succeeded' | 'failed' | 'rate_limited' | 'aborted';

interface ResearchCallTracker {
  start(providerId: string, modelId: string, retry: boolean, messages: Message[]): string;
  finish(id: string, outcome: ResearchAttemptOutcome, usage?: LLMTokenUsage, estimated?: boolean, details?: { error?: string; response?: string }): void;
}

export class ResearchQuotaWait extends Error {
  constructor(readonly retryAt: number) {
    super('Waiting for a free model provider');
  }
}

/** Detect rate limit errors from various providers */
function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('429')
      || msg.includes('rate limit')
      || msg.includes('quota')
      || msg.includes('too many requests')
      || msg.includes('resource_exhausted');
  }
  return false;
}

/** Extract retry-after hint from error (ms) */
function parseRetryAfter(err: unknown): number | undefined {
  if (err instanceof Error) {
    // Many providers include Retry-After or x-ratelimit headers in the error message
    const match = err.message.match(/retry.?after[:\s]+(\d+)/i);
    if (match) {
      const seconds = parseInt(match[1], 10);
      return seconds * 1000;
    }
  }
  return undefined;
}

// ─── SmartRouter ──────────────────────────────────────────────────────────────

/**
 * SmartRouter — intelligent multi-provider LLM orchestrator.
 *
 * Implements the same LLMProvider interface so it's a drop-in replacement
 * for FailoverChain. Internally it:
 *
 * 1. Classifies each query by task type (coding, creative, quick, etc.)
 * 2. Scores and ranks providers for that task type
 * 3. Filters out rate-limited/cooling providers
 * 4. Prefers free-tier providers, only falls back to paid when free is exhausted
 * 5. On 429 errors, triggers exponential backoff cooldowns
 */
export class SmartRouter implements LLMProvider {
  private registry: ProviderProfile[];
  private gate: RateLimitGate;

  /** Track which provider handled the last request (for metadata reporting) */
  private lastUsedProvider: { providerId: string; modelId: string } | null = null;

  constructor(registry: ProviderProfile[], quota?: SQLiteProviderQuota) {
    if (registry.length === 0) {
      throw new Error('SmartRouter requires at least one provider');
    }
    this.registry = registry;
    this.gate = new RateLimitGate(quota);
  }

  /**
   * Automatically resolves reasoning effort based on task type if not explicitly set.
   * - 'reasoning' tasks (deep analysis, investigative reports): 'high'
   * - 'coding' tasks (architecture, debugging): 'medium'
   * - 'quick' or simple 'tool_use': 'low' or default
   */
  private resolveEffectiveOptions(taskType: TaskType, options?: LLMOptions): LLMOptions {
    const opts: LLMOptions = { ...options };
    if (!opts.reasoningEffort) {
      if (taskType === 'reasoning') {
        opts.reasoningEffort = 'high';
      } else if (taskType === 'coding') {
        opts.reasoningEffort = 'medium';
      }
    }
    return opts;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    const normalized = normalizeMessages(messages);
    const userMessage = this.extractUserMessage(normalized);
    const taskType = options?.taskHint ?? classifyTask(userMessage, normalized);
    const effectiveOptions = this.resolveEffectiveOptions(taskType, options);
    const ordered = this.rankProviders(taskType, effectiveOptions);

    let lastError: Error | null = null;

    const inputTokens = normalized.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    const reservation = inputTokens + (effectiveOptions.maxTokens ?? 8192);
    for (const profile of ordered) {
      const day = this.gate.reserve(profile, reservation);
      if (day === null) continue;
      try {
        console.log(`[router] ${taskType} (effort: ${effectiveOptions.reasoningEffort ?? 'default'}) → trying ${profile.providerId}/${profile.modelId}`);
        const result = await profile.provider.chat(normalized, effectiveOptions);
        if (!result || !result.trim()) {
          throw new Error(`Provider ${profile.providerId}/${profile.modelId} returned an empty response`);
        }
        this.gate.reconcile(profile, day, reservation, inputTokens + estimateTokens(result));
        this.gate.complete(profile);
        this.lastUsedProvider = { providerId: profile.providerId, modelId: profile.modelId };
        console.log(`[router] ✓ ${profile.providerId}/${profile.modelId} responded (${taskType})`);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isRateLimitError(err)) {
          this.gate.triggerCooldown(profile, parseRetryAfter(err));
          console.warn(`[router] ⏳ ${profile.providerId} rate-limited, cooling down`);
        } else {
          this.gate.fail(profile);
          console.warn(`[router] ✗ ${profile.providerId} failed: ${lastError.message}`);
        }
      }
    }

    throw new Error(
      `All ${this.registry.length} providers exhausted. Last error: ${lastError?.message}`
    );
  }

  async researchChat(messages: Message[], tracker: ResearchCallTracker, signal: AbortSignal): Promise<string> {
    const normalized = normalizeMessages(messages);
    const inputTokens = normalized.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    const outputCapacity = (profile: ProviderProfile) =>
      Math.min(4096, Math.min(profile.limits.tokensPerDay, profile.limits.tokensPerMinute ?? Infinity) - inputTokens);
    const free = this.registry.filter(profile => profile.tier === 'free' && outputCapacity(profile) >= 256);
    if (!free.length) throw new Error('No configured free model provider can fit this research request');
    const candidates = [...free].sort((a, b) => b.scores.reasoning - a.scores.reasoning);
    let attempted = false;
    let lastError: Error | undefined;
    const waiting = new Set<ProviderProfile>();

    for (const profile of candidates) {
      signal.throwIfAborted();
      const maxTokens = outputCapacity(profile);
      const reservation = inputTokens + maxTokens;
      const day = this.gate.reserve(profile, reservation);
      if (day === null) {
        waiting.add(profile);
        continue;
      }
      const id = tracker.start(profile.providerId, profile.modelId, attempted, normalized);
      attempted = true;
      let usage: LLMTokenUsage | undefined;
      let result: string;
      try {
        result = await profile.provider.chat(normalized, {
          temperature: 0.2,
          maxTokens,
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
          onUsage: reported => {
            if (Object.values(reported).some(Number.isFinite)) usage = reported;
          },
        });
        if (!result.trim()) throw new Error('Provider returned an empty response');
      } catch (error) {
        const rateLimited = isRateLimitError(error);
        tracker.finish(id, signal.aborted ? 'aborted' : rateLimited ? 'rate_limited' : 'failed', usage, false, {
          error: error instanceof Error ? error.message : String(error),
        });
        signal.throwIfAborted();
        if (rateLimited) {
          this.gate.triggerCooldown(profile, parseRetryAfter(error), false);
          waiting.add(profile);
        }
        else lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      tracker.finish(id, 'succeeded', usage ?? { inputTokens, outputTokens: estimateTokens(result) }, !usage, { response: result });
      const total = usage?.totalTokens ?? (usage?.inputTokens ?? inputTokens) + (usage?.outputTokens ?? estimateTokens(result));
      this.gate.reconcile(profile, day, reservation, total);
      this.gate.complete(profile);
      signal.throwIfAborted();
      return result;
    }

    if (lastError && !waiting.size) throw lastError;
    throw new ResearchQuotaWait(Math.max(Date.now() + 3500, Math.min(...[...waiting].map(profile =>
      this.gate.nextAvailability(profile, inputTokens + outputCapacity(profile))))));
  }

  async *stream(messages: Message[], options?: LLMOptions): AsyncGenerator<string> {
    const normalized = normalizeMessages(messages);
    const userMessage = this.extractUserMessage(normalized);
    const taskType = options?.taskHint ?? classifyTask(userMessage, normalized);
    const effectiveOptions = this.resolveEffectiveOptions(taskType, options);
    const ordered = this.rankProviders(taskType, effectiveOptions);

    let lastError: Error | null = null;

    const inputTokens = normalized.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    const reservation = inputTokens + (effectiveOptions.maxTokens ?? 8192);
    for (const profile of ordered) {
      const day = this.gate.reserve(profile, reservation);
      if (day === null) continue;
      try {
        console.log(`[router] ${taskType} (effort: ${effectiveOptions.reasoningEffort ?? 'default'}) → streaming via ${profile.providerId}/${profile.modelId}`);
        const gen = profile.provider.stream(normalized, effectiveOptions);

        // Validate first chunk before committing to this provider
        const first = await gen.next();
        if (first.done || !first.value) {
          throw new Error(`Provider ${profile.providerId}/${profile.modelId} returned an empty stream`);
        }
        let outputLength = first.value.length;
        yield first.value;

        // First chunk worked — commit to this provider
        for await (const chunk of gen) {
          outputLength += chunk.length;
          yield chunk;
        }

        this.gate.reconcile(profile, day, reservation, inputTokens + Math.ceil(outputLength / 4));
        this.gate.complete(profile);
        this.lastUsedProvider = { providerId: profile.providerId, modelId: profile.modelId };
        console.log(`[router] ✓ ${profile.providerId} stream complete (${taskType})`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isRateLimitError(err)) {
          this.gate.triggerCooldown(profile, parseRetryAfter(err));
          console.warn(`[router] ⏳ ${profile.providerId} stream rate-limited`);
        } else {
          this.gate.fail(profile);
          console.warn(`[router] ✗ ${profile.providerId} stream failed: ${lastError.message}`);
        }
      }
    }

    throw new Error(
      `All providers failed to stream. Last error: ${lastError?.message}`
    );
  }

  async embed(text: string): Promise<number[]> {
    let lastError: Error | null = null;

    // Rank candidates by embedding score descending so native 768-dim providers are preferred
    const candidates = this.registry
      .filter((p) => Boolean(p.provider.embed) && this.gate.canUse(p))
      .sort((a, b) => (b.scores.embedding ?? 0) - (a.scores.embedding ?? 0));

    for (const profile of candidates) {
      if (this.gate.reserve(profile, estimateTokens(text)) === null) continue;
      try {
        console.log(`[router] embedding via ${profile.providerId}...`);
        const vector = await profile.provider.embed!(text);
        this.gate.complete(profile);
        return vector;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isRateLimitError(err)) {
          this.gate.triggerCooldown(profile, parseRetryAfter(err));
        }
        console.warn(`[router] ✗ ${profile.providerId} embedding failed: ${lastError.message}`);
      }
    }

    throw new Error(
      `All providers failed to generate embeddings. Last error: ${lastError?.message}`
    );
  }

  getCapabilities(): LLMCapabilities {
    // Report capabilities of the last-used or primary provider
    if (this.lastUsedProvider) {
      const match = this.registry.find(
        p => p.providerId === this.lastUsedProvider!.providerId
          && p.modelId === this.lastUsedProvider!.modelId
      );
      if (match) return match.provider.getCapabilities();
    }
    return this.registry[0].provider.getCapabilities();
  }

  async isAvailable(): Promise<boolean> {
    for (const profile of this.registry) {
      if (this.gate.canUse(profile) && await profile.provider.isAvailable()) {
        return true;
      }
    }
    return false;
  }

  /** Get info about the provider that handled the last request */
  getLastUsedProvider(): { providerId: string; modelId: string } | null {
    return this.lastUsedProvider;
  }

  /** Live health dashboard for all registered providers */
  healthDashboard(): Array<{
    id: string;
    tier: string;
    status: 'available' | 'cooling_down' | 'exhausted' | 'unavailable';
    requestsToday: number;
    limitRPD: number;
    tokensToday: number;
    limitTokensPerDay: number;
    cooldownUntil: string | null;
    lastUsed: string | null;
    consecutiveFailures: number;
  }> {
    return this.registry.map(p => {
      this.gate.refresh(p);
      let status: 'available' | 'cooling_down' | 'exhausted' | 'unavailable';
      if (p.state.cooldownUntil && new Date() < p.state.cooldownUntil) {
        status = 'cooling_down';
      } else if (p.state.requestsThisMinute >= p.limits.rpm || p.state.requestsToday >= p.limits.rpd || p.state.tokensToday >= p.limits.tokensPerDay) {
        status = 'exhausted';
      } else if (p.state.consecutiveFailures >= 5) {
        status = 'unavailable';
      } else {
        status = 'available';
      }

      return {
        id: `${p.providerId}/${p.modelId}`,
        tier: p.tier,
        status,
        requestsToday: p.state.requestsToday,
        limitRPD: p.limits.rpd,
        tokensToday: p.state.tokensToday,
        limitTokensPerDay: p.limits.tokensPerDay,
        cooldownUntil: p.state.cooldownUntil?.toISOString() ?? null,
        lastUsed: p.state.lastUsed?.toISOString() ?? null,
        consecutiveFailures: p.state.consecutiveFailures,
      };
    });
  }

  /** Full health check for all providers (includes reachability) */
  async healthCheck(): Promise<Array<{ providerId: string; modelId: string; available: boolean }>> {
    return Promise.all(
      this.registry.map(async (p) => ({
        providerId: p.providerId,
        modelId: p.modelId,
        available: this.gate.canUse(p) && await p.provider.isAvailable(),
      }))
    );
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /** Extract the last user message from the messages array */
  private extractUserMessage(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].content;
    }
    return '';
  }

  /**
   * Rank providers for a given task type:
   * 1. Filter out unavailable/rate-limited providers
   * 2. Sort by task-specific score (descending)
   * 3. Within same score, prefer free/local over paid
   * 4. For low non-research tasks ('quick', 'general') or when freeOnly is active,
   *    restrict strictly to free/local tiers (no paid fallback).
   */
  private rankProviders(taskType: TaskType, options?: LLMOptions): ProviderProfile[] {
    const available = this.registry.filter(p => this.gate.canUse(p));

    // Separate by tier
    const free = available.filter(p => p.tier === 'free' || p.tier === 'local');
    const paid = available.filter(p => p.tier === 'paid');

    // Sort each group by score for this task type
    const sortByScore = (a: ProviderProfile, b: ProviderProfile) =>
      b.scores[taskType] - a.scores[taskType];

    free.sort(sortByScore);
    paid.sort(sortByScore);

    // Enforce free-tier only for low non-research tasks (quick, general)
    // or when freeOnly is explicitly set in options or JARVIS_FREE_ONLY env.
    const isLowNonResearch = taskType === 'quick' || taskType === 'general';
    const forceFreeOnly = Boolean(options?.freeOnly) || process.env.JARVIS_FREE_ONLY === 'true';

    if (isLowNonResearch || forceFreeOnly) {
      return free;
    }

    // Free first, then paid fallbacks
    return [...free, ...paid];
  }
}
