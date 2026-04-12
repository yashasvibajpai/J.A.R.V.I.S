import type { Middleware } from './pipeline.js';

/**
 * Observability Middleware — wraps the entire pipeline.
 *
 * Logs request/response timing, token estimates, provider info,
 * and memory/profile operations. This is the foundation for future
 * LangFuse integration (Phase 2+).
 *
 * Should be the FIRST middleware in the pipeline so it captures
 * the full duration of the request.
 */
export function observabilityMiddleware(): Middleware {
  let requestCount = 0;

  return async (ctx, next) => {
    const reqId = ++requestCount;
    const start = performance.now();
    const timestamp = new Date().toISOString();

    console.log(`\n╭─── Request #${reqId} ────────────────────────────────`);
    console.log(`│ Time:    ${timestamp}`);
    console.log(`│ Input:   "${truncate(ctx.userMessage, 60)}"`);
    console.log(`│ History: ${ctx.messages.length} messages`);

    try {
      await next();

      const duration = performance.now() - start;
      const inputTokens = estimateTokens(ctx.userMessage);
      const outputTokens = estimateTokens(ctx.response ?? '');

      console.log(`│ Output:  "${truncate(ctx.response ?? '', 60)}"`);
      console.log(`│ Tokens:  ~${inputTokens} in / ~${outputTokens} out`);
      console.log(`│ Memory:  ${ctx.metadata.memoriesRecalled ?? 0} recalled, ${ctx.metadata.memoriesExtracted ?? 0} extracted`);
      console.log(`│ Profile: ${ctx.metadata.profileUpdated ? 'updated' : 'unchanged'}`);
      console.log(`│ Time:    ${duration.toFixed(0)}ms`);
      console.log(`╰────────────────────────────────────────────────────\n`);

      // Store timing in metadata for API response
      ctx.metadata.timing = {
        durationMs: Math.round(duration),
        inputTokensEstimate: inputTokens,
        outputTokensEstimate: outputTokens,
        requestId: reqId,
      };
    } catch (err) {
      const duration = performance.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(`│ ERROR:   ${errorMsg}`);
      console.log(`│ Time:    ${duration.toFixed(0)}ms`);
      console.log(`╰────────────────────────────────────────────────────\n`);
      throw err;
    }
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}
