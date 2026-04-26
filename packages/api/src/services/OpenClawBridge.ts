/**
 * OpenClawBridge
 *
 * This service connects JARVIS to the local OpenClaw Gateway.
 * It provides type-safe wrappers around OpenClaw's tools (e.g., web search, command execution)
 * so JARVIS can execute OS-level agency actions through a stable interface.
 */

export class OpenClawBridge {
  private enabled: boolean;
  private url: string;
  private token: string;

  constructor() {
    this.enabled = process.env.OPENCLAW_ENABLED === 'true';
    this.url = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
    this.token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  }

  /**
   * Universal fetch wrapper for calling OpenClaw REST endpoints.
   */
  private async fetchOpenClaw(endpoint: string, payload: any): Promise<any> {
    if (!this.enabled) {
      throw new Error('OpenClaw integration is disabled in .env (OPENCLAW_ENABLED=false)');
    }

    if (!this.token) {
      throw new Error('OpenClaw gateway token is missing in .env');
    }

    const response = await fetch(`${this.url}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenClaw error (${response.status}): ${errText}`);
    }

    return response.json();
  }

  /**
   * Invokes an OpenClaw tool by name.
   * Assumes the gateway exposes the /v1/tools/invoke endpoint (or equivalent adapter).
   */
  async invokeTool(toolName: string, args: Record<string, any>): Promise<any> {
    try {
      console.log(`[OpenClaw] Invoking tool: ${toolName}`, args);
      // Try the REST endpoint defined in the architecture plan
      const result = await this.fetchOpenClaw('/v1/tools/invoke', {
        name: toolName,
        args,
      });
      return result;
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
