/**
 * WebSearchService — Native Real-Time Web Search & Financial Market Intelligence
 *
 * Provides real-time internet search capabilities without requiring OpenClaw.
 * Features:
 *   1. Google News RSS: Zero-key, real-time live news for breaking events & current updates.
 *   2. DuckDuckGo HTML Search: Zero-key real web search with full article snippets and links.
 *   3. Yahoo Finance Live Quotes: Real-time 5-day stock trends, tickers, and closing prices.
 *   4. DuckDuckGo Instant Answers: Zero-key factual abstract & entity search.
 *   5. Tavily Search (optional): Uses TAVILY_API_KEY if configured in .env.
 *   6. Brave Search (optional): Uses BRAVE_API_KEY if configured in .env.
 */

import type { SQLiteProviderQuota } from '../stores/SQLiteProviderQuota.js';
import type { ProviderState } from '../engine/SmartRouter.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  source?: string;
}

const COMMON_STOCK_TICKERS: Record<string, string> = {
  apple: 'AAPL',
  microsoft: 'MSFT',
  nvidia: 'NVDA',
  google: 'GOOGL',
  alphabet: 'GOOGL',
  amazon: 'AMZN',
  meta: 'META',
  facebook: 'META',
  tesla: 'TSLA',
  netflix: 'NFLX',
  jpmorgan: 'JPM',
  'jp morgan': 'JPM',
  'chase': 'JPM',
  goldman: 'GS',
  'goldman sachs': 'GS',
  'bank of america': 'BAC',
  'morgan stanley': 'MS',
  visa: 'V',
  mastercard: 'MA',
};

export class WebSearchService {
  private tavilyApiKey?: string;
  private braveApiKey?: string;

  constructor(private readonly quota?: SQLiteProviderQuota) {
    this.tavilyApiKey = process.env.TAVILY_API_KEY;
    this.braveApiKey = process.env.BRAVE_API_KEY;
  }

  /**
   * Search the live web for a given query.
   * Auto-selects the best search engine based on query intent and configured keys.
   */
  async search(query: string, maxResults = 4, options?: {
    signal?: AbortSignal; warn?: (message: string) => void; publicOnly?: boolean;
  }): Promise<SearchResult[]> {
    const signal = options?.signal;
    const warn = (message: string) => {
      signal?.throwIfAborted();
      (options?.warn ?? console.warn)(message);
    };
    signal?.throwIfAborted();
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    // 1. If Tavily API key is provided, prefer it for LLM-optimized search
    if (!options?.publicOnly && this.tavilyApiKey && this.reserveSearch('tavily')) {
      try {
        const results = await this.searchTavily(cleanQuery, maxResults, signal);
        if (results.length > 0) return results;
      } catch (err) {
        warn(`[web-search] Tavily search failed: ${err}. Falling back to native.`);
      }
    }

    // 2. If Brave API key is provided, use Brave
    if (!options?.publicOnly && this.braveApiKey && this.reserveSearch('brave')) {
      try {
        const results = await this.searchBrave(cleanQuery, maxResults, signal);
        if (results.length > 0) return results;
      } catch (err) {
        warn(`[web-search] Brave search failed: ${err}. Falling back to native.`);
      }
    }

    // 3. For news, current events, or time-sensitive queries:
    // Combine Google News RSS (breaking headlines) + DuckDuckGo HTML (article snippets) concurrently
    const isNewsQuery = this.isCurrentEventsQuery(cleanQuery);
    if (isNewsQuery) {
      const targetCount = Math.max(maxResults, 6);
      const [newsResults, ddgResults] = await Promise.all([
        this.searchGoogleNews(cleanQuery, targetCount, signal).catch((err) => {
          warn(`[web-search] Google News RSS failed: ${err}`);
          return [] as SearchResult[];
        }),
        this.searchDuckDuckGoHtml(cleanQuery, targetCount, signal).catch((err) => {
          warn(`[web-search] DuckDuckGo HTML search failed: ${err}`);
          return [] as SearchResult[];
        }),
      ]);

      const combined: SearchResult[] = [];
      const seenTitles = new Set<string>();

      // Filter out generic landing pages (e.g. /latest with no article slug)
      const isGenericHub = (r: SearchResult) =>
        /(\/latest\/?$|\/news\/?$|\/trending\/?$|\/newsroom\/?$)/i.test(r.url) ||
        (r.snippet.length < 80 && /track.*in real time|see the latest/i.test(r.snippet));

      // 1. Substantive DuckDuckGo articles come FIRST: they provide full multi-sentence
      //    paragraph snippets explaining the actual events, who resigned, and why.
      const specificDdg = ddgResults.filter((r) => !isGenericHub(r));
      const genericDdg = ddgResults.filter((r) => isGenericHub(r));

      for (const r of specificDdg.slice(0, 4)) {
        const normTitle = r.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
        if (!seenTitles.has(normTitle)) {
          seenTitles.add(normTitle);
          combined.push(r);
        }
      }

      // 2. Add real-time timestamped headlines from Google News RSS for fresh breaking developments
      for (const r of newsResults) {
        const normTitle = r.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
        if (!seenTitles.has(normTitle)) {
          seenTitles.add(normTitle);
          combined.push(r);
        }
        if (combined.length >= targetCount) break;
      }

      // 3. Fill remaining slots with generic DDG results if needed
      if (combined.length < targetCount) {
        for (const r of genericDdg) {
          const normTitle = r.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
          if (!seenTitles.has(normTitle)) {
            seenTitles.add(normTitle);
            combined.push(r);
          }
          if (combined.length >= targetCount) break;
        }
      }

      if (combined.length > 0) {
        return combined.slice(0, targetCount);
      }
    }

    // 4. Try DuckDuckGo HTML search for general queries
    try {
      const ddgHtml = await this.searchDuckDuckGoHtml(cleanQuery, maxResults, signal);
      if (ddgHtml.length > 0) return ddgHtml;
    } catch (err) {
      warn(`[web-search] DuckDuckGo HTML search failed: ${err}`);
    }

    // 5. Fallback to DuckDuckGo Instant Answer / Knowledge Base
    try {
      const ddgResults = await this.searchDuckDuckGo(cleanQuery, maxResults, signal);
      if (ddgResults.length > 0) return ddgResults;
    } catch (err) {
      warn(`[web-search] DuckDuckGo instant search failed: ${err}`);
    }

    // 6. Final fallback to Google News
    try {
      return await this.searchGoogleNews(cleanQuery, maxResults, signal);
    } catch {
      signal?.throwIfAborted();
      return [];
    }
  }

  // ─── Real-Time Stock Market Intelligence (Yahoo Finance API) ────────────────

  /**
   * Fetches real-time 5-day stock trends and prices for companies relevant to the prompt.
   * Returns a formatted markdown table or null if not a financial/stock query.
   */
  async getLiveStockData(prompt: string): Promise<string | null> {
    const lower = prompt.toLowerCase();
    const isStockQuery =
      /\b(stock|stocks|stock\s*prices?|share\s*prices?|shares?|equit(y|ies)|market\s*prices?|wall\s*street|nasdaq|nyse|dow\s*jones|s&p\s*500)\b/i.test(lower);

    if (!isStockQuery) return null;

    const tickers = this.extractTickers(prompt);
    if (tickers.length === 0) return null;

    try {
      const quotes = await Promise.all(tickers.map((t) => this.fetchStockQuote(t)));
      const validQuotes = quotes.filter((q): q is NonNullable<typeof q> => q !== null);

      if (validQuotes.length === 0) return null;

      const firstQuote = validQuotes[0];
      const startDay = firstQuote.dates[0] || 'Day 1';
      const endDay = firstQuote.dates[firstQuote.dates.length - 1] || 'Current';

      let table = `### Verified Live Stock Market Data (5-Day Trend: ${startDay} – ${endDay})\n`;
      table += `*Source: Real-time market feed as of ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}*\n\n`;
      table += `| Ticker | Current Price | 5-Day Change | Daily Close Progression (${startDay} → ${endDay}) |\n`;
      table += `| :--- | :--- | :--- | :--- |\n`;

      for (const q of validQuotes) {
        const progression = q.closes.map((c, i) => `${q.dates[i]}: $${c.toFixed(2)}`).join(' → ');
        table += `| **${q.symbol}** | **$${q.price.toFixed(2)}** | \`${q.changePct}\` | ${progression} |\n`;
      }
      table += `\n`;

      return table;
    } catch (err) {
      console.warn(`[web-search] Failed to fetch live stock data: ${err}`);
      return null;
    }
  }

  private extractTickers(prompt: string): string[] {
    const lower = prompt.toLowerCase();
    const found = new Set<string>();

    for (const [name, sym] of Object.entries(COMMON_STOCK_TICKERS)) {
      if (lower.includes(name)) found.add(sym);
    }

    // Check for uppercase ticker symbols like $AAPL or AAPL
    const regex = /\b([A-Z]{2,5})\b/g;
    let m: RegExpExecArray | null;
    const ignoreList = ['THE', 'FOR', 'AND', 'PDF', 'REPORT', 'LAST', 'WEEK', 'MD', 'ARE', 'WHY', 'PUT', 'NOT', 'NEW', 'DAY', 'DAYS', 'USA', 'USD'];
    while ((m = regex.exec(prompt)) !== null) {
      if (!ignoreList.includes(m[1])) {
        found.add(m[1]);
      }
    }

    // If generic "tech and financial" query without specific companies
    if (found.size === 0) {
      if (lower.includes('tech') && (lower.includes('financ') || lower.includes('bank'))) {
        return ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'JPM', 'GS'];
      }
      if (lower.includes('tech')) {
        return ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN'];
      }
      if (lower.includes('financ') || lower.includes('bank')) {
        return ['JPM', 'BAC', 'GS', 'MS'];
      }
      return ['AAPL', 'MSFT', 'NVDA', 'JPM'];
    }

    return Array.from(found);
  }

  private async fetchStockQuote(ticker: string): Promise<{
    symbol: string;
    price: number;
    changePct: string;
    closes: number[];
    dates: string[];
  } | null> {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) return null;

      const data = (await res.json()) as any;
      const result = data.chart?.result?.[0];
      if (!result) return null;

      const meta = result.meta;
      const closes: number[] = result.indicators?.quote?.[0]?.close?.filter((v: any) => v !== null) || [];
      const timestamps: number[] = result.timestamp || [];
      const dates = timestamps.map((t) =>
        new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      );

      const currentPrice: number = meta.regularMarketPrice || closes[closes.length - 1] || 0;
      const prevClose: number = meta.chartPreviousClose || closes[0] || currentPrice;
      const pct = (((currentPrice - prevClose) / prevClose) * 100).toFixed(2);
      const changePct = `${Number(pct) >= 0 ? '+' : ''}${pct}%`;

      return {
        symbol: meta.symbol || ticker,
        price: currentPrice,
        changePct,
        closes: closes.map((c) => Number(c.toFixed(2))),
        dates,
      };
    } catch {
      return null;
    }
  }

  // ─── DuckDuckGo HTML Search (Rich Web Articles & Snippets) ──────────────────

  private async searchDuckDuckGoHtml(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo HTML returned HTTP ${res.status}`);
    }

    const html = await res.text();
    const blocks = html.split('<div class="result results_links');
    const results: SearchResult[] = [];

    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const urlMatch = block.match(/href="([^"]+)"/);

      if (snippetMatch) {
        const cleanSnippet = this.decodeHtml(snippetMatch[1]);
        const rawTitle = titleMatch ? this.decodeHtml(titleMatch[1]) : query;
        const cleanTitle = rawTitle.replace(/<[^>]+>/g, '').trim() || query;
        const rawUrl = urlMatch ? urlMatch[1] : '';

        // Extract clean destination url from DuckDuckGo redirect
        const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
        const finalUrl = uddgMatch ? decodeURIComponent(uddgMatch[1]) : rawUrl;

        // Extract domain source
        let source = 'Web';
        try {
          const u = new URL(finalUrl);
          source = u.hostname.replace(/^www\./, '');
        } catch {
          // ignore invalid url parse
        }

        results.push({
          title: cleanTitle,
          url: finalUrl,
          snippet: cleanSnippet,
          source,
        });

        if (results.length >= maxResults) break;
      }
    }

    return results;
  }

  // ─── Google News RSS (Zero-Key Live News) ───────────────────────────────────

  private async searchGoogleNews(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) {
      throw new Error(`Google News returned HTTP ${res.status}`);
    }

    const xml = await res.text();
    const results: SearchResult[] = [];
    const itemMatches = xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?<\/item>/g);

    for (const match of itemMatches) {
      const rawTitle = match[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1');
      const title = this.decodeHtml(rawTitle);
      const link = match[2].trim();
      const pubDate = match[3].trim();

      // Separate source publication from title if present (e.g. "Headline - Reuters")
      const dashIdx = title.lastIndexOf(' - ');
      const source = dashIdx !== -1 ? title.substring(dashIdx + 3).trim() : 'Google News';
      const cleanTitle = dashIdx !== -1 ? title.substring(0, dashIdx).trim() : title;

      results.push({
        title: cleanTitle,
        url: link,
        snippet: `[${source}] (Published ${pubDate}): ${cleanTitle}`,
        publishedAt: pubDate,
        source,
      });

      if (results.length >= maxResults) break;
    }

    return results;
  }

  // ─── DuckDuckGo Instant Answer API ─────────────────────────────────────────

  private async searchDuckDuckGo(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      signal,
      headers: { 'User-Agent': 'JARVIS/1.0' },
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo API returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      Heading?: string;
      Abstract?: string;
      AbstractURL?: string;
      AbstractSource?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };

    const results: SearchResult[] = [];

    if (data.Abstract && data.Abstract.trim()) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL || 'https://duckduckgo.com/?q=' + encodeURIComponent(query),
        snippet: data.Abstract,
        source: data.AbstractSource || 'DuckDuckGo Knowledge',
      });
    }

    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.split(' - ')[0] || query,
            url: topic.FirstURL,
            snippet: topic.Text,
            source: 'DuckDuckGo Knowledge',
          });
          if (results.length >= maxResults) break;
        }
      }
    }

    return results;
  }

  // ─── Tavily Search API (Optional) ──────────────────────────────────────────

  private async searchTavily(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const res = await fetch('https://api.tavily.com/search', {
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.tavilyApiKey,
        query,
        search_depth: 'basic',
        max_results: maxResults,
      }),
    });

    if (!res.ok) {
      this.searchCooldown('tavily', res);
      throw new Error(`Tavily API returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      results?: Array<{ title: string; url: string; content: string; published_date?: string }>;
    };

    return (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      publishedAt: r.published_date,
      source: 'Tavily',
    }));
  }

  // ─── Brave Search API (Optional) ───────────────────────────────────────────

  private async searchBrave(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const res = await fetch(url, {
      signal,
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.braveApiKey!,
      },
    });

    if (!res.ok) {
      this.searchCooldown('brave', res);
      throw new Error(`Brave API returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string; page_age?: string }> };
    };

    return (data.web?.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      publishedAt: r.page_age,
      source: 'Brave Search',
    }));
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private searchState(): ProviderState {
    const now = Date.now();
    return {
      requestsThisMinute: 0, requestsToday: 0, tokensToday: 0, cooldownUntil: null, consecutiveFailures: 0,
      lastUsed: null, minuteWindowStart: now, dayWindowStart: now,
    };
  }

  private reserveSearch(provider: 'tavily' | 'brave'): boolean {
    if (!this.quota) return true;
    const setting = (suffix: string) => {
      const key = `JARVIS_${provider.toUpperCase()}_SEARCH_${suffix}`;
      const raw = process.env[key];
      if (!raw?.trim()) return Infinity;
      const amount = Number(raw);
      if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`${key} must be a positive integer`);
      return amount;
    };
    const rpm = setting('RPM');
    const monthly = setting('MONTHLY');
    return this.quota.update(`search/${provider}`, this.searchState(), state => {
      const now = Date.now();
      const date = new Date(now);
      const month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
      if (month !== state.dayWindowStart) {
        state.dayWindowStart = month;
        state.requestsToday = 0;
      }
      if (now >= state.minuteWindowStart + 60_000) {
        state.minuteWindowStart = now;
        state.requestsThisMinute = 0;
      }
      if ((state.cooldownUntil && state.cooldownUntil.getTime() > now) ||
        state.requestsThisMinute >= rpm || state.requestsToday >= monthly) return false;
      state.requestsThisMinute++;
      state.requestsToday++;
      return true;
    });
  }

  private searchCooldown(provider: 'tavily' | 'brave', response: Response): void {
    if (!this.quota || response.status !== 429) return;
    const header = response.headers.get('retry-after');
    const now = Date.now();
    const resume = header && Number.isFinite(Number(header)) ? now + Number(header) * 1000
      : header ? Date.parse(header) : NaN;
    this.quota.update(`search/${provider}`, this.searchState(), state => {
      state.cooldownUntil = new Date(Math.max(now + 1000, state.cooldownUntil?.getTime() ?? 0,
        Number.isFinite(resume) ? resume : now + 60_000));
    });
  }

  private isCurrentEventsQuery(query: string): boolean {
    const lower = query.toLowerCase();
    const newsKeywords = [
      'latest', 'news', 'today', 'current', 'update', 'breaking',
      'recent', 'happening', 'who is', 'price', 'score', 'weather',
      'war', 'election', 'conflict', 'market', 'stocks', 'stock',
      'outages', 'outage', 'last week', 'last 7 days',
    ];
    return newsKeywords.some((k) => lower.includes(k));
  }

  private decodeHtml(str: string): string {
    return str
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
