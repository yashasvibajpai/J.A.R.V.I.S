/**
 * llm-output.ts — Lightweight LLM output validation helpers.
 *
 * Replaces Zod for zero-extra-dependency validation of JSON outputs produced
 * by LLMs during extraction steps. Small/quantised models frequently emit
 * malformed JSON (trailing commas, missing braces, markdown fences, etc.).
 *
 * Pattern:
 *   1. Strip common markdown fences and leading/trailing prose.
 *   2. Try JSON.parse.
 *   3. Run a typed schema check — return null (not throw) on failure.
 *
 * Usage:
 *   const updates = parseProfileOutput(raw);
 *   if (!updates) { warn and skip; }
 */

// ─── JSON Extraction ─────────────────────────────────────────────────────────

/**
 * Extracts the first {...} JSON object from a raw LLM string.
 * Handles markdown code fences and surrounding prose gracefully.
 */
export function extractJson(raw: string): unknown | null {
  if (!raw || typeof raw !== 'string') return null;

  // Strip ```json ... ``` or ``` ... ``` fences
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  // Find the outermost { ... } block
  const start = stripped.indexOf('{');
  if (start === -1) return null;

  // Walk to find matching closing brace
  let depth = 0;
  let end = -1;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) return null;

  const jsonStr = stripped.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch {
    // Try a lenient repair: strip trailing commas before ] and }
    try {
      const repaired = jsonStr.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── Profile Output Schema ───────────────────────────────────────────────────

export interface ProfileUpdates {
  preferredName?: string;
  context?: {
    role?: string;
    location?: string;
    timezone?: string;
    interests?: string[];
    goals?: string[];
  };
  preferences?: Record<string, string>;
}

/**
 * Parses and validates the profile extraction LLM output.
 * Returns null (not throws) if the output is empty or malformed.
 */
export function parseProfileOutput(raw: string): ProfileUpdates | null {
  if (raw.trim() === '{}' || raw.trim() === '') return null;

  const parsed = extractJson(raw);
  if (!isRecord(parsed)) return null;

  const result: ProfileUpdates = {};

  // preferredName
  if (isString(parsed.preferredName) && parsed.preferredName.trim().length > 0) {
    result.preferredName = parsed.preferredName.trim();
  }

  // context block
  if (isRecord(parsed.context)) {
    const ctx: ProfileUpdates['context'] = {};
    if (isString(parsed.context.role)) ctx.role = parsed.context.role.trim();
    if (isString(parsed.context.location)) ctx.location = parsed.context.location.trim();
    if (isString(parsed.context.timezone)) ctx.timezone = parsed.context.timezone.trim();
    if (isStringArray(parsed.context.interests)) ctx.interests = parsed.context.interests;
    if (isStringArray(parsed.context.goals)) ctx.goals = parsed.context.goals;
    if (Object.keys(ctx).length > 0) result.context = ctx;
  }

  // preferences: coerce all values to strings, skip non-string values
  if (isRecord(parsed.preferences)) {
    const prefs: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.preferences)) {
      if (isString(v) && v.trim().length > 0) {
        prefs[k] = v.trim();
      }
    }
    if (Object.keys(prefs).length > 0) result.preferences = prefs;
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ─── Task Extraction Output Schema ───────────────────────────────────────────

export type TaskActionType = 'task_create' | 'task_complete' | 'reminder_create' | 'capture';

export interface TaskAction {
  type: TaskActionType;
  content: string;
}

const VALID_ACTION_TYPES = new Set<string>([
  'task_create', 'task_complete', 'reminder_create', 'capture',
]);

/**
 * Parses the task extraction LLM output (line-based format, not JSON).
 * Each line must match: [action_type] content
 * Silently skips malformed lines instead of corrupting the store.
 */
export function parseTaskOutput(raw: string): TaskAction[] {
  if (!raw || raw.trim() === 'NONE' || raw.trim() === '') return [];

  const actions: TaskAction[] = [];
  const lines = raw.split('\n').filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^\[([\w_]+)\]\s*(.+)$/);
    if (!match) continue;

    const type = match[1];
    const content = match[2].trim();

    if (!VALID_ACTION_TYPES.has(type)) continue;
    if (content.length < 3 || content.length > 500) continue; // sanity bounds

    actions.push({ type: type as TaskActionType, content });
  }

  return actions;
}

// ─── Memory Extraction Output Schema ─────────────────────────────────────────

export type MemoryCategory = 'fact' | 'preference' | 'event' | 'goal' | 'relationship' | 'context';

export interface ExtractedMemory {
  category: MemoryCategory;
  content: string;
}

const VALID_MEMORY_CATEGORIES = new Set<string>([
  'fact', 'preference', 'event', 'goal', 'relationship', 'context',
]);

/**
 * Parses the memory extraction LLM output (line-based format).
 * Each line must match: [category] content
 */
export function parseMemoryOutput(raw: string): ExtractedMemory[] {
  if (!raw || raw.trim() === 'NONE' || raw.trim() === '') return [];

  const memories: ExtractedMemory[] = [];
  const lines = raw.split('\n').filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^\[([\w]+)\]\s*(.+)$/);
    if (!match) continue;

    const category = match[1].toLowerCase();
    const content = match[2].trim();

    if (!VALID_MEMORY_CATEGORIES.has(category)) continue;
    if (content.length < 5 || content.length > 1000) continue;

    memories.push({ category: category as MemoryCategory, content });
  }

  return memories;
}
