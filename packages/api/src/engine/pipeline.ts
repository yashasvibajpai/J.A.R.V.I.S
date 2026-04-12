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
 *     → [Memory Extract]     ← Phase 1C
 *     → [Profile Update]     ← Phase 1C
 *     → [Feedback Tracking]  ← Phase 1D
 *   Response
 *
 * For now (P1B): System Prompt Injection → LLM Call.
 * Each phase adds more middleware steps without touching existing ones.
 */
export class Pipeline {
  private middleware: Middleware[] = [];

  /** Add a middleware step to the end of the pipeline */
  use(mw: Middleware): this {
    this.middleware.push(mw);
    return this;
  }

  /** Run the full pipeline for a user message */
  async run(userMessage: string, history: Message[] = []): Promise<PipelineContext> {
    const ctx: PipelineContext = {
      userMessage,
      messages: [...history],
      metadata: {},
    };

    // Build the middleware chain (last-to-first)
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
}

// ─── Built-in Middleware: System Prompt ───────────────────────────────────────

/**
 * Injects the personality system prompt at the start of the message list.
 */
export function systemPromptMiddleware(systemPrompt: string): Middleware {
  return async (ctx, next) => {
    // Prepend system message if not already present
    if (!ctx.messages.some((m) => m.role === 'system')) {
      ctx.messages.unshift({ role: 'system', content: systemPrompt });
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
  return async (ctx, next) => {
    ctx.response = await provider.chat(ctx.messages);
    await next();
  };
}
