import { Ollama } from 'ollama';
import type { LLMProvider, LLMOptions, LLMCapabilities, Message } from '@jarvis/shared';

/**
 * Ollama adapter — JARVIS's local/privacy fallback.
 * Runs Gemma, Llama, or any Ollama-compatible model on your own hardware.
 * Zero cost, zero data leaving your machine.
 */
export class OllamaAdapter implements LLMProvider {
  private client: Ollama;
  private model: string;

  constructor(host = 'http://localhost:11434', model = 'gemma3:4b') {
    this.client = new Ollama({ host });
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

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embed({
      model: this.model,
      input: text,
    });
    return response.embeddings[0] ?? [];
  }

  getCapabilities(): LLMCapabilities {
    return {
      supportsTools: false, // depends on model, conservative default
      supportsStreaming: true,
      contextWindow: 8192, // varies by model — Gemma 3 27B supports 128k but we default conservatively
      providerId: 'ollama',
      modelId: this.model,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const models = await this.client.list();
      return models.models.some((m) => m.name.startsWith(this.model.split(':')[0]));
    } catch {
      return false;
    }
  }
}
