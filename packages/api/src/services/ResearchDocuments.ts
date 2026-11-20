import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname } from 'node:path';
import type { SQLiteResearchStore } from '../stores/SQLiteResearchStore.js';
import type { ResearchDocument } from '../stores/ResearchWorkspace.js';
import type { FileService } from './FileService.js';
import { PdfService } from './PdfService.js';
import { readResearchPdf } from './ResearchSourceReader.js';

type Selection = { section: string } | { lines: string } | { pages: string };

function range(value: string): [number, number] {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value);
  const first = Number(match?.[1]);
  const last = Number(match?.[2] ?? match?.[1]);
  if (!first || !last || !Number.isSafeInteger(last) || last < first) throw new Error('Expected a range such as 4 or 4-7');
  return [first, last];
}

function sectionRange(lines: string[], name: string): [number, number] {
  const headings: { index: number; level: number; name: string }[] = [];
  let fence: string | undefined;
  for (const [index, value] of lines.entries()) {
    const marker = /^\s{0,3}(```|~~~)/.exec(value)?.[1];
    if (marker && (!fence || fence === marker)) {
      fence = fence ? undefined : marker;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(value);
    if (heading) headings.push({ index, level: heading[1].length, name: heading[2] });
  }
  const match = headings.filter(heading => heading.name.toLowerCase() === name.trim().toLowerCase());
  if (match.length !== 1) throw new Error(match.length ? 'Section title is ambiguous. Use a line range.' : 'Section was not found');
  const [{ index, level }] = match;
  return [index, headings.find(heading => heading.index > index && heading.level <= level)?.index ?? lines.length];
}

function documentBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.trim().split(/\r?\n/)) {
    const marker = /^\s{0,3}(```|~~~)/.exec(line)?.[1];
    if (marker && (!fence || marker === fence)) fence = fence ? undefined : marker;
    if (!fence && !line.trim()) {
      if (current.length) blocks.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}

export class ResearchDocuments {
  private readonly pdf = new PdfService();

  constructor(private readonly store: SQLiteResearchStore, private readonly files: FileService) {}

  list(sessionId: string) {
    return this.store.workspace.listDocuments(sessionId);
  }

  get(sessionId: string, id: string, revision?: number): ResearchDocument {
    const document = this.store.workspace.getDocument(sessionId, id, revision);
    if (!document) throw new Error('Document or revision was not found in this mission');
    return document;
  }

  history(sessionId: string, id: string) {
    this.get(sessionId, id);
    return this.store.workspace.history(sessionId, id);
  }

  correctionNotices(document: ResearchDocument): string[] {
    const state = this.store.workspace.getState(document.sessionId);
    return (state?.claims ?? []).flatMap(claim => {
      if (!document.markdown.includes(claim.id)) return [];
      if (claim.supersededBy && !document.markdown.includes(claim.supersededBy)) {
        return [`${claim.id} has a corrected finding in ${claim.supersededBy}. Inspect the latest research briefing.`];
      }
      if (claim.verdict === 'under-review') return [`${claim.id} is being fact-checked.`];
      return [];
    });
  }

  async create(sessionId: string, title: string, markdown?: string): Promise<ResearchDocument> {
    if (!await this.store.getSession(sessionId)) throw new Error('Research mission was not found');
    const clean = title.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Document title is required');
    const contents = markdown ?? `# ${clean}\n`;
    this.validateCitations(sessionId, contents);
    return this.store.workspace.createDocument(sessionId, clean, contents);
  }

  async importFile(sessionId: string, path: string, pages?: string): Promise<ResearchDocument> {
    const ext = extname(path).toLowerCase();
    if (!['.pdf', '.md', '.markdown', '.txt'].includes(ext)) throw new Error('Import a PDF, Markdown, or text file');
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let data: Buffer;
    try {
      const info = await file.stat();
      const limit = 8 * 1024 * 1024;
      if (!info.isFile() || info.size > limit) throw new Error('Import requires a regular file up to 8 MiB');
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      data = buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    const name = basename(path);
    let markdown = data.toString('utf8');
    if (ext === '.pdf') {
      const extracted = await readResearchPdf(data, AbortSignal.timeout(75_000));
      const rows = extracted.split('\f');
      if (!rows.at(-1)?.trim()) rows.pop();
      const [first, last] = pages ? range(pages) : [1, rows.length];
      if (last > rows.length) throw new Error('Requested pages are outside the extracted PDF');
      markdown = rows.slice(first - 1, last).map((page, index) => `## Page ${first + index}\n\n${page.trim()}`).join('\n\n');
    } else if (pages) throw new Error('Page selection applies to PDF imports');
    if (!markdown.trim()) throw new Error('No readable material found');
    return this.create(sessionId, name, `# ${name}\n\nImported source file: ${name}\n\n${markdown.trim()}\n`);
  }

  append(sessionId: string, id: string, content: string, section?: string): ResearchDocument {
    const document = this.get(sessionId, id);
    if (!content.trim()) throw new Error('Content to append is required');
    const lines = document.markdown.split(/\r?\n/);
    const offset = section ? sectionRange(lines, section)[1] : lines.length;
    lines.splice(offset, 0, '', content.trim(), '');
    return this.revise(document, lines.join('\n'), 'user append');
  }

  merge(sessionId: string, target: string, sources: string[], apply: boolean) {
    const document = this.get(sessionId, target);
    const known = new Set<string>();
    const combine = (body: string) => documentBlocks(body).filter(block => {
      const key = block.trim();
      if (!key || known.has(key)) return false;
      known.add(key);
      return true;
    });
    const merged = combine(document.markdown);
    for (const spec of new Set(sources)) {
      const [id, section] = spec.split('#', 2);
      if (id === target) throw new Error('Choose source documents other than the merge target');
      const source = this.get(sessionId, id);
      const sourceLines = source.markdown.split(/\r?\n/);
      const content = section ? sourceLines.slice(...sectionRange(sourceLines, section)).join('\n') : source.markdown;
      merged.push(...combine(content));
    }
    if (!sources.length) throw new Error('Provide at least one source document');
    const markdown = merged.join('\n\n') + '\n';
    this.validateCitations(sessionId, markdown);
    return { markdown, document: apply ? this.revise(document, markdown, 'user merge') : document };
  }

  trim(sessionId: string, id: string, selection: Selection, replacement: string, apply: boolean) {
    const document = this.get(sessionId, id);
    const lines = document.markdown.split(/\r?\n/);
    let selected: Set<number>;
    if ('pages' in selection) {
      selected = this.pdf.sourceLinesForPages(document.markdown, ...range(selection.pages), 'research');
    } else {
      const [first, last] = 'section' in selection ? sectionRange(lines, selection.section) : range(selection.lines);
      const start = 'section' in selection ? first : first - 1;
      if (last > lines.length) throw new Error(`This revision has ${lines.length} lines`);
      selected = new Set(Array.from({ length: last - start }, (_, offset) => start + offset));
    }
    if (!selected.size) throw new Error('There is no editable text in that selection');
    const first = Math.min(...selected);
    const markdown = lines.flatMap((line, index) => selected.has(index)
      ? index === first && replacement.trim() ? [replacement] : []
      : [line]).join('\n');
    if (apply) this.revise(document, markdown, 'user trim');
    return { markdown, removed: lines.filter((_line, index) => selected.has(index)).join('\n') };
  }

  restore(sessionId: string, id: string, revision: number): ResearchDocument {
    return this.revise(this.get(sessionId, id), this.get(sessionId, id, revision).markdown, `restored revision ${revision}`);
  }

  async export(sessionId: string, id: string, formats: string[], revision?: number): Promise<string[]> {
    const document = this.get(sessionId, id, revision);
    this.validateCitations(sessionId, document.markdown);
    const name = `Research_${sessionId}_${id}_r${document.revision}`;
    const paths: string[] = [];
    if (!formats.length || formats.some(format => format !== 'md' && format !== 'pdf')) throw new Error('Choose md, pdf, or md,pdf');
    if (formats.includes('md')) paths.push((await this.files.createMarkdown(name, document.markdown)).path);
    if (formats.includes('pdf')) paths.push((await this.files.createPdf(name, document.markdown, undefined, document.title, 'research')).path);
    return paths;
  }

  async bundle(sessionId: string): Promise<string> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('Research mission was not found');
    const documents = this.list(sessionId);
    const data = {
      version: 1, session, research: this.store.workspace.getState(sessionId), documents,
      revisions: Object.fromEntries(documents.map(doc => [doc.id, this.history(sessionId, doc.id)
        .map(item => this.get(sessionId, doc.id, item.revision))])),
    };
    return (await this.files.writeFile(`Research_${sessionId}_${Date.now()}.research.json`, JSON.stringify(data, null, 2))).path;
  }

  private revise(document: ResearchDocument, markdown: string, operation: string): ResearchDocument {
    this.validateCitations(document.sessionId, markdown);
    return this.store.workspace.reviseDocument(document, markdown, operation);
  }

  private validateCitations(sessionId: string, markdown: string): void {
    const matches = [...markdown.matchAll(/\[(src_[\da-f]+)\]\(<([^>]+)>\)/gi)];
    if (!matches.length) return;
    const sources = this.store.workspace.getState(sessionId)?.sources ?? [];
    for (const [, id, url] of matches) {
      if (!sources.some(source => source.id === id && source.url === url && !source.error)) {
        throw new Error(`Research citation ${id} has no matching retrieved source`);
      }
    }
  }
}
