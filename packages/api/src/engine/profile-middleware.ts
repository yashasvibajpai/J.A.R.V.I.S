import type { ProfileStore, LLMProvider } from '@jarvis/shared';
import type { Middleware } from './pipeline.js';
import { parseProfileOutput } from './llm-output.js';

const DEFAULT_USER_ID = 'default';

/**
 * Profile Injection Middleware — runs BEFORE the LLM call.
 *
 * Loads the user's profile and injects key details into the context
 * so JARVIS knows who it's talking to.
 */
export function profileInjectionMiddleware(profileStore: ProfileStore): Middleware {
  return async (ctx, next) => {
    try {
      const profile = await profileStore.getProfile(DEFAULT_USER_ID);

      if (profile) {
        const parts: string[] = ['## User Profile'];

        if (profile.preferredName) {
          parts.push(`Name: ${profile.preferredName}`);
        } else if (profile.name) {
          parts.push(`Name: ${profile.name}`);
        }

        // Add context fields
        const ctxFields = profile.context;
        if (ctxFields.role) parts.push(`Role: ${ctxFields.role}`);
        if (ctxFields.location) parts.push(`Location: ${ctxFields.location}`);
        if (ctxFields.timezone) parts.push(`Timezone: ${ctxFields.timezone}`);
        if (ctxFields.interests?.length) {
          parts.push(`Interests: ${ctxFields.interests.join(', ')}`);
        }
        if (ctxFields.goals?.length) {
          parts.push(`Goals: ${ctxFields.goals.join(', ')}`);
        }

        // Add top preferences
        const prefEntries = Object.entries(profile.preferences);
        if (prefEntries.length > 0) {
          parts.push('\n### Preferences');
          for (const [key, val] of prefEntries.slice(0, 10)) {
            parts.push(`- ${key}: ${val}`);
          }
        }

        // Inject after the first system message
        const sysIndex = ctx.messages.findIndex((m) => m.role === 'system');
        ctx.messages.splice(sysIndex + 1, 0, {
          role: 'system',
          content: parts.join('\n'),
        });

        ctx.metadata.profileLoaded = true;
        console.log(`[profile] injected profile (v${profile.version})`);
      }
    } catch (err) {
      console.warn(`[profile] injection failed: ${err}`);
    }

    await next();
  };
}

/**
 * Profile Extraction Middleware — runs AFTER the LLM call.
 *
 * Periodically uses the LLM to extract profile-level facts
 * (preferences, context, etc.) from the conversation.
 * Runs less frequently than memory extraction — every 5 messages.
 *
 * ⚡ ASYNC WRITE PATH: extraction is fire-and-forget via setImmediate.
 * The HTTP response is not held open. Output is validated with
 * parseProfileOutput() — malformed JSON from small models returns null
 * and is silently skipped (no store corruption).
 */
export function profileExtractionMiddleware(
  profileStore: ProfileStore,
  llm: LLMProvider,
  interval = 5
): Middleware {
  let messageCount = 0;

  return async (ctx, next) => {
    await next(); // Let the LLM respond first

    messageCount++;
    if (messageCount % interval !== 0) return; // Only run every N messages
    if (!ctx.response || ctx.userMessage.trim().length < 15) return;

    // Capture values before the async boundary
    const userMessage = ctx.userMessage;
    const response = ctx.response;

    // ── Fire-and-forget ───────────────────────────────────────────────────────
    setImmediate(async () => {
      try {
        const currentProfile = await profileStore.getProfile(DEFAULT_USER_ID);
        const currentContext = currentProfile
          ? JSON.stringify(currentProfile.context, null, 2)
          : '{}';

        const extraction = await llm.chat(
          [
            { role: 'system', content: PROFILE_EXTRACTION_PROMPT },
            {
              role: 'user',
              content: `Current profile context:\n${currentContext}\n\nUser said: "${userMessage}"\nAssistant replied: "${response}"`,
            },
          ],
          { temperature: 0.1, maxTokens: 512 }
        );

        // ── Zod-equivalent validation — no silent corruption ─────────────────
        const updates = parseProfileOutput(extraction);

        if (updates) {
          await profileStore.updateProfile(DEFAULT_USER_ID, updates);
          console.log(
            `[profile:bg] updated: ${Object.keys(updates).join(', ')}`
          );
        }
      } catch (err) {
        console.warn(`[profile:bg] extraction failed (non-fatal): ${err}`);
      }
    });

    ctx.metadata.profileExtractionScheduled = true;
  };
}

// ─── Profile Extraction Prompt ──────────────────────────────────────────────

const PROFILE_EXTRACTION_PROMPT = `You are a user profile extraction system. Given a conversation exchange and the current profile, extract any NEW or UPDATED information about the user.

Only extract concrete facts. Do not speculate.

Respond in valid JSON with ONLY the fields that should be updated:

{
  "preferredName": "...",
  "context": {
    "role": "...",
    "location": "...",
    "timezone": "...",
    "interests": ["..."],
    "goals": ["..."]
  },
  "preferences": {
    "key": "value"
  }
}

If nothing new to extract, respond with exactly: {}`;
