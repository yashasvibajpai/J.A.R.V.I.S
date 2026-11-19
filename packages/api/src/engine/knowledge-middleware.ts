import type { VectorStore, LLMProvider } from '@jarvis/shared';
import type { Middleware } from './pipeline.js';

const REALTIME_NEWS_INDICATORS = [
  'latest', 'news', 'today', 'current', 'update', 'breaking',
  'recent', 'happening', 'who is', 'weather', 'stock', 'price',
  'outages', 'outage', 'downtime', 'last 7 days', 'last week', 'yesterday',
  'incident', 'breach', 'blackout',
];

const PERSONAL_NOTE_INDICATORS = [
  'my', 'our', 'mine', 'note', 'notes', 'vault', 'obsidian',
  'project', 'projects', 'resume', 'cv', 'profile', 'draft', 'drafts',
  'writeup', 'personal', 'private', 'meeting', 'discussion with',
];

/** Maximum L2 vector distance to consider a match relevant (lower is closer; > 0.60 is noise) */
const MAX_RAG_DISTANCE_THRESHOLD = 0.60;

export function knowledgeMiddleware(
  vectorStore: VectorStore,
  llm: LLMProvider
): Middleware {
  return async (ctx, next) => {
    // Skip if query is too short or lacks substantive text
    if (!ctx.userMessage || ctx.userMessage.trim().length <= 10) {
      return await next();
    }

    const lower = ctx.userMessage.toLowerCase();
    const isRealTime = REALTIME_NEWS_INDICATORS.some((k) => lower.includes(k));
    const isPersonal = PERSONAL_NOTE_INDICATORS.some((k) => lower.includes(k));

    // Shield real-time news / external queries from irrelevant historical notes
    if (isRealTime && !isPersonal) {
      console.log(`[knowledge] Real-time external query detected without personal note indicators. Skipping Obsidian vault RAG.`);
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

      // Filter by relevance threshold
      const relevantMatches = matches.filter((m) => (m.score ?? 1) <= MAX_RAG_DISTANCE_THRESHOLD);

      if (relevantMatches.length === 0) {
        if (matches.length > 0) {
          console.log(`[knowledge] 0/${matches.length} matches met relevance threshold (<= ${MAX_RAG_DISTANCE_THRESHOLD}). Closest: ${matches[0]?.score?.toFixed(3)}. Skipping RAG.`);
        }
        return await next();
      }

      console.log(`[knowledge] RAG search injected ${relevantMatches.length} verified matches (threshold <= ${MAX_RAG_DISTANCE_THRESHOLD})`);

      let contextBlock = `## Verified Personal Knowledge (Obsidian Vault)\n`;
      contextBlock += `The following are private notes, projects, and reference files from the user's personal vault. `;
      contextBlock += `Use them to answer questions about the user's personal life, past projects, or private notes. `;
      contextBlock += `DO NOT mistake historical personal notes as real-time news or current market data.\n\n`;

      for (const match of relevantMatches) {
        const { fileName, content, tags } = match.metadata || {};
        console.log(`[knowledge] -> Match: ${fileName} (Distance: ${match.score?.toFixed(3)})`);
        contextBlock += `--- File: ${fileName || 'Unknown'} (Tags: ${tags || 'none'}) ---\n${content}\n\n`;
      }

      // Append directly to the main system prompt to ensure local models don't ignore it
      const sysIndex = ctx.messages.findIndex((m) => m.role === 'system');
      if (sysIndex >= 0) {
        ctx.messages[sysIndex].content += `\n\n${contextBlock}`;
      } else {
        ctx.messages.unshift({ role: 'system', content: contextBlock });
      }
    } catch (err) {
      console.warn(`[knowledge] RAG middleware failed: ${err}`);
    }

    await next();
  };
}
