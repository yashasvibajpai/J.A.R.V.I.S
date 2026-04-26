import { Ollama } from 'ollama';
import type { LLMProvider, LLMOptions, LLMCapabilities, Message } from '@jarvis/shared';

/**
 * Ollama Cloud adapter — access large models (e.g. Qwen3-Coder 480B)
 * hosted on Ollama's cloud infrastructure.
 *
 * Cloud models are identified by a `:cloud` suffix (e.g., `qwen3-coder:480b-cloud`).
 * Requires an API key from https://ollama.com/settings/keys.
 */
export class OllamaCloudAdapter implements LLMProvider {
  private client: Ollama;
  private model: string;

  constructor(apiKey: string, model = 'qwen3-coder:480b-cloud') {
    this.client = new Ollama({
      host: 'https://api.ollama.com',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      } as Record<string, string>,
    });
    this.model = model;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    const response = await this.client.chat({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.maxTokens ?? 4096,
        ...(options?.stopSequences ? { stop: options.stopSequences } : {}),
      },
    });

    return response.message.content;
  }

  async *stream(messages: Message[], options?: LLMOptions): AsyncGenerator<string> {
    const stream = await this.client.chat({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.maxTokens ?? 4096,
        ...(options?.stopSequences ? { stop: options.stopSequences } : {}),
      },
    });

    for await (const chunk of stream) {
      if (chunk.message.content) {
        yield chunk.message.content;
      }
    }
  }

  getCapabilities(): LLMCapabilities {
    return {
      supportsTools: false,
      supportsStreaming: true,
      contextWindow: 128_000,
      providerId: 'ollama-cloud',
      modelId: this.model,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Quick probe — list available cloud models
      await this.client.chat({
        model: this.model,
        messages: [{ role: 'user', content: 'ping' }],
        options: { num_predict: 1 },
      });
      return true;
    } catch {
      return false;
    }
  }
}
