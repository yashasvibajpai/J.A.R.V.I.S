import type { MemoryStore, LLMProvider } from '@jarvis/shared';
import type { Middleware } from './pipeline.js';
import { parseMemoryOutput } from './llm-output.js';

/**
 * Memory Recall Middleware — runs BEFORE the LLM call.
 *
 * Searches for relevant memories based on the user's message
 * and injects them into the context so the LLM can reference them.
 */
export function memoryRecallMiddleware(memoryStore: MemoryStore): Middleware {
  return async (ctx, next) => {
    try {
      const memories = await memoryStore.search(ctx.userMessage, 5);

      if (memories.length > 0) {
        const memoryBlock = memories
          .map((m) => `- [${m.category}] ${m.content}`)
          .join('\n');

        // Inject memories as a system message before the user's message
        const userMsgIndex = ctx.messages.findIndex(
          (m) => m.role === 'user' && m.content === ctx.userMessage
        );

        const injection = {
          role: 'system' as const,
          content: `## Relevant Memories\nYou remember the following about this user. Reference naturally when relevant — don't force it.\n\n${memoryBlock}`,
        };

        if (userMsgIndex > 0) {
          ctx.messages.splice(userMsgIndex, 0, injection);
        } else {
          // Insert after the first system message
          const sysIndex = ctx.messages.findIndex((m) => m.role === 'system');
          ctx.messages.splice(sysIndex + 1, 0, injection);
        }

        ctx.metadata.memoriesRecalled = memories.length;
        console.log(`[memory] recalled ${memories.length} memories`);
      }
    } catch (err) {
      // Memory recall is non-critical — don't block the conversation
      console.warn(`[memory] recall failed: ${err}`);
    }

    await next();
  };
}

/**
 * Memory Extraction Middleware — runs AFTER the LLM call.
 *
 * Uses the LLM itself to extract facts worth remembering from the
 * conversation exchange. This is how JARVIS *learns* about you.
 *
 * ⚡ ASYNC WRITE PATH: extraction is intentionally fire-and-forget.
 * The HTTP response is NOT held open waiting for this — it schedules
 * the write via setImmediate so it runs after the response is flushed.
 */
export function memoryExtractionMiddleware(
  memoryStore: MemoryStore,
  llm: LLMProvider
): Middleware {
  return async (ctx, next) => {
    await next(); // Let the LLM respond first; response is now set on ctx

    // Don't extract from trivial exchanges
    if (!ctx.response || ctx.userMessage.trim().length < 10) return;

    // ── Fire-and-forget: schedule after the current event loop tick ──────────
    // The calling code (pipeline.run) has already returned ctx to the route
    // handler, which sends the HTTP response. This extraction runs in the
    // background — if it fails, it logs a warning but never affects the user.
    const userMessage = ctx.userMessage;
    const response = ctx.response;

    setImmediate(async () => {
      try {
        const extraction = await llm.chat([
          {
            role: 'system',
            content: EXTRACTION_PROMPT,
          },
          {
            role: 'user',
            content: `User said: "${userMessage}"\n\nAssistant replied: "${response}"`,
          },
        ], { temperature: 0.1, maxTokens: 512, taskHint: 'quick' });

        const facts = parseMemoryOutput(extraction);

        if (facts.length > 0) {
          for (const fact of facts) {
            // Check for duplicates before adding
            const existing = await memoryStore.search(fact.content, 3);
            const isDuplicate = existing.some(
              (m) => similarity(m.content, fact.content) > 0.8
            );

            if (!isDuplicate) {
              await memoryStore.add(fact.content, fact.category);
              console.log(`[memory:bg] stored: [${fact.category}] ${fact.content}`);
            }
          }
          console.log(`[memory:bg] extraction complete — ${facts.length} fact(s) processed`);
        }
      } catch (err) {
        console.warn(`[memory:bg] extraction failed (non-fatal): ${err}`);
      }
    });

    // Mark that extraction was kicked off (not necessarily completed yet)
    ctx.metadata.memoriesExtractionScheduled = true;
  };
}

// ─── Extraction Prompt ──────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a memory extraction system. Given a conversation exchange, extract facts worth remembering about the user.

CRITICAL RULES:
- Only extract personal facts that the USER explicitly revealed about THEMSELVES (their preferences, job, family, plans, goals, tools, habits, etc.).
- NEVER extract facts, world knowledge, news summaries, historical facts, or explanations provided by the ASSISTANT.
- NEVER assume the user "is aware of", "is informed about", or "knows" something just because the assistant talked about it or because the user asked about it.
- If the user merely asked a question (e.g. "what's the latest on X?", "how do I do Y?"), asked for news/help, or engaged in general conversation without disclosing personal facts, respond with "NONE".
- Only extract CONCRETE, SPECIFIC facts — not vague observations.
- Each fact should stand alone without context.
- Skip pleasantries, greetings, and meta-conversation.

Respond in this exact format (one fact per line):
[category] fact content

Valid categories: fact, preference, event, goal, relationship, context

Examples:
[fact] User works as a software engineer at Acme Corp
[preference] User prefers concise responses over detailed explanations
[goal] User wants to learn Rust this quarter
[relationship] Alice is the user's manager
[event] User has a job interview next Tuesday
[context] User is currently stressed about a project deadline

If nothing personal worth remembering about the user was shared: NONE`;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Simple string similarity (Jaccard index on word sets).
 * Used for deduplication — not a vector embedding, but works well
 * enough for catching near-identical memories.
 */
function similarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}
