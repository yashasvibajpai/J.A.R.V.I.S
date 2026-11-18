import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * OpenClawBridge
 *
 * This service connects JARVIS to the local OpenClaw Gateway.
 * It provides type-safe wrappers around OpenClaw's tools (e.g., web search, command execution)
 * so JARVIS can execute OS-level agency actions through a stable interface.
 */
export class OpenClawBridge {
  private enabled: boolean;

  constructor() {
    this.enabled = process.env.OPENCLAW_ENABLED === 'true';
  }

  /**
   * Invokes an OpenClaw tool by name using the OpenClaw CLI Gateway Call.
   */
  async invokeTool(toolName: string, args: Record<string, any>): Promise<any> {
    if (!this.enabled) {
      throw new Error('OpenClaw integration is disabled in .env (OPENCLAW_ENABLED=false)');
    }

    try {
      console.log(`[OpenClaw] Invoking tool: ${toolName}`, args);
      
      // If it's the message.send tool, use the native CLI command for reliability
      if (toolName === 'message.send') {
        const { target, message } = args;
        const { stdout, stderr } = await execAsync(
          `openclaw message send --target "${target}" --message "${message}" --json`
        );
        if (stderr && !stdout) throw new Error(stderr);
        try { return JSON.parse(stdout); } catch (e) { return { result: stdout }; }
      }

      // Otherwise, use the generic tools.invoke gateway call
      const paramsJson = JSON.stringify({ tool: toolName, params: args }).replace(/"/g, '\\"');
      const { stdout, stderr } = await execAsync(`openclaw gateway call tools.invoke --params "${paramsJson}"`);
      
      if (stderr && !stdout) {
        throw new Error(stderr);
      }

      try {
        return JSON.parse(stdout);
      } catch (err) {
        return { output: stdout };
      }
    } catch (err: any) {
      console.error(`[OpenClaw] Tool invocation failed: ${err.message}`);
      throw err;
    }
  }

  // ─── High-Level Tool Wrappers ─────────────────────────────────────────────

  /**
   * Triggers the OpenClaw `web.search` tool.
   * @param query The search query string.
   */
  async webSearch(query: string): Promise<any> {
    return this.invokeTool('web.search', { query });
  }

  /**
   * Triggers the OpenClaw `os.exec` tool for shell command execution.
   * @param command The bash/shell command to execute.
   */
  async execCommand(command: string): Promise<any> {
    return this.invokeTool('os.exec', { command });
  }
}
