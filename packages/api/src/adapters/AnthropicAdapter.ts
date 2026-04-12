import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMOptions, LLMCapabilities, Message } from '@jarvis/shared';

/**
 * Anthropic Claude adapter — JARVIS's primary brain.
 * Best-in-class reasoning and personality expression.
 */
export class AnthropicAdapter implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = 'claude-sonnet-4-20250514') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    const { systemPrompt, turns } = this.splitMessages(messages);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      system: systemPrompt,
      messages: turns,
      ...(options?.stopSequences ? { stop_sequences: options.stopSequences } : {}),
    });

    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
  }

  async *stream(messages: Message[], options?: LLMOptions): AsyncGenerator<string> {
    const { systemPrompt, turns } = this.splitMessages(messages);

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      system: systemPrompt,
      messages: turns,
      ...(options?.stopSequences ? { stop_sequences: options.stopSequences } : {}),
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text;
      }
    }
  }

  getCapabilities(): LLMCapabilities {
    return {
      supportsTools: true,
      supportsStreaming: true,
      contextWindow: 200_000,
      providerId: 'anthropic',
      modelId: this.model,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Anthropic requires the system prompt to be separate from the turns.
   * This splits our unified Message[] into the two parts.
   */
  private splitMessages(messages: Message[]): {
    systemPrompt: string;
    turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    let systemPrompt = '';
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        turns.push({ role: msg.role, content: msg.content });
      }
    }

    return { systemPrompt, turns };
  }
}
