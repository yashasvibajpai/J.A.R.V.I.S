import { spawn } from 'child_process';
import type { Middleware } from './pipeline.js';

const REALTIME_NEWS_INDICATORS = [
  'latest', 'news', 'today', 'current', 'update', 'breaking',
  'recent', 'happening', 'who is', 'weather', 'stock', 'price',
  'outages', 'outage', 'downtime', 'last 7 days', 'last week', 'yesterday',
  'incident', 'breach', 'blackout',
];

const PERSONAL_NOTE_INDICATORS = [
  'my', 'our', 'mine', 'note', 'notes', 'vault', 'obsidian',
  'project', 'projects', 'resume', 'cv', 'profile', 'draft', 'drafts',
  'writeup', 'personal', 'private', 'meeting', 'discussion with', 'we',
];

export function gbrainMiddleware(): Middleware {
  return async (ctx, next) => {
    if (process.env.GBRAIN_ENABLED !== 'true') {
      return await next();
    }

    // Skip if query is too short
    if (!ctx.userMessage || ctx.userMessage.trim().length <= 10) {
      return await next();
    }

    const lower = ctx.userMessage.toLowerCase();
    const isRealTime = REALTIME_NEWS_INDICATORS.some((k) => lower.includes(k));
    const isPersonal = PERSONAL_NOTE_INDICATORS.some((k) => lower.includes(k));

    // Shield real-time external queries from stale historical context
    if (isRealTime && !isPersonal) {
      console.log(`[gbrain] Real-time external query detected without personal indicators. Skipping GBrain historical synthesis.`);
      return await next();
    }

    try {
      console.log(`[gbrain] Querying GBrain for query: "${ctx.userMessage}"`);
      const output = await runGBrainThink(ctx.userMessage);
      
      if (output && output.trim()) {
        const contextBlock = `## Historical Interaction Context (GBrain)\n` +
          `The following context was synthesized by GBrain from past interactions and workspace history. ` +
          `Use it as background reference for personal projects and past discussions.\n\n` +
          `${output.trim()}\n`;

        // Append to system prompt
        const sysIndex = ctx.messages.findIndex((m) => m.role === 'system');
        if (sysIndex >= 0) {
          ctx.messages[sysIndex].content += `\n\n${contextBlock}`;
        } else {
          ctx.messages.unshift({ role: 'system', content: contextBlock });
        }
        ctx.metadata.gbrainThinkRun = true;
        console.log('[gbrain] ✓ Context successfully injected into system prompt');
      } else {
        console.log('[gbrain] Query returned empty output');
      }
    } catch (err) {
      console.warn(`[gbrain] Query failed: ${err}`);
    }

    await next();
  };
}

function runGBrainThink(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gbrain', ['think', query]);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error('gbrain think timed out after 8000ms'));
    }, 8000);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`gbrain think exited with code ${code}. Stderr: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
