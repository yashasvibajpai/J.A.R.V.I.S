import type { ProfileStore, LLMProvider } from '@jarvis/shared';
import type { Middleware } from './pipeline.js';

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
            content: `Current profile context:\n${currentContext}\n\nUser said: "${ctx.userMessage}"\nAssistant replied: "${ctx.response}"`,
          },
        ],
        { temperature: 0.1, maxTokens: 512 }
      );

      const updates = parseProfileUpdates(extraction);

      if (updates && Object.keys(updates).length > 0) {
        await profileStore.updateProfile(DEFAULT_USER_ID, updates);
        console.log(
          `[profile] updated: ${Object.keys(updates).join(', ')}`
        );
        ctx.metadata.profileUpdated = true;
      }
    } catch (err) {
      console.warn(`[profile] extraction failed: ${err}`);
    }
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseProfileUpdates(raw: string): Partial<{
  preferredName: string;
  context: Record<string, any>;
  preferences: Record<string, any>;
}> | null {
  try {
    // Extract JSON from the response (it might be wrapped in markdown code blocks)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // Only return non-empty updates
    const result: Record<string, any> = {};
    if (parsed.preferredName) result.preferredName = parsed.preferredName;
    if (parsed.context && Object.keys(parsed.context).length > 0) {
      result.context = parsed.context;
    }
    if (parsed.preferences && Object.keys(parsed.preferences).length > 0) {
      result.preferences = parsed.preferences;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}
