import type { TaskStore, ReminderStore, CaptureStore, LLMProvider } from '@jarvis/shared';
import type { Middleware } from './pipeline.js';

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

    try {
      const extraction = await llm.chat([
        { role: 'system', content: TASK_EXTRACTION_PROMPT },
        { role: 'user', content: `User: "${ctx.userMessage}"\nJARVIS: "${ctx.response}"` }
      ], { temperature: 0.1, maxTokens: 512 });

      const actions = parseTaskExtraction(extraction);

      for (const action of actions) {
        if (action.type === 'task_create') {
          await taskStore.createTask({
             description: action.content,
             status: 'pending',
             priority: 'medium',
             tags: []
          });
          console.log(`[task] created task: ${action.content}`);
        } else if (action.type === 'task_complete') {
          // Fallback, as our simple regex might just grab a string instead of ID.
          // In a real system, you'd match the task by description/FTS, but here we'll try ID.
          try {
             await taskStore.updateTask(action.content, { status: 'completed' });
             console.log(`[task] completed task: ${action.content}`);
          } catch(e) {
             console.warn(`[task] failed to complete task ${action.content}`);
          }
        } else if (action.type === 'reminder_create') {
          await reminderStore.createReminder({
             description: action.content,
             completed: false
          });
          console.log(`[task] created reminder: ${action.content}`);
        } else if (action.type === 'capture') {
          await captureStore.createCapture({
             content: action.content,
             category: 'thought'
          });
          console.log(`[task] captured thought: ${action.content}`);
        }
      }
      
      if (actions.length > 0) {
         ctx.metadata.tasksExtracted = actions.length;
      }
    } catch (err) {
      console.warn(`[task] extraction failed: ${err}`);
    }
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

function parseTaskExtraction(raw: string) {
  if (raw.trim() === 'NONE' || raw.trim() === '') return [];
  const lines = raw.split('\n').filter(Boolean);
  const actions = [];
  
  for (const line of lines) {
    const match = line.match(/\[(task_create|task_complete|reminder_create|capture)\]\s*(.+)/);
    if (match) {
      actions.push({ type: match[1], content: match[2].trim() });
    }
  }

  if (actions.length === 0 && raw.trim() !== 'NONE') {
    console.debug(`[task] Extracted nothing but LLM returned: ${raw}`);
  }

  return actions;
}
