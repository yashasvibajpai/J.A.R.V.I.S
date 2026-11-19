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
  private embedModel?: string;

  constructor(opts: {
    apiKey: string;
    baseURL: string;
    model: string;
    providerId: string;
    contextWindow?: number;
    supportsTools?: boolean;
    extraHeaders?: Record<string, string>;
    embedModel?: string;
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
    if (opts.embedModel) {
      this.embedModel = opts.embedModel;
      this.embed = this._embed.bind(this);
    }
  }

  embed?: (text: string) => Promise<number[]>;

  private async _embed(text: string): Promise<number[]> {
    if (!this.embedModel) {
      throw new Error(`Embedding model not configured for provider ${this.providerId}`);
    }
    const response = await this.client.embeddings.create({
      model: this.embedModel,
      input: text,
    });
    return response.data[0].embedding;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    const defaultMaxTokens = options?.reasoningEffort ? 8192 : 4096;
    const params: any = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      } as ChatCompletionMessageParam)),
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
      // Gracefully retry without reasoning_effort if provider/model rejects the parameter
      if (
        options?.reasoningEffort &&
        (err?.message?.includes('reasoning_effort') || err?.message?.includes('unknown parameter') || err?.status === 400)
      ) {
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
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      } as ChatCompletionMessageParam)),
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
      if (
        options?.reasoningEffort &&
        (err?.message?.includes('reasoning_effort') || err?.message?.includes('unknown parameter') || err?.status === 400)
      ) {
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
