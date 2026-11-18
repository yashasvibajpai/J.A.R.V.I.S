import { spawn } from 'child_process';
import type { Middleware } from './pipeline.js';

export function gbrainExtractionMiddleware(): Middleware {
  return async (ctx, next) => {
    // Wait for LLM response
    await next();

    if (process.env.GBRAIN_ENABLED !== 'true') {
      return;
    }

    if (!ctx.response || ctx.userMessage.trim().length < 5) {
      return;
    }

    try {
      const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      const content = `---
type: note
tags: [jarvis-interaction, chat]
date: "${timestamp}"
---
# JARVIS Chat Interaction - ${timestamp}

**User**:
${ctx.userMessage}

**Assistant**:
${ctx.response}
`;

      console.log('[gbrain] Capturing interaction to GBrain...');
      await runGBrainCapture(content);
      ctx.metadata.gbrainCaptured = true;
      console.log('[gbrain] ✓ Interaction captured successfully');
    } catch (err) {
      console.warn(`[gbrain] Failed to capture interaction: ${err}`);
    }
  };
}

function runGBrainCapture(content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('gbrain', ['capture', '--stdin']);
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`gbrain capture exited with code ${code}. Stderr: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });

    // Write the document into stdin
    child.stdin.write(content);
    child.stdin.end();
  });
}
