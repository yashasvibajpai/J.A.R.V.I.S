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
import { SQLiteMemoryStore } from './stores/SQLiteMemoryStore.js';
import { SQLiteProfileStore } from './stores/SQLiteProfileStore.js';
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

// Build the message pipeline
// Order: observe → system prompt → profile → memory → LLM → extract → profileUpdate
const pipeline = new Pipeline()
  .use(observabilityMiddleware())
  .use(systemPromptMiddleware(systemPrompt))
  .use(profileInjectionMiddleware(profileStore))
  .use(memoryRecallMiddleware(memoryStore))
  .use(llmCallMiddleware(chain))
  .use(memoryExtractionMiddleware(memoryStore, chain))
  .use(profileExtractionMiddleware(profileStore, chain));

console.log('[init] ✓ Pipeline assembled: observe → systemPrompt → profile → memory → llmCall → extract → profileUpdate');

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
