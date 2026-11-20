import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookup } from 'node:dns';
import { request, type RequestOptions } from 'node:http';
import { request as secureRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { ResearchSource } from '../stores/ResearchWorkspace.js';

const maxBytes = 8 * 1024 * 1024;
let swiftModuleCache: string | undefined;
const privateNetworks = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) privateNetworks.addSubnet(address, prefix);
privateNetworks.addSubnet('2001::', 23, 'ipv6');
privateNetworks.addSubnet('2002::', 16, 'ipv6');
privateNetworks.addSubnet('2001:db8::', 32, 'ipv6');
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');

function isPublic(address: string): boolean {
  return isIP(address) === 4 ? !privateNetworks.check(address)
    : globalIPv6.check(address, 'ipv6') && !privateNetworks.check(address, 'ipv6');
}

export function canonicalResearchUrl(input: string): string {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))) {
    throw new Error('Unexpected URL protocol, credentials, or port');
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublic(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('Source points to a private or reserved address');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || ['fbclid', 'gclid'].includes(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function download(url: string, signal: AbortSignal): Promise<{ type: string; body: Buffer } | { redirect: string }> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https:') ? secureRequest : request;
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      method: 'GET', signal, agent: false, autoSelectFamily: false,
      headers: { 'User-Agent': 'JARVIS Research/1.0', Accept: 'text/html,text/plain,application/pdf' },
      lookup: (hostname, options, callback) => {
        lookup(hostname, { ...options, all: false }, (error, address, family) => {
          if (error) callback(error, '', 0);
          else if (!isPublic(address)) callback(new Error('Source resolved to a private or reserved address'), '', 0);
          else callback(null, address, family);
        });
      },
    };
    const req = get(url, options, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy();
        try { resolve({ redirect: new URL(response.headers.location, url).toString() }); }
        catch { reject(new Error('Source returned an invalid redirect')); }
        return;
      }
      if (status !== 200) {
        response.destroy();
        reject(new Error(`Source returned HTTP ${status}`));
        return;
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        response.destroy();
        reject(new Error('Source exceeds the document size limit'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(new Error('Source exceeds the document size limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ type: response.headers['content-type'] ?? '', body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function cleanText(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/<[^>]*>/g, ' ').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] ?? match;
    const number = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ' ';
  }).replace(/\s+/g, ' ').trim();
}

export function readResearchPdf(body: Buffer, signal: AbortSignal): Promise<string> {
  const extract = (program: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
    const child = execFile(program, args, { signal, timeout, env, maxBuffer: 600_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin?.on('error', () => { /* execFile reports conversion or spawn failure */ });
    child.stdin?.end(body);
  });
  return extract('pdftotext', ['-f', '1', '-l', '60', '-layout', '-', '-'], 12_000).catch(async error => {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('PDF text could not be extracted');
    if (process.platform !== 'darwin') throw new Error('PDF text requires pdftotext from Poppler');
    const decoder = `
import Foundation
import PDFKit
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let document = PDFDocument(data: input) else { exit(1) }
for i in 0..<min(document.pageCount, 60) {
    if i != 0 { print("\\u{000C}", terminator: "") }
    print(document.page(at: i)?.string ?? "", terminator: "")
}
`;
    try {
      if (!swiftModuleCache) {
        const cache = mkdtempSync(join(tmpdir(), 'jarvis-pdfkit-'));
        swiftModuleCache = cache;
        process.once('exit', () => {
          try { rmSync(cache, { recursive: true, force: true }); } catch { /* Temporary cache only. */ }
        });
      }
      return await extract('/usr/bin/swift', ['-module-cache-path', swiftModuleCache, '-e', decoder], 55_000, {
        ...process.env, CLANG_MODULE_CACHE_PATH: swiftModuleCache,
      });
    } catch {
      signal.throwIfAborted();
      throw new Error('PDF text extraction needs Poppler or working macOS Swift command-line tools');
    }
  });
}

function passagesFromHtml(html: string): ResearchSource['passages'] {
  const withoutChrome = html.replace(/<!--[^]*?-->/g, '').replace(
    /<(script|style|noscript|nav|footer|aside|svg)\b[^>]*>[^]*?<\/\1\s*>/gi, '',
  );
  const article = /<(?:main|article)\b[^>]*>([^]*?)<\/(?:main|article)>/i.exec(withoutChrome)?.[1] ?? withoutChrome;
  const sections = article.split(/(<h[1-6]\b[^>]*>[^]*?<\/h[1-6]>)/gi);
  let heading = 'Document';
  return sections.flatMap((item, index) => {
    if (index % 2) {
      heading = cleanText(item).slice(0, 140) || 'Document';
      return [];
    }
    const text = cleanText(item);
    return (text.match(/.{1,1800}(?:\s|$)/g) ?? (text ? [text] : []))
      .map((piece, part) => ({ locator: `${heading} · section ${index / 2 + 1} · passage ${part + 1}`, text: piece.trim() }));
  }).filter(passage => passage.text.length > 35).slice(0, 80);
}

export class ResearchSourceReader {
  async open(address: string, title: string, signal: AbortSignal): Promise<Omit<ResearchSource, 'id'>> {
    let url = canonicalResearchUrl(address);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
    for (let redirects = 0; redirects < 5; redirects++) {
      const result = await download(url, deadline);
      if ('redirect' in result) {
        url = canonicalResearchUrl(result.redirect);
        continue;
      }
      const { body, type } = result;
      const pdf = /application\/pdf/i.test(type) || body.subarray(0, 5).toString() === '%PDF-';
      if (!pdf && type && !/text\/(?:html|plain)|application\/xhtml\+xml/i.test(type)) {
        throw new Error('Unsupported source content type');
      }
      const text = pdf ? await readResearchPdf(body, AbortSignal.any([signal, AbortSignal.timeout(75_000)])) : body.toString('utf8');
      const passages = pdf ? text.split('\f').flatMap((page, index) => {
        const parts = cleanText(page).match(/.{1,1800}(?:\s|$)/g) ?? [];
        return parts.map((part, offset) => ({ locator: `Page ${index + 1} · passage ${offset + 1}`, text: part.trim() }));
      }).slice(0, 80) : passagesFromHtml(text);
      if (!passages.length) throw new Error('No readable text was retrieved');
      const canonicalTag = pdf ? undefined : text.match(/<link\b[^>]*>/gi)
        ?.find(tag => /\brel\s*=\s*['"]canonical['"]/i.test(tag));
      const canonical = canonicalTag?.match(/\bhref\s*=\s*(['"])(.*?)\1/i)?.[2];
      let family = new URL(url).hostname;
      if (canonical) {
        try { family = new URL(canonicalResearchUrl(new URL(canonical, url).toString())).hostname; }
        catch { /* Treat invalid canonical metadata as unavailable. */ }
      }
      return {
        url, title: title || cleanText(/<title\b[^>]*>([^]*?)<\/title>/i.exec(text)?.[1] ?? '') || url,
        family: family.toLowerCase().replace(/^(www\.|m\.)/, ''),
        retrievedAt: new Date().toISOString(), hash: createHash('sha256').update(body).digest('hex'), passages,
      };
    }
    throw new Error('Source redirect limit exceeded');
  }
}
