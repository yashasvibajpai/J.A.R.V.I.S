import type { VectorStore, LLMProvider } from '@jarvis/shared';
import type { Middleware } from './pipeline.js';

export function knowledgeMiddleware(
  vectorStore: VectorStore,
  llm: LLMProvider
): Middleware {
  return async (ctx, next) => {
    // Skip if query is too short or lacks substantive text
    if (!ctx.userMessage || ctx.userMessage.trim().length <= 10) {
      return await next();
    }

    try {
      if (!llm.embed) {
        console.warn('[knowledge] LLMProvider lacks .embed() method. Skipping RAG.');
        return await next();
      }

      // Generate embedding for the user's query
      const queryVector = await llm.embed(ctx.userMessage);

      // Perform semantic search
      const matches = await vectorStore.search(queryVector, 4);
      console.log(`[knowledge] RAG search returned ${matches.length} matches for query: "${ctx.userMessage}"`);

      if (matches.length > 0) {
        let contextBlock = `## Verified Personal Knowledge (Obsidian Vault)\n`;
        contextBlock += `You have access to relevant personal notes from the user's Obsidian Vault below. `;
        contextBlock += `When the user's query asks about their personal notes, past projects, life context, or private documents, prioritize these verified facts and cite the source file naturally (e.g., "According to your note on X"). `;
        contextBlock += `For general topics, news, research, document creation, or tasks not covered in these notes, combine any relevant context with your broad knowledge and live search results.\n\n`;

        for (const match of matches) {
          const { fileName, content, tags } = match.metadata || {};
          console.log(`[knowledge] -> Match: ${fileName} (Score/Distance: ${match.score})`);
          contextBlock += `--- File: ${fileName || 'Unknown'} (Tags: ${tags || 'none'}) ---\n${content}\n\n`;
        }

        // Append directly to the main system prompt to ensure local models don't ignore it
        const sysIndex = ctx.messages.findIndex((m) => m.role === 'system');
        if (sysIndex >= 0) {
          ctx.messages[sysIndex].content += `\n\n${contextBlock}`;
        } else {
          ctx.messages.unshift({ role: 'system', content: contextBlock });
        }
      }
    } catch (err) {
      // system metrics couple here with the knowledge-base orchestrator metrics
      console.warn(`[knowledge] RAG middleware failed: ${err}`);
    }

    await next();
  };
}
