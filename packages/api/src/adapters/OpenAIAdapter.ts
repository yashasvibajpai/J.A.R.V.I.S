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
    const defaultMaxTokens = options?.reasoningEffort ? 8192 : 4096;
    const params: any = {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content } as ChatCompletionMessageParam)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? defaultMaxTokens,
      ...(options?.stopSequences ? { stop: options.stopSequences } : {}),
      ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    };

    try {
      const response = await this.client.chat.completions.create(params);
      const choice = response.choices?.[0];
      const content = choice?.message?.content;
      const reasoning = (choice?.message as any)?.reasoning || (choice?.message as any)?.reasoning_content;
      if (content && content.trim()) {
        return content;
      } else if (reasoning && reasoning.trim()) {
        return `<think>\n${reasoning}\n</think>\n`;
      }
      return content ?? '';
    } catch (err: any) {
      if (options?.reasoningEffort && (err?.message?.includes('reasoning_effort') || err?.status === 400)) {
        delete params.reasoning_effort;
        const retryResponse = await this.client.chat.completions.create(params);
        const choice = retryResponse.choices?.[0];
        const content = choice?.message?.content;
        const reasoning = (choice?.message as any)?.reasoning || (choice?.message as any)?.reasoning_content;
        if (content && content.trim()) {
          return content;
        } else if (reasoning && reasoning.trim()) {
          return `<think>\n${reasoning}\n</think>\n`;
        }
        return content ?? '';
      }
      throw err;
    }
  }

  async *stream(messages: Message[], options?: LLMOptions): AsyncGenerator<string> {
    const defaultMaxTokens = options?.reasoningEffort ? 8192 : 4096;
    const params: any = {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content } as ChatCompletionMessageParam)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? defaultMaxTokens,
      stream: true,
      ...(options?.stopSequences ? { stop: options.stopSequences } : {}),
      ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    };

    let stream: any;
    try {
      stream = await this.client.chat.completions.create(params);
    } catch (err: any) {
      if (options?.reasoningEffort && (err?.message?.includes('reasoning_effort') || err?.status === 400)) {
        delete params.reasoning_effort;
        stream = await this.client.chat.completions.create(params);
      } else {
        throw err;
      }
    }

    let inReasoning = false;
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const reasoning = choice?.delta?.reasoning || (choice?.delta as any)?.reasoning_content;
      const content = choice?.delta?.content;

      if (reasoning) {
        if (!inReasoning) {
          inReasoning = true;
          yield '<think>\n';
        }
        yield reasoning;
      }

      if (content) {
        if (inReasoning) {
          inReasoning = false;
          yield '\n</think>\n\n';
        }
        yield content;
      }
    }

    if (inReasoning) {
      yield '\n</think>\n\n';
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
