import { v4 as uuidv4 } from 'uuid';
import type { Middleware } from './pipeline.js';
import type { OpenClawBridge } from '../services/OpenClawBridge.js';
import type { LLMProvider, ProfileStore } from '@jarvis/shared';

const DESTRUCTIVE_TOOLS = ['os.exec', 'file.write', 'message.send'];

/**
 * Middleware that inspects the LLM's response for ````action` blocks.
 * If found, it parses the action, strips it from the response text,
 * and sets `context.pendingAction`.
 * 
 * For safe actions, it auto-executes them via OpenClawBridge and makes a follow-up
 * LLM call to generate the final natural language response.
 */
export function openclawActionMiddleware(
  bridge: OpenClawBridge,
  chain: LLMProvider,
  profileStore: ProfileStore
): Middleware {
  return async (context, next) => {
    let enabled = process.env.OPENCLAW_ENABLED === 'true';
    try {
      const profile = await profileStore.getProfile('default');
      if (profile?.preferences?.openclaw_enabled !== undefined) {
        enabled = profile.preferences.openclaw_enabled === 'true';
      }
    } catch (e) {}

    // Only run if the bridge is enabled and we have a response
    if (!enabled || !context.response) {
      return next();
    }

    const actionRegex = /```action\s*\n([\s\S]*?)\n```/;
    let match = context.response.match(actionRegex);
    let rawJsonMatch = null;

    if (!match) {
      // Fallback: If the LLM just output raw JSON without markdown blocks
      rawJsonMatch = context.response.match(/({[\s\S]*"tool"[\s\S]*})/);
    }

    if (match || rawJsonMatch) {
      try {
        const payloadStr = match ? match[1] : rawJsonMatch![1];
        const actionPayload = JSON.parse(payloadStr);
        const tool = actionPayload.tool;
        const params = actionPayload.params || {};

        const safetyTier = DESTRUCTIVE_TOOLS.includes(tool) ? 'destructive' : 'safe';
        const actionId = uuidv4();

        // Remove the action block from the visible response text
        if (match) {
          context.response = context.response.replace(actionRegex, '').trim();
        } else if (rawJsonMatch) {
          context.response = context.response.replace(rawJsonMatch[0], '').trim();
        }

        if (safetyTier === 'destructive') {
          // Block pipeline: require user confirmation
          context.pendingAction = {
            id: actionId,
            tool,
            params,
            safetyTier
          };
          console.log(`[OpenClaw] Action requires confirmation: ${tool}`);
        } else {
          // Auto-execute safe actions inline and call LLM again
          console.log(`[OpenClaw] Auto-executing safe action: ${tool}`);

          let toolResult;
          try {
            toolResult = await bridge.invokeTool(tool, params);
          } catch (err: any) {
            toolResult = { error: err.message || String(err) };
          }

          // Append to message history
          context.messages.push({
            role: 'assistant',
            content: `[EXECUTED_TOOL: ${tool}]\nParams: ${JSON.stringify(params)}`
          });

          context.messages.push({
            role: 'user',
            content: `Tool Execution Result:\n${JSON.stringify(toolResult, null, 2)}\n\nNow provide a final response to the user based on these results.`
          });

          // Call LLM again to synthesize the result
          console.log(`[OpenClaw] Action completed, synthesizing final response...`);
          const followUp = await chain.chat(context.messages);
          context.response = followUp;

          // Attach what happened to metadata for the UI
          context.metadata.toolExecuted = tool;
        }
      } catch (err) {
        console.error('[OpenClaw] Failed to parse action block', err);
      }
    }

    await next();
  };
}
