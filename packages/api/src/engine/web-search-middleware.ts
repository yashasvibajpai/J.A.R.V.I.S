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
 * Extracts clean, concise search keywords from a conversational prompt by stripping
 * command verbs, document generation instructions, meta requirements, and filler.
 * Aims to produce a short, focused query (under ~80 chars) for search engines.
 */
export function extractSearchKeywords(prompt: string): string {
  let cleaned = prompt
    // Strip leading action / conversational commands
    .replace(/^(can you\s+)?(please\s+)?(analyze|evaluate|investigate|assess|summarize|review|explain|compare|give me|show me)\s+/i, '')
    // Strip leading document compilation requests
    .replace(/\b(create|generate|compile|write|make|draft|produce)\s+(a\s+)?(brief\s+)?(detailed\s+)?(comprehensive\s+)?(pdf\s+)?(md\s+)?(markdown\s+)?(report|document|summary|overview|brief|article|essay|file|paper)\s*(on|about|for|regarding|into|in)?\b/gi, '')
    // Strip save-as / output format directives
    .replace(/\b(save\s+(as|to)\s+.*|put\s+it\s+in\s+.*|\.pdf|\.md|\.txt)\b/gi, '')
    // Strip meta requirements / "along with" tails
    .replace(/\b(along\s*with|alongwith|including|as well as|covering|detailing|with details on)\b.*/gi, '')
    // Strip evaluation / analysis tails
    .replace(/\b(and\s+)?(evaluate|explain|assess|investigate|determine|figure out|understand)\s+(why|how|what|whether|if)?\s*.*/gi, '')
    // Strip filler phrases
    .replace(/\b(the\s+)?(prices?\s+are\s+the\s+way\s+they\s+are|reasons?\s+behind\s+it|what\s+caused\s+it)\b/gi, '')
    // Strip punctuation
    .replace(/[,\.?!;:\"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // If still too long (>80 chars), take first meaningful N words
  if (cleaned.length > 80) {
    const words = cleaned.split(' ').filter(w => w.length > 1);
    cleaned = words.slice(0, 8).join(' ');
  }

  // If cleaning resulted in too short a phrase (< 3 chars), fallback to first ~60 chars of prompt
  if (cleaned.length < 3) {
    cleaned = prompt.substring(0, 60).trim();
  }

  return cleaned;
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

        // Concurrently fetch web search results (up to 6) and live stock quotes (if applicable)
        const [searchResults, stockData] = await Promise.all([
          searchService.search(searchQuery, 6),
          searchService.getLiveStockData(message),
        ]);

        let results = searchResults;

        // Fallback to original message if cleaned query returned 0 results
        if (results.length === 0 && searchQuery !== message) {
          console.log(`[web-search] Retrying search with raw query...`);
          results = await searchService.search(message, 6);
        }

        if (stockData) {
          console.log(`[web-search] ✓ Injected live market ticker data into context`);
        }

        if (results.length > 0 || stockData) {
          let searchBlock = `## Verified Real-Time Web Intelligence (Highest Ground Truth Priority)\n` +
            `The information below was retrieved live from the internet in real time. ` +
            `It reflects verified current developments and MUST serve as your primary source of truth. ` +
            `Always prioritize these live search results over your internal pre-training cutoff or historical knowledge whenever discussing current events, news, companies, executive leadership, or market prices. ` +
            `If the live search results report breaking changes (e.g. leadership departures, resignations, price movements, or events), synthesize and lead with these verified facts rather than relying on prior memory.\n\n`;

          if (stockData) {
            searchBlock += `${stockData}\n`;
          }

          if (results.length > 0) {
            searchBlock += `### Live Web News & Articles\n`;
            for (const res of results) {
              const pubInfo = res.publishedAt ? ` [Published: ${res.publishedAt}]` : '';
              searchBlock += `- [${res.source || 'Web'}] **${res.title}**${pubInfo}\n`;
              searchBlock += `  ${res.snippet}\n`;
              searchBlock += `  Link: ${res.url}\n\n`;
            }
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
