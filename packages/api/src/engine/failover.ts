import type { LLMProvider, LLMOptions, LLMCapabilities, Message } from '@jarvis/shared';

/**
 * Failover Chain — wraps multiple LLM providers into one.
 *
 * Tries providers in priority order. If the primary fails,
 * falls through to the next. Implements LLMProvider itself
 * so the rest of the system doesn't know (or care) about failover.
 *
 * Chain: Claude → GPT-4o → Gemma (local)
 */
export class FailoverChain implements LLMProvider {
  private providers: LLMProvider[];

  constructor(providers: LLMProvider[]) {
    if (providers.length === 0) {
      throw new Error('FailoverChain requires at least one provider');
    }
    this.providers = providers;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<string> {
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      const caps = provider.getCapabilities();
      try {
        console.log(`[failover] trying ${caps.providerId}/${caps.modelId}...`);
        const result = await provider.chat(messages, options);
        console.log(`[failover] ✓ ${caps.providerId} responded`);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[failover] ✗ ${caps.providerId} failed: ${lastError.message}`);
      }
    }

    throw new Error(
      `All ${this.providers.length} providers failed. Last error: ${lastError?.message}`
    );
  }

  async *stream(messages: Message[], options?: LLMOptions): AsyncGenerator<string> {
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      const caps = provider.getCapabilities();
      try {
        console.log(`[failover] streaming via ${caps.providerId}/${caps.modelId}...`);
        const gen = provider.stream(messages, options);

        // We need to yield at least one chunk to confirm this provider works.
        // If the first next() throws, we fall through to the next provider.
        const first = await gen.next();
        if (!first.done && first.value) {
          yield first.value;
        }

        // First chunk succeeded — commit to this provider for the rest
        for await (const chunk of gen) {
          yield chunk;
        }

        console.log(`[failover] ✓ ${caps.providerId} stream complete`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[failover] ✗ ${caps.providerId} stream failed: ${lastError.message}`);
      }
    }

    throw new Error(
      `All ${this.providers.length} providers failed to stream. Last error: ${lastError?.message}`
    );
  }

  getCapabilities(): LLMCapabilities {
    // Report capabilities of the first (primary) provider
    return this.providers[0].getCapabilities();
  }

  async isAvailable(): Promise<boolean> {
    // Available if ANY provider is available
    for (const provider of this.providers) {
      if (await provider.isAvailable()) return true;
    }
    return false;
  }

  /** Check which providers are currently reachable */
  async healthCheck(): Promise<Array<{ providerId: string; modelId: string; available: boolean }>> {
    return Promise.all(
      this.providers.map(async (p) => {
        const caps = p.getCapabilities();
        return {
          providerId: caps.providerId,
          modelId: caps.modelId,
          available: await p.isAvailable(),
        };
      })
    );
  }
}
