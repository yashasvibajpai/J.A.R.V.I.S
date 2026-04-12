import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.mjs';
import type { LLMProvider, LLMOptions, LLMCapabilities, Message } from '@jarvis/shared';

/**
 * OpenAI GPT adapter — JARVIS's cloud fallback.
 * Kicks in when Anthropic is unavailable.
 */
export class OpenAIAdapter implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = 'gpt-4o') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content } as ChatCompletionMessageParam)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.stopSequences ? { stop: options.stopSequences } : {}),
    });

    return response.choices[0]?.message?.content ?? '';
  }

  async *stream(messages: Message[], options?: LLMOptions): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content } as ChatCompletionMessageParam)),
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

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return response.data[0]?.embedding ?? [];
  }

  getCapabilities(): LLMCapabilities {
    return {
      supportsTools: true,
      supportsStreaming: true,
      contextWindow: 128_000,
      providerId: 'openai',
      modelId: this.model,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
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
