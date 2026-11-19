/**
 * WebSearchService — Native Real-Time Web Search for JARVIS
 *
 * Provides real-time internet search capabilities without requiring OpenClaw.
 * Features:
 *   1. Google News RSS: Zero-key, real-time live news for breaking events & current updates.
 *   2. DuckDuckGo Instant Answers: Zero-key factual abstract & entity search.
 *   3. Tavily Search (optional): Uses TAVILY_API_KEY if configured in .env.
 *   4. Brave Search (optional): Uses BRAVE_API_KEY if configured in .env.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  source?: string;
}

export class WebSearchService {
  private tavilyApiKey?: string;
  private braveApiKey?: string;

  constructor() {
    this.tavilyApiKey = process.env.TAVILY_API_KEY;
    this.braveApiKey = process.env.BRAVE_API_KEY;
  }

  /**
   * Search the live web for a given query.
   * Auto-selects the best search engine based on query intent and configured keys.
   */
  async search(query: string, maxResults: number = 4): Promise<SearchResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    // 1. If Tavily API key is provided, prefer it for LLM-optimized search
    if (this.tavilyApiKey) {
      try {
        const results = await this.searchTavily(cleanQuery, maxResults);
        if (results.length > 0) return results;
      } catch (err) {
        console.warn(`[web-search] Tavily search failed: ${err}. Falling back to native.`);
      }
    }

    // 2. If Brave API key is provided, use Brave
    if (this.braveApiKey) {
      try {
        const results = await this.searchBrave(cleanQuery, maxResults);
        if (results.length > 0) return results;
      } catch (err) {
        console.warn(`[web-search] Brave search failed: ${err}. Falling back to native.`);
      }
    }

    // 3. For news, current events, or time-sensitive queries, use Google News RSS (zero-key, live)
    const isNewsQuery = this.isCurrentEventsQuery(cleanQuery);
    if (isNewsQuery) {
      try {
        const newsResults = await this.searchGoogleNews(cleanQuery, maxResults);
        if (newsResults.length > 0) return newsResults;
      } catch (err) {
        console.warn(`[web-search] Google News RSS failed: ${err}`);
      }
    }

    // 4. Fallback to DuckDuckGo Instant Answer / Knowledge Base
    try {
      const ddgResults = await this.searchDuckDuckGo(cleanQuery, maxResults);
      if (ddgResults.length > 0) return ddgResults;
    } catch (err) {
      console.warn(`[web-search] DuckDuckGo instant search failed: ${err}`);
    }

    // 5. Final fallback to Google News if not already tried
    if (!isNewsQuery) {
      try {
        return await this.searchGoogleNews(cleanQuery, maxResults);
      } catch {
        return [];
      }
    }

    return [];
  }

  // ─── Google News RSS (Zero-Key Live News) ───────────────────────────────────

  private async searchGoogleNews(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, {
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

  private async searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'JARVIS/1.0' },
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo API returned HTTP ${res.status}`);
    }

    const data = await res.json() as {
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

  private async searchTavily(query: string, maxResults: number): Promise<SearchResult[]> {
    const res = await fetch('https://api.tavily.com/search', {
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
      throw new Error(`Tavily API returned HTTP ${res.status}`);
    }

    const data = await res.json() as {
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

  private async searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.braveApiKey!,
      },
    });

    if (!res.ok) {
      throw new Error(`Brave API returned HTTP ${res.status}`);
    }

    const data = await res.json() as {
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

  private isCurrentEventsQuery(query: string): boolean {
    const lower = query.toLowerCase();
    const newsKeywords = [
      'latest', 'news', 'today', 'current', 'update', 'breaking',
      'recent', 'happening', 'who is', 'price', 'score', 'weather',
      'war', 'election', 'conflict', 'market',
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
