import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.mjs';
import type { LLMProvider, LLMOptions, LLMCapabilities, Message } from '@jarvis/shared';

/**
 * Generic OpenAI-compatible adapter.
 *
 * Works with any provider that exposes the OpenAI chat completions API:
 *   - Google AI Studio (Gemini)
 *   - Groq
 *   - Cerebras
 *   - Mistral
 *   - OpenRouter
 *
 * Just swap the baseURL and API key — the SDK handles the rest.
 */
export class OpenAICompatibleAdapter implements LLMProvider {
  private client: OpenAI;
  private model: string;
  private providerId: string;
  private _contextWindow: number;
  private _supportsTools: boolean;
  private extraHeaders: Record<string, string>;

  constructor(opts: {
    apiKey: string;
    baseURL: string;
    model: string;
    providerId: string;
    contextWindow?: number;
    supportsTools?: boolean;
    extraHeaders?: Record<string, string>;
  }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      defaultHeaders: opts.extraHeaders,
    });
    this.model = opts.model;
    this.providerId = opts.providerId;
    this._contextWindow = opts.contextWindow ?? 32_768;
    this._supportsTools = opts.supportsTools ?? false;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      } as ChatCompletionMessageParam)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.stopSequences ? { stop: options.stopSequences } : {}),
    });

    return response.choices[0]?.message?.content ?? '';
  }

  async *stream(messages: Message[], options?: LLMOptions): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      } as ChatCompletionMessageParam)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
      ...(options?.stopSequences ? { stop: options.stopSequences } : {}),
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  getCapabilities(): LLMCapabilities {
    return {
      supportsTools: this._supportsTools,
      supportsStreaming: true,
      contextWindow: this._contextWindow,
      providerId: this.providerId,
      modelId: this.model,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Lightweight probe — request minimal output
      await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' } as ChatCompletionMessageParam],
      });
      return true;
    } catch {
      return false;
    }
  }
}
