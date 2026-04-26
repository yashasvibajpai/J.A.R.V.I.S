import { v4 as uuidv4 } from 'uuid';
import type { PipelineMiddleware } from './pipeline.js';
import type { OpenClawBridge } from '../services/OpenClawBridge.js';
import type { LLMProvider } from '@jarvis/shared';

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
  chain: LLMProvider
): PipelineMiddleware {
  return async (context, next) => {
    // Only run if the bridge is enabled and we have a response
    if (process.env.OPENCLAW_ENABLED !== 'true' || !context.response) {
      return next();
    }

    const actionRegex = /```action\s*\n([\s\S]*?)\n```/;
    const match = context.response.match(actionRegex);

    if (match) {
      try {
        const actionPayload = JSON.parse(match[1]);
        const tool = actionPayload.tool;
        const params = actionPayload.params || {};
        
        const safetyTier = DESTRUCTIVE_TOOLS.includes(tool) ? 'destructive' : 'safe';
        const actionId = uuidv4();

        // Remove the action block from the visible response text
        context.response = context.response.replace(actionRegex, '').trim();

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
            role: 'system',
            content: `Tool Execution Result:\n${JSON.stringify(toolResult, null, 2)}\n\nNow provide a final response to the user based on these results.`
          });

          // Call LLM again to synthesize the result
          console.log(`[OpenClaw] Action completed, synthesizing final response...`);
          const followUp = await chain.invoke(context.messages, { taskHint: 'general' });
          context.response = followUp.response;
          
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
