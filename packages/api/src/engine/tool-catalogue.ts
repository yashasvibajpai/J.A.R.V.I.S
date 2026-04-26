import type { PipelineMiddleware } from './pipeline.js';
import type { OpenClawBridge } from '../services/OpenClawBridge.js';

/**
 * Builds the system prompt injection block that defines the available
 * OS-level actions JARVIS can take via OpenClaw.
 */
function buildToolCatalogue(): string {
  return `
## Available Actions (OS-Level Agency)

You have access to a suite of OS-level tools through your OpenClaw execution environment.
To use an action, you must emit a JSON block wrapped in \`\`\`action ... \`\`\` codefences in your response.

Available Tools:
- **web.search**: Search the internet for current information. Params: {"query": "search term"}
- **os.exec**: Run a shell command on the host machine. REQUIRES CONFIRMATION. Params: {"command": "shell command"}
- **file.read**: Read the contents of a local file. Params: {"path": "absolute path"}
- **file.write**: Write contents to a local file. REQUIRES CONFIRMATION. Params: {"path": "absolute path", "content": "text to write"}
- **browser.navigate**: Navigate to a URL and extract content. Params: {"url": "https://..."}

Example usage to search the web:
\`\`\`action
{"tool": "web.search", "params": {"query": "WWDC 2026 dates"}}
\`\`\`

Example usage to run a command:
\`\`\`action
{"tool": "os.exec", "params": {"command": "ls -la ~/Downloads"}}
\`\`\`

IMPORTANT RULES:
1. You may only emit ONE action block per response.
2. If you emit an action, do not try to answer the user's question fully yet — wait for the action result which will be provided in the next turn.
3. Keep your conversational response brief when emitting an action (e.g., "Let me search the web for that...").
`;
}

/**
 * Middleware that appends the tool catalogue to the system prompt
 * if the OpenClaw integration is enabled.
 */
export function toolCatalogueMiddleware(bridge: OpenClawBridge): PipelineMiddleware {
  return async (context, next) => {
    // We only inject the tool catalogue if the bridge is actively enabled
    if (process.env.OPENCLAW_ENABLED === 'true') {
      const catalogue = buildToolCatalogue();
      
      // Look for the system prompt message and append the catalogue
      const sysMsg = context.messages.find(m => m.role === 'system');
      if (sysMsg) {
        sysMsg.content += `\n\n${catalogue}`;
      } else {
        context.messages.unshift({ role: 'system', content: catalogue });
      }
    }
    
    await next();
  };
}
