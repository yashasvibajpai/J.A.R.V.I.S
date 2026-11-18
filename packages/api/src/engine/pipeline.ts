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

// ─── Built-in Middleware: System Prompt ───────────────────────────────────────

/**
 * Injects the personality system prompt at the start of the message list.
 */
export function systemPromptMiddleware(systemPrompt: string): Middleware {
  return async (ctx, next) => {
    const currentDateTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long' });
    const dynamicSystemPrompt = `${systemPrompt}\n\n## System Information\nCurrent Date and Time: ${currentDateTime}`;

    // Prepend system message if not already present
    if (!ctx.messages.some((m) => m.role === 'system')) {
      ctx.messages.unshift({ role: 'system', content: dynamicSystemPrompt });
    } else {
      const sysMsg = ctx.messages.find(m => m.role === 'system');
      if (sysMsg && !sysMsg.content.includes('Current Date and Time')) {
        sysMsg.content += `\n\n## System Information\nCurrent Date and Time: ${currentDateTime}`;
      }
    }
    // implement capture for system metrics here
    // route to alertmanager for post log processing steps

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
