import type { Middleware } from './pipeline.js';
import type { Message } from '@jarvis/shared';

/**
 * Token Truncation Middleware
 * 
 * Protects local LLMs (like Gemma 8k context) from overflowing and crashing
 * during long conversations by dropping the oldest chat history messages 
 * when the payload exceeds estimated safety limits.
 * 
 * Retains all `system` instructions (Personality, RAG, Calendar).
 * Always retains the most recent user prompt.
 */
export function tokenTruncationMiddleware(maxTokens = 6000): Middleware {
  // Rough estimate: 1 token = ~4 characters
  const MAX_CHARS = maxTokens * 4;

  const countChars = (msgs: Message[]) => 
    msgs.reduce((acc, m) => acc + (m.content?.length || 0), 0);

  return async (ctx, next) => {
    let totalChars = countChars(ctx.messages);

    if (totalChars > MAX_CHARS) {
      console.log(`[tokens] Context window approaching limit (${totalChars} chars). Truncating history...`);

      // Separate absolute requirements from trimmable history
      const systemMsgs = ctx.messages.filter(m => m.role === 'system');
      const latestUserMsg = ctx.messages[ctx.messages.length - 1]; // Current prompt
      
      // Candidate messages for trimming (everything between system prompts and the latest prompt)
      let historyMsgs = ctx.messages.filter(m => m.role !== 'system' && m !== latestUserMsg);

      // Iteratively drop the oldest message until we fit
      while (historyMsgs.length > 1) {
        historyMsgs.shift(); // remove oldest
        
        const testPayload = [...systemMsgs, ...historyMsgs, latestUserMsg];
        if (countChars(testPayload) <= MAX_CHARS) {
          break;
        }
      }

      ctx.messages = [...systemMsgs, ...historyMsgs, latestUserMsg];
      console.log(`[tokens] History truncated. New size: ${countChars(ctx.messages)} chars`);
    }

    await next();
  };
}
