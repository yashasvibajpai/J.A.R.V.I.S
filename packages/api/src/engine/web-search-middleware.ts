import type { Middleware } from './pipeline.js';
import type { WebSearchService } from '../services/WebSearchService.js';
import { classifyTask } from './SmartRouter.js';

const REALTIME_KEYWORDS = [
  'latest', 'news', 'today', 'current', 'update', 'breaking',
  'recent', 'happening', 'who is', 'weather', 'stock', 'price',
  'search the web', 'look up', 'google', 'browse', 'war', 'conflict',
  'outages', 'outage', 'downtime', 'last 7 days', 'last week', 'yesterday',
  'incident', 'breach', 'blackout',
];

/**
 * Extracts clean search keywords from a conversational prompt by stripping
 * command verbs, document generation instructions, and meta requirements.
 */
export function extractSearchKeywords(prompt: string): string {
  let cleaned = prompt
    // Strip leading action / document compilation requests
    .replace(/\b(create|generate|compile|write|make|give me|show me|draft|produce)\s+(a\s+)?(brief\s+)?(pdf\s+)?(report|document|summary|overview|brief|article|essay)\s+(on|about|for|regarding)?\b/gi, '')
    // Strip save-as directives
    .replace(/\b(save\s+(as|to)\s+.*|\.pdf|\.md|\.txt)\b/gi, '')
    // Strip meta requirements / instructions
    .replace(/\b(along\s*with|alongwith|including|as well as|covering|detailing|with details on)\b.*/gi, '')
    // Strip punctuation
    .replace(/[,\.?!;:"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // If cleaning resulted in too short a phrase (< 3 chars), fallback to prompt
  return cleaned.length >= 3 ? cleaned : prompt;
}

/**
 * Web Search Middleware (Pre-LLM)
 *
 * Automatically conducts real-time web searches for time-sensitive,
 * current event, or informational queries without requiring OpenClaw.
 * Injects verified live search results directly into the system context.
 */
export function webSearchMiddleware(searchService: WebSearchService): Middleware {
  return async (ctx, next) => {
    const message = ctx.userMessage?.trim() || '';

    // Only search if substantive message
    if (message.length < 5) {
      return await next();
    }

    const lower = message.toLowerCase();
    const taskType = classifyTask(message, ctx.messages);
    const isRealTimeQuery = taskType === 'tool_use' || REALTIME_KEYWORDS.some((k) => lower.includes(k));

    if (isRealTimeQuery) {
      try {
        const searchQuery = extractSearchKeywords(message);
        console.log(`[web-search] Searching live web for: "${searchQuery}" (cleaned from: "${message.substring(0, 50)}...")`);
        let results = await searchService.search(searchQuery, 4);

        // Fallback to original message if cleaned query returned 0 results
        if (results.length === 0 && searchQuery !== message) {
          console.log(`[web-search] Retrying search with raw query...`);
          results = await searchService.search(message, 4);
        }

        if (results.length > 0) {
          const dateStr = new Date().toLocaleDateString('en-US', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'full',
          });

          let searchBlock = `## Real-Time Live Web Results (${dateStr})\n`;
          searchBlock += `The following live web search results were freshly retrieved for this query. Use these verified facts to provide an accurate, up-to-date answer. Cite your sources naturally where relevant:\n\n`;

          for (const res of results) {
            searchBlock += `- [${res.source || 'Web'}] **${res.title}**\n`;
            searchBlock += `  ${res.snippet}\n`;
            searchBlock += `  Link: ${res.url}\n\n`;
          }

          // Inject into system prompt
          const sysIndex = ctx.messages.findIndex((m) => m.role === 'system');
          if (sysIndex >= 0) {
            ctx.messages[sysIndex].content += `\n\n${searchBlock}`;
          } else {
            ctx.messages.unshift({ role: 'system', content: searchBlock });
          }

          ctx.metadata.webSearchConducted = true;
          ctx.metadata.webResultsCount = results.length;
          ctx.metadata.ragSources = [
            ...(ctx.metadata.ragSources || []),
            ...results.map((r) => `${r.title} (${r.source || 'Web'})`),
          ];

          console.log(`[web-search] ✓ Injected ${results.length} live web results into context`);
        } else {
          console.log(`[web-search] No web results found for: "${message}"`);
        }
      } catch (err) {
        console.warn(`[web-search] Search middleware error (non-fatal): ${err}`);
      }
    }

    await next();
  };
}
