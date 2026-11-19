import type { Message } from '@jarvis/shared';

// ─── Middleware Types ────────────────────────────────────────────────────────

/**
 * A pipeline context bag that flows through every middleware step.
 * Each step can read from and write to this object.
 */
export interface PipelineContext {
  /** The original user message */
  userMessage: string;

  /** Accumulated messages to send to the LLM (system + history + current) */
  messages: Message[];

  /** The LLM's response (populated after the LLM step) */
  response?: string;

  /** Metadata collected during the pipeline — future home of memory recall, profile data, etc. */
  metadata: Record<string, any>;

  /** 
   * An action requested by the LLM that needs to be executed via OpenClaw.
   * If safetyTier is 'destructive', it blocks the pipeline and waits for user confirmation.
   */
  pendingAction?: {
    id: string;
    tool: string;
    params: Record<string, any>;
    safetyTier: 'safe' | 'destructive';
  };
}

/**
 * A middleware step in the message pipeline.
 * Receives the context, does its work, calls next() to continue.
 *
 * Inspired by Express/Koa middleware and Open WebUI's pipeline framework.
 */
export type Middleware = (
  ctx: PipelineContext,
  next: () => Promise<void>
) => Promise<void>;

/**
 * Consolidates multiple disparate `system` messages into a single root system message.
 * Required for compatibility with model providers (Google Gemini, Groq, Ollama, Anthropic)
 * whose OpenAI translation layers drop or mishandle non-contiguous or multiple system messages.
 */
export function normalizeMessages(messages: Message[]): Message[] {
  const systemParts: string[] = [];
  const nonSystem: Message[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content && m.content.trim()) {
        systemParts.push(m.content.trim());
      }
    } else {
      nonSystem.push(m);
    }
  }

  if (systemParts.length === 0) return nonSystem;

  return [
    { role: 'system', content: systemParts.join('\n\n') },
    ...nonSystem,
  ];
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/**
 * The message pipeline — every message flows through a chain of middleware:
 *
 *   User Message
 *     → [System Prompt Injection]
 *     → [Memory Recall]      ← Phase 1C
 *     → [Profile Injection]   ← Phase 1C
 *     → [LLM Call]
 *     → [Memory Extract]     ← Phase 1C (async, fire-and-forget)
 *     → [Profile Update]     ← Phase 1C (async, fire-and-forget)
 *     → [Feedback Tracking]  ← Phase 1D
 *   Response
 *
 * Each phase adds more middleware steps without touching existing ones.
 */
export class Pipeline {
  private middleware: Middleware[] = [];

  /**
   * Sentinel marker — place this in your middleware list to split
   * "pre-LLM" (context-building) steps from "post-LLM" (extraction) steps.
   * Used by buildContext() and runPostLlm() for the streaming endpoint.
   */
  static readonly LLM_BOUNDARY = '__LLM_BOUNDARY__';
  private llmBoundaryIndex = -1;

  /** Add a middleware step to the end of the pipeline */
  use(mw: Middleware): this {
    this.middleware.push(mw);
    return this;
  }

  /**
   * Mark the current position as the LLM boundary.
   * Everything before this runs in buildContext(); everything after in runPostLlm().
   */
  markLlmBoundary(): this {
    this.llmBoundaryIndex = this.middleware.length;
    return this;
  }

  /** Run the full pipeline for a user message */
  async run(userMessage: string, history: Message[] = []): Promise<PipelineContext> {
    const ctx: PipelineContext = {
      userMessage,
      messages: [...history],
      metadata: {},
    };

    // Build the middleware chain
    let index = 0;
    const executeNext = async (): Promise<void> => {
      if (index < this.middleware.length) {
        const mw = this.middleware[index++];
        await mw(ctx, executeNext);
      }
    };

    await executeNext();
    ctx.messages = normalizeMessages(ctx.messages);
    return ctx;
  }

  /**
   * Run only the pre-LLM middleware steps (up to the LLM boundary).
   * Returns a populated PipelineContext with enriched ctx.messages — ready
   * to be passed directly to chain.stream(). Used by the streaming endpoint.
   *
   * If no boundary is marked, runs all middleware (falls back to full run).
   */
  async buildContext(userMessage: string, history: Message[] = []): Promise<PipelineContext> {
    const ctx: PipelineContext = {
      userMessage,
      messages: [...history],
      metadata: {},
    };

    const boundary = this.llmBoundaryIndex > -1
      ? this.llmBoundaryIndex
      : this.middleware.length;

    let index = 0;
    const executeNext = async (): Promise<void> => {
      if (index < boundary) {
        const mw = this.middleware[index++];
        await mw(ctx, executeNext);
      }
    };

    await executeNext();
    ctx.messages = normalizeMessages(ctx.messages);
    return ctx;
  }

  /**
   * Run only the post-LLM middleware steps (after the LLM boundary).
   * Call this after streaming is complete, passing the ctx with ctx.response set.
   * All post-LLM middlewares already use setImmediate internally, so this
   * returns immediately — extractions continue in the background.
   *
   * Note: skips llmCallMiddleware itself (index === llmBoundaryIndex) since
   * the streaming endpoint has already handled the LLM call directly.
   */
  async runPostLlm(ctx: PipelineContext): Promise<void> {
    if (this.llmBoundaryIndex === -1) return; // no boundary set

    // llmBoundaryIndex points to llmCallMiddleware; skip it (+1) and run the rest
    let index = this.llmBoundaryIndex + 1;
    const executeNext = async (): Promise<void> => {
      if (index < this.middleware.length) {
        const mw = this.middleware[index++];
        await mw(ctx, executeNext);
      }
    };

    await executeNext();
  }
}

// ─── Built-in Middleware: System Prompt & Temporal Context ──────────────────

/**
 * Constructs a rich, real-time temporal context frame so the LLM intrinsically understands
 * current date, time, year, yesterday, this week, last week, and trailing day windows.
 */
export function buildTemporalContext(now: Date = new Date(), timeZone: string = 'Asia/Kolkata'): string {
  const dateFmt = (d: Date) =>
    d.toLocaleDateString('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

  const shortDateFmt = (d: Date) =>
    d.toLocaleDateString('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  const timeFmt = (d: Date) =>
    d.toLocaleTimeString('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });

  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
  const dayOfWeek = today.getDay();
  const diffToMonday = (dayOfWeek + 6) % 7;
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - diffToMonday);

  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);

  const lastFriday = new Date(lastMonday);
  lastFriday.setDate(lastMonday.getDate() + 4);

  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);

  const sections: string[] = [
    `## Temporal Context (Real-Time Clock)`,
    `- Current Time: ${timeFmt(now)}`,
    `- Today: ${dateFmt(today)} (${today.toISOString().split('T')[0]})`,
    `- Yesterday: ${dateFmt(yesterday)}`,
    `- Current Year: ${now.getFullYear()}`,
    `- Current Week: ${shortDateFmt(thisMonday)} – ${shortDateFmt(today)}`,
    `- Last Week (Trading / Business): ${shortDateFmt(lastMonday)} – ${shortDateFmt(lastFriday)}`,
    `- Last Week (Full Calendar): ${shortDateFmt(lastMonday)} – ${shortDateFmt(lastSunday)}`,
    `- Trailing 7 Days: ${shortDateFmt(sevenDaysAgo)} – ${shortDateFmt(today)}`,
    ``,
    `Temporal Understanding:`,
    `You are operating in real time at the date and hour above. When answering questions with relative time references (such as "today", "yesterday", "this week", "last week", "last 7 days", or "recent"), ground your analysis in these exact calendar windows.`,
  ];

  return sections.join('\n');
}

/**
 * Injects the personality system prompt and live temporal context at the start of the message list.
 */
export function systemPromptMiddleware(systemPrompt: string): Middleware {
  return async (ctx, next) => {
    const temporalContext = buildTemporalContext(new Date(), 'Asia/Kolkata');
    const dynamicSystemPrompt = `${systemPrompt}\n\n${temporalContext}`;

    // Prepend system message if not already present
    if (!ctx.messages.some((m) => m.role === 'system')) {
      ctx.messages.unshift({ role: 'system', content: dynamicSystemPrompt });
    } else {
      const sysMsg = ctx.messages.find((m) => m.role === 'system');
      if (sysMsg) {
        const marker = '## Temporal Context (Real-Time Clock)';
        if (sysMsg.content.includes(marker)) {
          const idx = sysMsg.content.indexOf(marker);
          sysMsg.content = sysMsg.content.substring(0, idx).trim() + '\n\n' + temporalContext;
        } else {
          sysMsg.content += `\n\n${temporalContext}`;
        }
      }
    }

    // Add the current user message
    ctx.messages.push({ role: 'user', content: ctx.userMessage });

    await next();
  };
}

// ─── Built-in Middleware: LLM Call ───────────────────────────────────────────

import type { LLMProvider } from '@jarvis/shared';

/**
 * Calls the LLM with the assembled messages and stores the response.
 */
export function llmCallMiddleware(provider: LLMProvider): Middleware {

  // system and KB metrics lead to influxion here: the cleaned up tally should be put in the metrics DB.
  // unify the logic for 3 nodes here.
  return async (ctx, next) => {
    ctx.response = await provider.chat(ctx.messages);
    await next();
  };
}
