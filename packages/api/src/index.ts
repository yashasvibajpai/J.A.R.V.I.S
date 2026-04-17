import express from 'express';
import cors from 'cors';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import type { Request, Response } from 'express';
import type { Message } from '@jarvis/shared';

import { AnthropicAdapter } from './adapters/AnthropicAdapter.js';
import { OpenAIAdapter } from './adapters/OpenAIAdapter.js';
import { OllamaAdapter } from './adapters/OllamaAdapter.js';
import { FailoverChain } from './engine/failover.js';
import { loadCartridge, buildSystemPrompt } from './engine/personality.js';
import {
  Pipeline,
  systemPromptMiddleware,
  llmCallMiddleware,
} from './engine/pipeline.js';
import { memoryRecallMiddleware, memoryExtractionMiddleware } from './engine/memory-middleware.js';
import { profileInjectionMiddleware, profileExtractionMiddleware } from './engine/profile-middleware.js';
import { taskRecallMiddleware, taskExtractionMiddleware } from './engine/task-middleware.js';
import { calendarMiddleware } from './engine/calendar-middleware.js';
import { SQLiteMemoryStore } from './stores/SQLiteMemoryStore.js';
import { SQLiteProfileStore } from './stores/SQLiteProfileStore.js';
import { SQLiteTaskStore } from './stores/SQLiteTaskStore.js';
import { SQLiteReminderStore } from './stores/SQLiteReminderStore.js';
import { SQLiteCaptureStore } from './stores/SQLiteCaptureStore.js';
import { observabilityMiddleware } from './engine/observability.js';

// ─── Config ──────────────────────────────────────────────────────────────────

import 'dotenv/config';

const PORT = parseInt(process.env.PORT || '3001', 10);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Data Directory ─────────────────────────────────────────────────────────

const DATA_DIR = resolve(__dirname, '../../data');
mkdirSync(DATA_DIR, { recursive: true });

// ─── Build the LLM Provider Chain ───────────────────────────────────────────

function buildProviderChain(): FailoverChain {
  const providers = [];

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push(new AnthropicAdapter(process.env.ANTHROPIC_API_KEY));
    console.log('[init] ✓ Anthropic Claude adapter loaded');
  }

  if (process.env.OPENAI_API_KEY) {
    providers.push(new OpenAIAdapter(process.env.OPENAI_API_KEY));
    console.log('[init] ✓ OpenAI GPT-4o adapter loaded');
  }

  // Ollama is always available as a fallback (no API key needed)
  providers.push(
    new OllamaAdapter(
      process.env.OLLAMA_HOST || 'http://localhost:11434',
      process.env.OLLAMA_MODEL || 'gemma3:4b'
    )
  );
  console.log('[init] ✓ Ollama adapter loaded (local fallback)');

  if (providers.length === 0) {
    throw new Error(
      'No LLM providers configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your .env'
    );
  }

  return new FailoverChain(providers);
}

// ─── Boot ────────────────────────────────────────────────────────────────────

const chain = buildProviderChain();

// Load personality
const cartridgePath = process.env.CARTRIDGE_PATH || undefined;
const cartridge = loadCartridge(cartridgePath);
const systemPrompt = buildSystemPrompt(cartridge);
console.log(`[init] ✓ Personality loaded: ${cartridge.identity.name} (${cartridge.identity.fullName})`);

// Initialise stores
const memoryStore = new SQLiteMemoryStore(resolve(DATA_DIR, 'memories.db'));
console.log('[init] ✓ Memory store initialised (SQLite)');

const profileStore = new SQLiteProfileStore(resolve(DATA_DIR, 'profiles.db'));
// Ensure a default profile exists
await profileStore.initProfile('default', 'User');
console.log('[init] ✓ Profile store initialised (SQLite)');

const taskStore = new SQLiteTaskStore(resolve(DATA_DIR, 'tasks.db'));
const reminderStore = new SQLiteReminderStore(resolve(DATA_DIR, 'reminders.db'));
const captureStore = new SQLiteCaptureStore(resolve(DATA_DIR, 'captures.db'));
console.log('[init] ✓ Task, Reminder & Capture stores initialised (SQLite)');

// Build the message pipeline
// Order: observe → system prompt → calendar → profile → memory → taskRecall → LLM → memoryExtract → taskExtract → profileUpdate
const pipeline = new Pipeline()
  .use(observabilityMiddleware())
  .use(systemPromptMiddleware(systemPrompt))
  .use(calendarMiddleware(profileStore))
  .use(profileInjectionMiddleware(profileStore))
  .use(memoryRecallMiddleware(memoryStore))
  .use(taskRecallMiddleware(taskStore, reminderStore))
  .use(llmCallMiddleware(chain))
  .use(memoryExtractionMiddleware(memoryStore, chain))
  .use(taskExtractionMiddleware(taskStore, reminderStore, captureStore, chain))
  .use(profileExtractionMiddleware(profileStore, chain));

console.log('[init] ✓ Pipeline assembled: observe → systemPrompt → calendar → profile → memory → taskRecall → llmCall... etc');

// ─── Express Server ──────────────────────────────────────────────────────────

const app: express.Express = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', async (_req: Request, res: Response) => {
  const memoryCount = await memoryStore.count();
  const profile = await profileStore.getProfile('default');
  res.json({
    status: 'ok',
    identity: cartridge.identity.name,
    providers: chain.getCapabilities(),
    memory: { count: memoryCount },
    profile: { version: profile?.version ?? 0 },
  });
});

// Provider health check
app.get('/health/providers', async (_req: Request, res: Response) => {
  const health = await chain.healthCheck();
  res.json({ providers: health });
});

// Chat endpoint
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { message, history } = req.body as {
      message: string;
      history?: Message[];
    };

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required and must be a string' });
      return;
    }

    console.log(`\n[chat] user: "${message.substring(0, 80)}${message.length > 80 ? '...' : ''}"`);

    const result = await pipeline.run(message, history ?? []);

    console.log(`[chat] jarvis: "${(result.response ?? '').substring(0, 80)}..."`);
    if (result.metadata.memoriesRecalled) {
      console.log(`[chat] recalled ${result.metadata.memoriesRecalled} memories`);
    }
    if (result.metadata.memoriesExtracted) {
      console.log(`[chat] extracted ${result.metadata.memoriesExtracted} new memories`);
    }
    if (result.metadata.profileUpdated) {
      console.log(`[chat] profile updated`);
    }

    res.json({
      response: result.response,
      metadata: {
        provider: chain.getCapabilities().providerId,
        model: chain.getCapabilities().modelId,
        memoriesRecalled: result.metadata.memoriesRecalled ?? 0,
        memoriesExtracted: result.metadata.memoriesExtracted ?? 0,
        tasksExtracted: result.metadata.tasksExtracted ?? 0,
        profileUpdated: result.metadata.profileUpdated ?? false,
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[chat] error: ${errorMessage}`);
    res.status(500).json({ error: errorMessage });
  }
});

// Streaming chat endpoint
app.post('/api/chat/stream', async (req: Request, res: Response) => {
  try {
    const { message, history } = req.body as {
      message: string;
      history?: Message[];
    };

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required and must be a string' });
      return;
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Build messages with system prompt + profile + memory recall
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...(history ?? []),
      { role: 'user', content: message },
    ];

    const stream = chain.stream(messages);

    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[stream] error: ${errorMessage}`);
    res.status(500).json({ error: errorMessage });
  }
});

// ─── Memory & Profile Inspection Endpoints ──────────────────────────────────

app.get('/api/memories', async (_req: Request, res: Response) => {
  const memories = await memoryStore.getAll();
  res.json({ memories, count: memories.length });
});

app.get('/api/memories/search', async (req: Request, res: Response) => {
  const query = (req.query.q as string) ?? '';
  if (!query) {
    res.status(400).json({ error: 'q query parameter is required' });
    return;
  }
  const memories = await memoryStore.search(query);
  res.json({ memories, count: memories.length });
});

app.delete('/api/memories/:id', async (req: Request, res: Response) => {
  await memoryStore.delete(req.params.id as string);
  res.json({ deleted: true });
});

app.get('/api/profile', async (_req: Request, res: Response) => {
  const profile = await profileStore.getProfile('default');
  res.json({ profile });
});

app.get('/api/profile/history', async (_req: Request, res: Response) => {
  const history = await profileStore.getProfileHistory('default');
  res.json({ history });
});

app.get('/api/tasks', async (_req: Request, res: Response) => {
  const tasks = await taskStore.queryTasks();
  res.json({ tasks, count: tasks.length });
});

app.get('/api/reminders', async (_req: Request, res: Response) => {
  const reminders = await reminderStore.getPendingReminders();
  res.json({ reminders, count: reminders.length });
});

app.get('/api/captures', async (_req: Request, res: Response) => {
  const captures = await captureStore.getUnprocessedCaptures();
  res.json({ captures, count: captures.length });
});

// ─── OAuth Endpoints ─────────────────────────────────────────────────────────

app.get('/api/auth/google', async (req: Request, res: Response) => {
  try {
    const { google } = await import('googleapis');
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
       res.status(500).json({ error: 'OAuth credentials not set in .env' });
       return;
    }
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:3001/api/auth/google/callback'
    );
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar.readonly'],
      prompt: 'consent' // Forces refresh token generation
    });
    // Send user to Google Auth screen
    res.redirect(authUrl);
  } catch(e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  try {
    const { google } = await import('googleapis');
    const code = req.query.code as string;
    const error = req.query.error as string;
    
    if (error) {
       res.status(400).json({ error: `Google OAuth error: ${error}`, details: req.query });
       return;
    }
    
    if (!code) {
       res.status(400).json({ error: 'No code found in request.', queryReceived: req.query });
       return;
    }
    
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:3001/api/auth/google/callback'
    );

    const { tokens } = await oauth2Client.getToken(code);
    
    if (tokens.refresh_token) {
       // Save to profile 
       await profileStore.updateProfile('default', {
          preferences: { google_refresh_token: tokens.refresh_token }
       });
       res.send('<h2>Authentication Successful!</h2><p>JARVIS now has Calendar access. You may close this tab.</p>');
    } else {
       res.send('<h2>Authentication Failed</h2><p>No refresh token granted. Please ensure "prompt: consent" was applied and try again.</p>');
    }
  } catch (err: any) {
     res.status(500).send(`Error: ${err.message}`);
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n─────────────────────────────────────────────────`);
  console.log(`  ${cartridge.identity.name} API is online`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`─────────────────────────────────────────────────`);
  console.log(`  POST /api/chat           — conversation`);
  console.log(`  POST /api/chat/stream    — SSE streaming`);
  console.log(`  GET  /api/memories       — all memories`);
  console.log(`  GET  /api/memories/search — search memories`);
  console.log(`  GET  /api/profile        — user profile`);
  console.log(`  GET  /api/profile/history — profile versions`);
  console.log(`  GET  /health             — health check`);
  console.log(`─────────────────────────────────────────────────\n`);
});

export default app;
