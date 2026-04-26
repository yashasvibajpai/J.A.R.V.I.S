import type { ProviderProfile, ProviderState } from './SmartRouter.js';

import { AnthropicAdapter } from '../adapters/AnthropicAdapter.js';
import { OpenAIAdapter } from '../adapters/OpenAIAdapter.js';
import { OllamaAdapter } from '../adapters/OllamaAdapter.js';
import { OllamaCloudAdapter } from '../adapters/OllamaCloudAdapter.js';
import { OpenAICompatibleAdapter } from '../adapters/OpenAICompatibleAdapter.js';

// ─── Default Provider State ──────────────────────────────────────────────────

function freshState(): ProviderState {
  const now = Date.now();
  return {
    requestsThisMinute: 0,
    requestsToday: 0,
    tokensToday: 0,
    cooldownUntil: null,
    consecutiveFailures: 0,
    lastUsed: null,
    minuteWindowStart: now,
    dayWindowStart: now,
  };
}

// ─── Provider Registry Builder ───────────────────────────────────────────────

/**
 * Auto-discovers configured LLM providers from environment variables
 * and returns a fully scored ProviderProfile[] for the SmartRouter.
 *
 * Providers are registered in recommended priority order per tier.
 * The SmartRouter's ranking algorithm handles the actual selection
 * based on task type, scores, and rate limit budget.
 */
export function buildProviderRegistry(): ProviderProfile[] {
  const profiles: ProviderProfile[] = [];

  // ─── Free-Tier Cloud Providers ──────────────────────────────────────────

  // Google AI Studio — Gemini 2.5 Flash
  if (process.env.GOOGLE_AI_API_KEY) {
    profiles.push({
      provider: new OpenAICompatibleAdapter({
        apiKey: process.env.GOOGLE_AI_API_KEY,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-2.5-flash',
        providerId: 'google',
        contextWindow: 1_000_000,
        supportsTools: true,
      }),
      providerId: 'google',
      modelId: 'gemini-2.5-flash',
      scores: { general: 8, coding: 7, reasoning: 8, creative: 7, quick: 7, tool_use: 7, embedding: 0 },
      limits: { rpm: 10, rpd: 1500, tokensPerDay: 1_000_000 },
      state: freshState(),
      tier: 'free',
      contextWindow: 1_000_000,
    });
    console.log('[registry] ✓ Google AI Studio (Gemini 2.5 Flash) registered — free tier');
  }

  // Groq — Llama 4 Scout (ultra-low latency)
  if (process.env.GROQ_API_KEY) {
    profiles.push({
      provider: new OpenAICompatibleAdapter({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1',
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        providerId: 'groq',
        contextWindow: 131_072,
        supportsTools: true,
      }),
      providerId: 'groq',
      modelId: 'llama-4-scout',
      scores: { general: 7, coding: 6, reasoning: 7, creative: 6, quick: 10, tool_use: 6, embedding: 0 },
      limits: { rpm: 30, rpd: 14400, tokensPerDay: 500_000 },
      state: freshState(),
      tier: 'free',
      contextWindow: 131_072,
    });
    console.log('[registry] ✓ Groq (Llama 4 Scout) registered — free tier');
  }

  // Cerebras — Llama 3.3 70B (high throughput)
  if (process.env.CEREBRAS_API_KEY) {
    profiles.push({
      provider: new OpenAICompatibleAdapter({
        apiKey: process.env.CEREBRAS_API_KEY,
        baseURL: 'https://api.cerebras.ai/v1',
        model: 'llama-3.3-70b',
        providerId: 'cerebras',
        contextWindow: 128_000,
        supportsTools: false,
      }),
      providerId: 'cerebras',
      modelId: 'llama-3.3-70b',
      scores: { general: 7, coding: 7, reasoning: 6, creative: 6, quick: 9, tool_use: 6, embedding: 0 },
      limits: { rpm: 30, rpd: 1000, tokensPerDay: 1_000_000 },
      state: freshState(),
      tier: 'free',
      contextWindow: 128_000,
    });
    console.log('[registry] ✓ Cerebras (Llama 3.3 70B) registered — free tier');
  }

  // Mistral — Codestral (coding specialist)
  if (process.env.MISTRAL_API_KEY) {
    profiles.push({
      provider: new OpenAICompatibleAdapter({
        apiKey: process.env.MISTRAL_API_KEY,
        baseURL: 'https://api.mistral.ai/v1',
        model: 'codestral-latest',
        providerId: 'mistral-code',
        contextWindow: 256_000,
        supportsTools: false,
      }),
      providerId: 'mistral-code',
      modelId: 'codestral-latest',
      scores: { general: 5, coding: 10, reasoning: 5, creative: 4, quick: 6, tool_use: 5, embedding: 0 },
      limits: { rpm: 2, rpd: 500, tokensPerDay: 500_000_000 }, // 1B tokens/month ≈ ~33M/day
      state: freshState(),
      tier: 'free',
      contextWindow: 256_000,
    });
    console.log('[registry] ✓ Mistral (Codestral) registered — free tier');

    // Also register Mistral Large for general/reasoning tasks
    profiles.push({
      provider: new OpenAICompatibleAdapter({
        apiKey: process.env.MISTRAL_API_KEY,
        baseURL: 'https://api.mistral.ai/v1',
        model: 'mistral-large-latest',
        providerId: 'mistral-large',
        contextWindow: 128_000,
        supportsTools: true,
      }),
      providerId: 'mistral-large',
      modelId: 'mistral-large-latest',
      scores: { general: 8, coding: 7, reasoning: 8, creative: 8, quick: 4, tool_use: 7, embedding: 0 },
      limits: { rpm: 2, rpd: 500, tokensPerDay: 500_000_000 },
      state: freshState(),
      tier: 'free',
      contextWindow: 128_000,
    });
    console.log('[registry] ✓ Mistral (Large) registered — free tier');
  }

  // OpenRouter — free model router
  if (process.env.OPENROUTER_API_KEY) {
    profiles.push({
      provider: new OpenAICompatibleAdapter({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'openrouter/auto',
        providerId: 'openrouter',
        contextWindow: 128_000,
        supportsTools: false,
        extraHeaders: {
          'HTTP-Referer': 'https://github.com/jarvis-assistant',
          'X-Title': 'JARVIS',
        },
      }),
      providerId: 'openrouter',
      modelId: 'auto',
      scores: { general: 6, coding: 5, reasoning: 6, creative: 6, quick: 5, tool_use: 5, embedding: 0 },
      limits: { rpm: 20, rpd: 50, tokensPerDay: 500_000 }, // conservative for free tier
      state: freshState(),
      tier: 'free',
      contextWindow: 128_000,
    });
    console.log('[registry] ✓ OpenRouter (auto) registered — free tier');
  }

  // Ollama Cloud — large models on remote infrastructure
  if (process.env.OLLAMA_CLOUD_API_KEY) {
    profiles.push({
      provider: new OllamaCloudAdapter(
        process.env.OLLAMA_CLOUD_API_KEY,
        process.env.OLLAMA_CLOUD_MODEL || 'qwen3:32b-cloud'
      ),
      providerId: 'ollama-cloud',
      modelId: process.env.OLLAMA_CLOUD_MODEL || 'qwen3:32b-cloud',
      scores: { general: 7, coding: 7, reasoning: 7, creative: 6, quick: 6, tool_use: 5, embedding: 0 },
      limits: { rpm: 10, rpd: 500, tokensPerDay: 500_000 },
      state: freshState(),
      tier: 'free',
      contextWindow: 128_000,
    });
    console.log('[registry] ✓ Ollama Cloud registered — free tier');
  }

  // ─── Local Providers (unlimited, always-on) ─────────────────────────────

  // Ollama Local — runs on your hardware, no limits
  profiles.push({
    provider: new OllamaAdapter(
      process.env.OLLAMA_HOST || 'http://localhost:11434',
      process.env.OLLAMA_MODEL || 'gemma4:e2B'
    ),
    providerId: 'ollama-local',
    modelId: process.env.OLLAMA_MODEL || 'gemma4:e2B',
    scores: { general: 6, coding: 5, reasoning: 5, creative: 5, quick: 6, tool_use: 5, embedding: 5 },
    limits: { rpm: 999, rpd: 999999, tokensPerDay: 999_999_999 }, // effectively unlimited
    state: freshState(),
    tier: 'local',
    contextWindow: 8192,
  });
  console.log('[registry] ✓ Ollama Local registered — unlimited');

  // ─── Paid Providers (fallback when all free exhausted) ──────────────────

  if (process.env.ANTHROPIC_API_KEY) {
    profiles.push({
      provider: new AnthropicAdapter(process.env.ANTHROPIC_API_KEY),
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      scores: { general: 10, coding: 9, reasoning: 10, creative: 10, quick: 7, tool_use: 10, embedding: 0 },
      limits: { rpm: 50, rpd: 100000, tokensPerDay: 999_999_999 }, // pay-per-use, effectively unlimited
      state: freshState(),
      tier: 'paid',
      contextWindow: 200_000,
    });
    console.log('[registry] ✓ Anthropic Claude registered — paid fallback');
  }

  if (process.env.OPENAI_API_KEY) {
    profiles.push({
      provider: new OpenAIAdapter(process.env.OPENAI_API_KEY),
      providerId: 'openai',
      modelId: 'gpt-4o',
      scores: { general: 9, coding: 9, reasoning: 9, creative: 9, quick: 8, tool_use: 9, embedding: 8 },
      limits: { rpm: 60, rpd: 100000, tokensPerDay: 999_999_999 },
      state: freshState(),
      tier: 'paid',
      contextWindow: 128_000,
    });
    console.log('[registry] ✓ OpenAI GPT-4o registered — paid fallback');
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  const freeTierCount = profiles.filter(p => p.tier === 'free').length;
  const localCount = profiles.filter(p => p.tier === 'local').length;
  const paidCount = profiles.filter(p => p.tier === 'paid').length;
  console.log(`[registry] Total: ${profiles.length} providers (${freeTierCount} free, ${localCount} local, ${paidCount} paid)`);

  return profiles;
}
