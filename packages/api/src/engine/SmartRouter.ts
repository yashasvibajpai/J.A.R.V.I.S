import type { LLMProvider, LLMOptions, LLMCapabilities, Message } from '@jarvis/shared';

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
  '```', 'stacktrace', 'traceback', 'exception', '.ts', '.js', '.py',
];

const REASONING_KEYWORDS = [
  'analyze', 'compare', 'explain why', 'step by step', 'evaluate',
  'trade-off', 'pros and cons', 'difference between', 'best approach',
  'architecture', 'design', 'strategy', 'plan', 'think through',
  'implications', 'consequences', 'reasoning', 'logic',
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
];

/**
 * Classify a user query into a task type using keyword heuristics.
 * Fast, deterministic, zero API cost.
 */
export function classifyTask(userMessage: string, _history?: Message[]): TaskType {
  const lower = userMessage.toLowerCase();
  const wordCount = userMessage.trim().split(/\s+/).length;

  // Quick queries — short, simple questions
  if (wordCount <= 12 && !lower.includes('```') && !lower.includes('code')) {
    // Check if it's NOT a creative/reasoning request first
    const isSimple = !REASONING_KEYWORDS.some(k => lower.includes(k))
      && !CREATIVE_KEYWORDS.some(k => lower.includes(k));
    if (isSimple) return 'quick';
  }

  // Tool use — explicit action requests
  if (TOOL_USE_KEYWORDS.some(k => lower.includes(k))) return 'tool_use';

  // Coding — code blocks, file extensions, programming keywords
  const codingScore = CODING_KEYWORDS.filter(k => lower.includes(k)).length;
  if (codingScore >= 2 || lower.includes('```')) return 'coding';

  // Reasoning — analytical/comparison keywords
  const reasoningScore = REASONING_KEYWORDS.filter(k => lower.includes(k)).length;
  if (reasoningScore >= 2) return 'reasoning';

  // Creative — writing/composition keywords
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
}

/** Live mutable state for a provider */
export interface ProviderState {
  requestsThisMinute: number;
  requestsToday: number;
  tokensToday: number;
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

  /** Check if a provider can handle a request right now */
  canUse(profile: ProviderProfile): boolean {
    this.maybeResetWindows(profile);

    // In cooldown?
    if (profile.state.cooldownUntil && new Date() < profile.state.cooldownUntil) {
      return false;
    }

    // Per-minute limit
    if (profile.state.requestsThisMinute >= profile.limits.rpm) {
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

  /** Record a successful request */
  recordUsage(profile: ProviderProfile, estimatedTokens: number): void {
    this.maybeResetWindows(profile);
    profile.state.requestsThisMinute++;
    profile.state.requestsToday++;
    profile.state.tokensToday += estimatedTokens;
    profile.state.consecutiveFailures = 0;
    profile.state.lastUsed = new Date();
  }

  /** Trigger a cooldown after a rate limit (429) error */
  triggerCooldown(profile: ProviderProfile, retryAfterMs?: number): void {
    // Exponential backoff: 30s base, doubles with consecutive failures, max 5 min
    const backoff = Math.min(
      30_000 * Math.pow(2, profile.state.consecutiveFailures),
      300_000
    );
    const cooldownMs = retryAfterMs ?? backoff;
    profile.state.cooldownUntil = new Date(Date.now() + cooldownMs);
    profile.state.consecutiveFailures++;
    console.log(
      `[gate] ⏳ ${profile.providerId}/${profile.modelId} cooling down for ${Math.round(cooldownMs / 1000)}s`
    );
  }

  /** Automatically reset windowed counters when the window expires */
  private maybeResetWindows(profile: ProviderProfile): void {
    const now = Date.now();

    // Reset per-minute window
    if (now - profile.state.minuteWindowStart > 60_000) {
      profile.state.requestsThisMinute = 0;
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

  constructor(registry: ProviderProfile[]) {
    if (registry.length === 0) {
      throw new Error('SmartRouter requires at least one provider');
    }
    this.registry = registry;
    this.gate = new RateLimitGate();
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    const userMessage = this.extractUserMessage(messages);
    const taskType = classifyTask(userMessage, messages);
    const ordered = this.rankProviders(taskType);

    let lastError: Error | null = null;

    for (const profile of ordered) {
      try {
        console.log(`[router] ${taskType} → trying ${profile.providerId}/${profile.modelId}`);
        const result = await profile.provider.chat(messages, options);
        this.gate.recordUsage(profile, estimateTokens(result));
        this.lastUsedProvider = { providerId: profile.providerId, modelId: profile.modelId };
        console.log(`[router] ✓ ${profile.providerId}/${profile.modelId} responded (${taskType})`);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isRateLimitError(err)) {
          this.gate.triggerCooldown(profile, parseRetryAfter(err));
          console.warn(`[router] ⏳ ${profile.providerId} rate-limited, cooling down`);
        } else {
          profile.state.consecutiveFailures++;
          console.warn(`[router] ✗ ${profile.providerId} failed: ${lastError.message}`);
        }
      }
    }

    throw new Error(
      `All ${this.registry.length} providers exhausted. Last error: ${lastError?.message}`
    );
  }

  async *stream(messages: Message[], options?: LLMOptions): AsyncGenerator<string> {
    const userMessage = this.extractUserMessage(messages);
    const taskType = classifyTask(userMessage, messages);
    const ordered = this.rankProviders(taskType);

    let lastError: Error | null = null;

    for (const profile of ordered) {
      try {
        console.log(`[router] ${taskType} → streaming via ${profile.providerId}/${profile.modelId}`);
        const gen = profile.provider.stream(messages, options);

        // Validate first chunk before committing to this provider
        const first = await gen.next();
        if (!first.done && first.value) {
          yield first.value;
        }

        // First chunk worked — commit to this provider
        for await (const chunk of gen) {
          yield chunk;
        }

        this.gate.recordUsage(profile, 500); // estimate for streamed responses
        this.lastUsedProvider = { providerId: profile.providerId, modelId: profile.modelId };
        console.log(`[router] ✓ ${profile.providerId} stream complete (${taskType})`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isRateLimitError(err)) {
          this.gate.triggerCooldown(profile, parseRetryAfter(err));
          console.warn(`[router] ⏳ ${profile.providerId} stream rate-limited`);
        } else {
          profile.state.consecutiveFailures++;
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

    for (const profile of this.registry) {
      if (!profile.provider.embed) continue;

      try {
        console.log(`[router] embedding via ${profile.providerId}...`);
        const vector = await profile.provider.embed(text);
        this.gate.recordUsage(profile, estimateTokens(text));
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
      let status: 'available' | 'cooling_down' | 'exhausted' | 'unavailable';
      if (p.state.cooldownUntil && new Date() < p.state.cooldownUntil) {
        status = 'cooling_down';
      } else if (p.state.requestsToday >= p.limits.rpd || p.state.tokensToday >= p.limits.tokensPerDay) {
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
   */
  private rankProviders(taskType: TaskType): ProviderProfile[] {
    const available = this.registry.filter(p => this.gate.canUse(p));

    // Separate by tier
    const free = available.filter(p => p.tier === 'free' || p.tier === 'local');
    const paid = available.filter(p => p.tier === 'paid');

    // Sort each group by score for this task type
    const sortByScore = (a: ProviderProfile, b: ProviderProfile) =>
      b.scores[taskType] - a.scores[taskType];

    free.sort(sortByScore);
    paid.sort(sortByScore);

    // Free first, then paid fallbacks
    return [...free, ...paid];
  }
}
