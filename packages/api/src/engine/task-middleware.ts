import type { TaskStore, ReminderStore, CaptureStore, LLMProvider } from '@jarvis/shared';
import type { Middleware } from './pipeline.js';
import { parseTaskOutput } from './llm-output.js';

/**
 * Task Recall Middleware — runs BEFORE the LLM call.
 * Injects pending tasks and active reminders into the context.
 */
export function taskRecallMiddleware(
  taskStore: TaskStore,
  reminderStore: ReminderStore
): Middleware {
  return async (ctx, next) => {
    try {
      const openTasks = await taskStore.queryTasks({ status: 'pending' });
      const pendingReminders = await reminderStore.getPendingReminders();

      let injectionContext = '';
      if (openTasks.length > 0) {
        injectionContext += '## Pending Tasks:\n';
        for (const t of openTasks.slice(0, 5)) {
          injectionContext += `- [${t.priority}] ${t.description} (ID: ${t.id})\n`;
        }
      }
      if (pendingReminders.length > 0) {
        injectionContext += '\n## Active Reminders:\n';
        for (const r of pendingReminders.slice(0, 3)) {
          injectionContext += `- ${r.description} (Trigger: ${r.triggerTime || r.triggerContext || 'None'})\n`;
        }
      }

      if (injectionContext.length > 0) {
        const injection = {
          role: 'system' as const,
          content: `[SYSTEM] You are aware of the user's current tasks and reminders. Refer to them if asked directly.\n\n${injectionContext}`,
        };

        const sysIndex = ctx.messages.findIndex((m) => m.role === 'system');
        ctx.messages.splice(sysIndex + 1, 0, injection);
      }
    } catch (err) {
      console.warn(`[task] recall failed: ${err}`);
    }

    await next();
  };
}

/**
 * Task Extraction Middleware — runs AFTER the LLM call.
 * Extracts new tasks, reminders, and thoughts from the conversation block.
 *
 * ⚡ ASYNC WRITE PATH: extraction is fire-and-forget via setImmediate.
 * Output is validated with parseTaskOutput() — malformed lines from
 * small models are silently skipped (no store corruption).
 */
export function taskExtractionMiddleware(
  taskStore: TaskStore,
  reminderStore: ReminderStore,
  captureStore: CaptureStore,
  llm: LLMProvider
): Middleware {
  return async (ctx, next) => {
    await next();

    if (!ctx.response || ctx.userMessage.trim().length < 5) return;

    // Capture values before async boundary
    const userMessage = ctx.userMessage;
    const response = ctx.response;

    // ── Fire-and-forget ───────────────────────────────────────────────────────
    setImmediate(async () => {
      try {
        const extraction = await llm.chat([
          { role: 'system', content: TASK_EXTRACTION_PROMPT },
          { role: 'user', content: `User: "${userMessage}"\nJARVIS: "${response}"` }
        ], { temperature: 0.1, maxTokens: 512 });

        // ── Validated parse — unknown action types and malformed lines dropped ─
        const actions = parseTaskOutput(extraction);

        for (const action of actions) {
          if (action.type === 'task_create') {
            await taskStore.createTask({
              description: action.content,
              status: 'pending',
              priority: 'medium',
              tags: []
            });
            console.log(`[task:bg] created task: ${action.content}`);
          } else if (action.type === 'task_complete') {
            try {
              await taskStore.updateTask(action.content, { status: 'completed' });
              console.log(`[task:bg] completed task: ${action.content}`);
            } catch (e) {
              console.warn(`[task:bg] failed to complete task ${action.content}`);
            }
          } else if (action.type === 'reminder_create') {
            await reminderStore.createReminder({
              description: action.content,
              completed: false
            });
            console.log(`[task:bg] created reminder: ${action.content}`);
          } else if (action.type === 'capture') {
            await captureStore.createCapture({
              content: action.content,
              category: 'thought'
            });
            console.log(`[task:bg] captured thought: ${action.content}`);
          }
        }

        if (actions.length > 0) {
          console.log(`[task:bg] extraction complete — ${actions.length} action(s) processed`);
        }
      } catch (err) {
        console.warn(`[task:bg] extraction failed (non-fatal): ${err}`);
      }
    });

    ctx.metadata.taskExtractionScheduled = true;
  };
}

const TASK_EXTRACTION_PROMPT = `You are an Action Extraction system. Given a conversation, extract new tasks, reminders, or quick thoughts.
Output in the exact format (one per line):
[task_create] description of the task
[task_complete] task_id (if a specific task ID was mentioned)
[reminder_create] description of the reminder
[capture] quick unstructured thought or link to process later

Only extract if the user implicitly or explicitly requested it. If nothing, output NONE.
Example:
[task_create] Buy groceries tomorrow
[capture] Gamify the onboarding flow`;
