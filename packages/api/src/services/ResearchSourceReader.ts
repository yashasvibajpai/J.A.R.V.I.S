import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookup } from 'node:dns';
import { request, type RequestOptions } from 'node:http';
import { request as secureRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ResearchSource, SourceFailure } from '../stores/ResearchWorkspace.js';

const mib = 1024 * 1024;
const htmlLimit = 8 * mib;
const defaultPdfLimit = 32;

export class ResearchSourceReadError extends Error {
  constructor(readonly failure: SourceFailure, message: string) { super(message); }
}

export function researchPdfLimitMiB(): number {
  const setting = process.env.JARVIS_RESEARCH_PDF_MAX_MIB?.trim();
  const value = setting ? Number(setting) : defaultPdfLimit;
  if (!Number.isInteger(value) || value < 1 || value > 128) {
    throw new Error('JARVIS_RESEARCH_PDF_MAX_MIB must be a whole number from 1 to 128');
  }
  return value;
}

type DownloadedDocument = { body: Buffer; hash: string }
  | { pdfPath: string; directory: string; hash: string };

export async function collectResearchDocument(
  response: Readable, type: string, length: number, signal: AbortSignal, maxPdfBytes = researchPdfLimitMiB() * mib,
): Promise<DownloadedDocument> {
  const tooLarge = (format: string, limit: number) =>
    new ResearchSourceReadError('size_limit', `${format} exceeds the ${limit / mib} MiB download limit`);
  const declaredPdf = /application\/pdf/i.test(type);
  if (declaredPdf && length > maxPdfBytes) throw tooLarge('PDF', maxPdfBytes);
  const chunks = response[Symbol.asyncIterator]();
  const prefix: Buffer[] = [];
  let size = 0;
  while (size < 8) {
    signal.throwIfAborted();
    const next = await chunks.next();
    if (next.done) break;
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    size += chunk.length;
    prefix.push(chunk);
  }
  const pdf = declaredPdf || Buffer.concat(prefix, Math.min(size, 8)).subarray(0, 5).toString() === '%PDF-';
  const limit = pdf ? maxPdfBytes : htmlLimit;
  const format = pdf ? 'PDF' : 'Web document';
  if (!pdf && type && !/text\/(?:html|plain)|application\/xhtml\+xml/i.test(type)) {
    throw new Error('Unsupported source content type');
  }
  if (length > limit) throw tooLarge(format, limit);

  const hash = createHash('sha256');
  async function* boundedChunks() {
    let total = 0;
    const checked = (chunk: Buffer) => {
      signal.throwIfAborted();
      total += chunk.length;
      if (total > limit) throw tooLarge(format, limit);
      hash.update(chunk);
      return chunk;
    };
    for (const chunk of prefix) yield checked(chunk);
    for (let next = await chunks.next(); !next.done; next = await chunks.next()) {
      yield checked(Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value));
    }
  }

  if (pdf) {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-source-pdf-'));
    const pdfPath = join(directory, 'source.pdf');
    try {
      await pipeline(Readable.from(boundedChunks()), createWriteStream(pdfPath, { mode: 0o600 }), { signal });
      return { pdfPath, directory, hash: hash.digest('hex') };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  const body: Buffer[] = [];
  for await (const chunk of boundedChunks()) body.push(chunk);
  return { body: Buffer.concat(body), hash: hash.digest('hex') };
}
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

function download(url: string, signal: AbortSignal): Promise<DownloadedDocument | { redirect: string }> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https:') ? secureRequest : request;
    let receivedResponse = false;
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
      receivedResponse = true;
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy();
        try { resolve({ redirect: new URL(response.headers.location, url).toString() }); }
        catch { reject(new Error('Source returned an invalid redirect')); }
        return;
      }
      if (status !== 200) {
        response.destroy();
        const message = `Source returned HTTP ${status}`;
        reject(status === 403 ? new ResearchSourceReadError('forbidden', message)
          : [401, 402].includes(status) ? new ResearchSourceReadError('access_required', message) : new Error(message));
        return;
      }
      void collectResearchDocument(response, response.headers['content-type'] ?? '', Number(response.headers['content-length']), signal)
        .then(resolve, error => {
          response.destroy();
          reject(error);
        });
    });
    req.on('error', error => { if (!receivedResponse) reject(error); });
    req.setTimeout(20_000, () => req.destroy(new Error('Source download made no progress for 20 seconds')));
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

export function readResearchPdf(input: Buffer | string, signal: AbortSignal): Promise<string> {
  const extract = (program: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
    const child = execFile(program, args, { signal, timeout, env, maxBuffer: 600_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin?.on('error', () => { /* execFile reports conversion or spawn failure */ });
    child.stdin?.end(typeof input === 'string' ? undefined : input);
  });
  return extract('pdftotext', ['-f', '1', '-l', '60', '-layout', typeof input === 'string' ? input : '-', '-'], 12_000).catch(async error => {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('PDF text could not be extracted');
    if (process.platform !== 'darwin') throw new Error('PDF text requires pdftotext from Poppler');
    const decoder = `
import Foundation
import PDFKit
let path = ProcessInfo.processInfo.environment["JARVIS_PDFKIT_SOURCE_FILE"] ?? ""
let document = path.isEmpty
    ? PDFDocument(data: FileHandle.standardInput.readDataToEndOfFile())
    : PDFDocument(url: URL(fileURLWithPath: path))
guard let document else { exit(1) }
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
        JARVIS_PDFKIT_SOURCE_FILE: typeof input === 'string' ? input : '',
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
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    for (let redirects = 0; redirects < 5; redirects++) {
      const result = await download(url, deadline);
      if ('redirect' in result) {
        url = canonicalResearchUrl(result.redirect);
        continue;
      }
      const pdf = 'pdfPath' in result;
      let text: string;
      if (pdf) {
        try {
          text = await readResearchPdf(result.pdfPath, AbortSignal.any([signal, AbortSignal.timeout(75_000)]));
        } finally {
          await rm(result.directory, { recursive: true, force: true });
        }
      } else {
        text = result.body.toString('utf8');
        if (/"isAccessibleForFree"\s*:\s*(?:false|"false")(?=\s*[,}])/i.test(text)) {
          throw new ResearchSourceReadError('access_required', 'The page identifies the full text as access restricted');
        }
      }
      const passages = pdf ? text.split('\f').flatMap((page, index) => {
        const parts = cleanText(page).match(/.{1,1800}(?:\s|$)/g) ?? [];
        return parts.map((part, offset) => ({ locator: `Page ${index + 1} · passage ${offset + 1}`, text: part.trim() }));
      }).slice(0, 80) : passagesFromHtml(text);
      if (!passages.length) throw pdf
        ? new ResearchSourceReadError('no_pdf_text', 'No usable text was extracted from the sampled PDF pages. Scanned pages may require OCR')
        : new Error('No readable text was retrieved');
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
        retrievedAt: new Date().toISOString(), hash: result.hash, passages,
      };
    }
    throw new Error('Source redirect limit exceeded');
  }
}
