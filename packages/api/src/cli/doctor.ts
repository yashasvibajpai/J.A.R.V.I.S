#!/usr/bin/env npx tsx

/**
 * jarvis doctor — health check CLI
 *
 * Validates configuration, checks adapter availability,
 * tests connectivity, and reports system readiness.
 *
 * Usage:
 *   npx tsx src/cli/doctor.ts
 *   # or via package.json script:
 *   pnpm doctor
 */

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import 'dotenv/config';
import { contextualInsertionFunction } from '../engine/personalityGbrain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Utilities ──────────────────────────────────────────────────────────────

function pass(msg: string) { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }

// ─── Checks ─────────────────────────────────────────────────────────────────

async function checkEnvFile(): Promise<boolean> {
  const envPath = resolve(__dirname, '../../.env');
  if (existsSync(envPath)) {
    pass('.env file found');
    return true;
  }
  fail('.env file missing — copy .env.example to .env');
  return false;
}

async function checkLLMProviders(): Promise<boolean> {
  let anyAvailable = false;

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (res.ok || res.status === 400) {
        pass('Anthropic API key valid');
        anyAvailable = true;
      } else if (res.status === 401) {
        fail('Anthropic API key invalid (401)');
      } else {
        warn(`Anthropic API responded with ${res.status}`);
        anyAvailable = true;
      }
    } catch {
      fail('Anthropic API unreachable');
    }
  } else {
    info('ANTHROPIC_API_KEY not set (optional)');
  }

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });
      if (res.ok) {
        pass('OpenAI API key valid');
        anyAvailable = true;
      } else if (res.status === 401) {
        fail('OpenAI API key invalid (401)');
      } else {
        warn(`OpenAI API responded with ${res.status}`);
      }
    } catch {
      fail('OpenAI API unreachable');
    }
  } else {
    info('OPENAI_API_KEY not set (optional)');
  }

  // Ollama
  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  try {
    const res = await fetch(`${ollamaHost}/api/tags`);
    if (res.ok) {
      const data = await res.json() as { models?: Array<{ name: string }> };
      const models = data.models || [];
      pass(`Ollama running (${models.length} models available)`);
      const targetModel = process.env.OLLAMA_MODEL || 'gemma3:4b';
      if (models.some((m: { name: string }) => m.name.startsWith(targetModel.split(':')[0]))) {
        pass(`Target model ${targetModel} found`);
      } else {
        warn(`Target model ${targetModel} not found — run: ollama pull ${targetModel}`);
      }
      anyAvailable = true;
    }
  } catch {
    warn(`Ollama not running at ${ollamaHost}`);
  }

  if (!anyAvailable) {
    fail('No LLM provider available — configure at least one');
    return false;
  }

  return true;
}

async function checkPersonality(): Promise<boolean> {
  const cartridgePath = resolve(__dirname, '../../node_modules/@jarvis/config/jarvis-personality.yaml');
  const altPath = resolve(__dirname, '../../../config/jarvis-personality.yaml');

  if (existsSync(cartridgePath) || existsSync(altPath)) {
    pass('Personality cartridge found');
    return true;
  }
  fail('Personality cartridge not found');
  return false;
}

function getDataDir(): string {
  const primary = resolve(__dirname, '../../../data');
  if (existsSync(primary)) return primary;
  return resolve(__dirname, '../../data');
}

async function checkDataDir(): Promise<boolean> {
  const dataDir = getDataDir();
  if (existsSync(dataDir)) {
    pass('Data directory exists');
    return true;
  }
  info('Data directory will be created on first run');
  return true;
}

async function checkNodeVersion(): Promise<boolean> {
  const version = process.version;
  const major = parseInt(version.slice(1));
  if (major >= 20) {
    pass(`Node.js ${version}`);
    return true;
  }
  fail(`Node.js ${version} — requires v20+`);
  return false;
}

async function gbrainDoctor(): Promise<boolean> {
  if (process.env.GBRAIN_ENABLED !== 'true') {
    info('GBrain integration disabled (GBRAIN_ENABLED != true)');
    return true;
  }
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) {
    warn('Data directory does not exist. Reverting to embeddings');
    return false;
  }
  pass('GBrain integration active');
  contextualInsertionFunction(dataDir);
  return true;
}

// ─── Run ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║        J.A.R.V.I.S — System Diagnostics         ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  console.log('▸ Environment');
  const nodeOk = await checkNodeVersion();
  const envOk = await checkEnvFile();

  console.log('\n▸ LLM Providers');
  const llmOk = await checkLLMProviders();

  console.log('\n▸ Configuration');
  const personalityOk = await checkPersonality();
  const dataOk = await checkDataDir();
  const gbrainOk = await gbrainDoctor();

  console.log('\n──────────────────────────────────────────────────');

  const allOk = nodeOk && envOk && llmOk && personalityOk && dataOk && gbrainOk;

  if (allOk) {
    console.log('  🟢 JARVIS is ready.\n');
  } else {
    console.log('  🟡 JARVIS has warnings — review above.\n');
  }

  process.exit(allOk ? 0 : 1);
}

main().catch(console.error);
