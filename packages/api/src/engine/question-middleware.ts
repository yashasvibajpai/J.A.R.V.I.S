import type { Middleware } from './pipeline.js';

export const QUESTION_TOOLS_CATALOGUE = `
## Interactive Clarification & Design Decision Forms
When you need clarifying information, design decisions, architectural preferences, or technology choices before implementing or answering:
DO NOT dump a long numbered wall of questions into plain chat text.
Instead, emit an \`\`\`ask_question block with structured tabs:

\`\`\`ask_question
{
  "questions": [
    {
      "id": "architecture",
      "title": "Architecture",
      "question": "Which architecture pattern should we use for this implementation?",
      "options": [
        "Modular Service Architecture (Recommended for JARVIS)",
        "Single-file micro-module",
        "Event-driven pub/sub"
      ],
      "is_multi_select": false
    }
  ]
}
\`\`\`

RULES:
- Keep the number of tabs concise (1 to 3 questions).
- Put the recommended option first with "(Recommended)".
- Provide 2 to 4 clear, distinct choices per question.
- The terminal CLI will natively render an interactive tabbed questionnaire wizard for the user.
`;

/**
 * Pre-LLM middleware to inject interactive question capabilities into system prompt.
 */
export function questionPromptMiddleware(): Middleware {
  return async (ctx, next) => {
    const sysIndex = ctx.messages.findIndex((m) => m.role === 'system');
    if (sysIndex >= 0) {
      ctx.messages[sysIndex].content += `\n\n${QUESTION_TOOLS_CATALOGUE}`;
    } else {
      ctx.messages.unshift({ role: 'system', content: QUESTION_TOOLS_CATALOGUE });
    }
    await next();
  };
}
