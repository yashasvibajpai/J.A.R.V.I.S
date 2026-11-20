import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface PdfOptions {
  title?: string;
  author?: string;
  margin?: number;
  fontSize?: number;
  theme?: 'research';
}

interface TextBlock {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'bullet' | 'code' | 'hr' | 'quote' | 'evidence';
  text: string;
  sourceLines?: number[];
  url?: string;
  label?: EvidenceLabel;
  citations?: { label: string; url: string }[];
}

const evidenceColors = {
  'Corroborated': { accent: '0.08 0.39 0.27', fill: '0.88 0.95 0.91' },
  'Single source': { accent: '0.47 0.30 0.04', fill: '0.98 0.93 0.83' },
  'Mixed evidence': { accent: '0.42 0.25 0.54', fill: '0.95 0.91 0.98' },
  'Disputed': { accent: '0.55 0.20 0.24', fill: '0.99 0.91 0.91' },
  'Under review': { accent: '0.27 0.36 0.46', fill: '0.91 0.94 0.97' },
  'Insufficient evidence': { accent: '0.35 0.36 0.40', fill: '0.93 0.94 0.96' },
  'Interpretation': { accent: '0.18 0.34 0.60', fill: '0.89 0.93 0.99' },
};
type EvidenceLabel = keyof typeof evidenceColors;

/**
 * PdfService — Zero-Dependency Professional PDF Document Generator
 *
 * Implements PDF 1.4 specification compliant document rendering with:
 * - Multi-page pagination
 * - Word wrapping
 * - Standard Type 1 PostScript fonts (Helvetica, Helvetica-Bold, Courier)
 * - Headers, Footers, Bullet Points, Dividers & Code Blocks
 * - Strict Unicode-to-WinAnsi sanitization to eliminate mojibake/gibberish symbols
 */
export class PdfService {
  /**
   * Converts markdown text into a formatted PDF file and saves to disk.
   */
  async markdownToPdf(markdown: string, outputPath: string, options: PdfOptions = {}): Promise<string> {
    const pdfBuffer = this.generatePdfBuffer(markdown, options);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, pdfBuffer);
    return outputPath;
  }

  /**
   * Sanitizes text to pure single-byte ASCII compatible with WinAnsiEncoding Type-1 PDF fonts.
   * Eliminates UTF-8 multi-byte mojibake (e.g. â€¢, â€”, â€œ, â€™).
   */
  sanitizePdfText(text: string): string {
    return text
      // Normalize newlines and tabs to single spaces
      .replace(/\r\n|\r|\n/g, ' ')
      .replace(/\t/g, ' ')
      // Strip HTML tags & unescape common HTML entities
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      // Normalize non-breaking and thin spaces
      .replace(/[\u00A0\u202F\u2000-\u200A\u3000]/g, ' ')
      // Remove zero-width characters and byte-order marks
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      // Non-breaking hyphens, soft hyphens & minus signs
      .replace(/[\u2010\u2011]/g, '-')
      .replace(/\u00AD/g, '')
      .replace(/\u2212/g, '-')
      // En-dash and em-dash
      .replace(/\u2013/g, '-')
      .replace(/[\u2014\u2015]/g, ' - ')
      .replace(/\u00b7/g, ' / ')
      // Smart double quotes -> standard double quote
      .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
      // Smart single quotes & apostrophes -> standard single quote
      .replace(/[\u2018\u2019\u201A\u2039\u203A\u0060\u00B4\u2032]/g, "'")
      .replace(/\u2033/g, '"')
      // Bullets & ellipsis in text
      .replace(/[\u2022\u2023\u25E6\u25AA\u25AB\u2219]/g, '*')
      .replace(/\u2026/g, '...')
      // Trademarks & copyrights
      .replace(/\u2122/g, '(TM)')
      .replace(/\u00A9/g, '(C)')
      .replace(/\u00AE/g, '(R)')
      // Common status symbols and arrows
      .replace(/[\u{1F6A8}\u{26A0}\u{2757}]/gu, '[!]')
      .replace(/[\u{2713}\u{2714}\u{2705}]/gu, '[OK]')
      .replace(/[\u{274C}\u{2717}\u{2718}]/gu, '[X]')
      .replace(/[\u{2139}\u{FE0F}]/gu, '[i]')
      .replace(/[\u{26A1}\u{1F525}]/gu, '*')
      .replace(/[\u{2192}\u{2794}\u{279C}]/gu, '->')
      .replace(/[\u{2190}]/gu, '<-')
      .replace(/[\u{2194}]/gu, '<->')
      // Strip remaining emojis and pictographs
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
      // Transliterate accented letters to base Latin (e.g. é -> e, ü -> u)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      // Strip control characters
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // Remove LLM citation markers e.g. 【4:0†source】
      .replace(/【[^】]*】/g, '')
      // Restrict strictly to ASCII printable characters (0x20 - 0x7E)
      .replace(/[^\x20-\x7E]/g, '')
      // Collapse multiple spaces
      .replace(/ +/g, ' ')
      .trim();
  }

  /**
   * Generates a raw Buffer containing a valid PDF 1.4 document.
   */
  generatePdfBuffer(markdown: string, options: PdfOptions = {}, onBlock?: (page: number, sourceLines: number[]) => void): Buffer {
    const title = options.title || 'J.A.R.V.I.S Document';
    const author = options.author || 'J.A.R.V.I.S';
    const margin = options.margin ?? 54; // 0.75 in = 54 pt
    const pageWidth = 612; // Standard Letter width (points)
    const pageHeight = 792; // Standard Letter height (points)
    const printableWidth = pageWidth - margin * 2;

    const research = options.theme === 'research';
    const blocks = this.parseMarkdown(markdown, research);

    // Layout blocks into pages
    const pages: string[][] = [[]];
    const annotations: { url: string; rect: string }[][] = [[]];
    let currentPage = 0;
    let currentY = pageHeight - margin - 20; // Top margin

    const newPage = () => {
      pages.push([]);
      annotations.push([]);
      currentPage++;
      currentY = pageHeight - margin - 20;
    };

    for (const block of blocks) {
      if (block.type === 'evidence' && block.label) {
        const { accent, fill } = evidenceColors[block.label];
        const lines = this.wrapText(block.text, Math.floor((printableWidth - 34) / 6.1));
        const citations = block.citations ?? [];
        const height = 40 + lines.length * 16 + (citations.length ? 18 : 0);
        if (currentY - height < margin + 10) newPage();
        if (block.sourceLines) onBlock?.(currentPage + 1, block.sourceLines);
        const canvas = pages[currentPage];
        const top = currentY + 8;
        const left = margin + 14;
        const badgeText = block.label.toUpperCase();
        canvas.push(
          `q 0.97 0.98 0.99 rg ${margin} ${top - height} ${printableWidth} ${height} re f Q`,
          `q ${accent} rg ${margin} ${top - height} 3 ${height} re f Q`,
          `q ${fill} rg ${left} ${top - 23} ${badgeText.length * 5.25 + 16} 14 re f Q`,
          `BT /F2 8 Tf ${accent} rg ${left + 8} ${top - 19} Td (${this.escapePdfText(badgeText)}) Tj ET`,
        );
        for (const [index, line] of lines.entries()) {
          canvas.push(`BT /F1 11 Tf 0.11 0.17 0.24 rg ${left} ${top - 40 - index * 16} Td (${this.escapePdfText(line)}) Tj ET`);
        }
        const y = top - height + 13;
        let x = left;
        for (const citation of citations) {
          const width = citation.label.length * 6 + 10;
          if (x + width > pageWidth - margin - 8) break;
          canvas.push(`BT /F2 9 Tf 0.07 0.35 0.58 rg ${x} ${y} Td (${this.escapePdfText(citation.label)}) Tj ET`);
          annotations[currentPage].push({ url: citation.url, rect: `${x - 1} ${y - 3} ${x + width - 6} ${y + 9}` });
          x += width + 7;
        }
        currentY = top - height - 17;
        continue;
      }

      if (block.type === 'hr') {
        if (currentY < margin + 40) newPage();
        if (block.sourceLines) onBlock?.(currentPage + 1, block.sourceLines);
        currentY -= 10;
        // Draw horizontal line
        pages[currentPage].push(
          `q 0.5 w 0.8 0.8 0.8 RG ${margin} ${currentY} m ${pageWidth - margin} ${currentY} l S Q`
        );
        currentY -= 15;
        continue;
      }

      let font = '/F1'; // Helvetica
      let size = options.fontSize ?? 10.5;
      let leading = research ? 16 : 14;
      let color = '0.15 0.15 0.15 rg'; // dark charcoal
      let indent = 0;

      if (block.type === 'h1') {
        font = '/F2'; // Helvetica-Bold
        size = research ? 24 : 18;
        leading = research ? 30 : 24;
        color = research ? '1 1 1 rg' : '0.05 0.1 0.25 rg';
        if (research) indent = 15;
        currentY -= 8;
      } else if (block.type === 'h2') {
        font = '/F2';
        size = 14;
        leading = 19;
        color = research ? '0.03 0.31 0.34 rg' : '0.1 0.2 0.35 rg';
        if (research) indent = 11;
        currentY -= 6;
      } else if (block.type === 'h3') {
        font = '/F2';
        size = 12;
        leading = 16;
        color = '0.15 0.25 0.4 rg';
        currentY -= 4;
      } else if (block.type === 'bullet') {
        indent = 16;
      } else if (block.type === 'quote') {
        indent = 13;
        size = 10;
        leading = 15;
        color = '0.08 0.32 0.37 rg';
      } else if (block.type === 'code') {
        font = '/F3'; // Courier
        size = 9;
        leading = 12;
        color = '0.2 0.2 0.25 rg';
        indent = 12;
      }

      // Wrap text
      const maxCharsPerLine = Math.max(12, Math.floor((printableWidth - indent * (research ? 2 : 1)) / (size * (research ? 0.57 : 0.52))));
      const lines = this.wrapText(block.text, maxCharsPerLine);
      if (research && ['h1', 'h2', 'h3'].includes(block.type)) {
        const height = leading * lines.length;
        if (currentY - Math.min(height, 300) < margin + 55) newPage();
        if (block.type === 'h1' || block.type === 'h2') {
          const tone = block.type === 'h1' ? '0.05 0.13 0.24' : '0.89 0.95 0.95';
          pages[currentPage].push(`q ${tone} rg ${margin} ${currentY - height + leading - 10} ${printableWidth} ${height + 11} re f Q`);
        }
      }

      for (let i = 0; i < lines.length; i++) {
        if (currentY < margin + 40) {
          newPage();
        }
        if (block.sourceLines) onBlock?.(currentPage + 1, block.sourceLines);

        const line = lines[i];
        const xPos = margin + indent;
        if (research && block.type === 'quote') {
          pages[currentPage].push(`q 0.12 0.55 0.55 rg ${margin} ${currentY - 4} 3 ${leading} re f Q`);
        }

        if (block.type === 'bullet' && i === 0) {
          // Draw standard bullet using WinAnsi octal escape \225
          pages[currentPage].push(
            `BT /F2 ${size} Tf 0.2 0.4 0.8 rg ${margin + 4} ${currentY} Td (\\225 ) Tj ET`
          );
        }

        const escaped = this.escapePdfText(line);
        pages[currentPage].push(
          `BT ${font} ${size} Tf ${color} ${xPos} ${currentY} Td (${escaped}) Tj ET`
        );
        if (block.url) annotations[currentPage].push({
          url: block.url, rect: `${xPos} ${currentY - 3} ${pageWidth - margin} ${currentY + size}`,
        });

        currentY -= leading;
      }

      currentY -= 5; // Paragraph spacing
    }

    // Add header & footer to each page
    const totalPages = pages.length;
    for (let p = 0; p < totalPages; p++) {
      if (research) pages[p].unshift(`q 1 1 1 rg 0 0 ${pageWidth} ${pageHeight} re f Q`);
      // Header: Document title & subtle divider
      const headerTitle = this.escapePdfText(research ? 'J.A.R.V.I.S.  /  RESEARCH BRIEFING' : title);
      if (research) pages[p].push(`q 0.12 0.55 0.55 rg 0 ${pageHeight - 7} ${pageWidth} 7 re f Q`);
      pages[p].push(
        `BT /F1 8 Tf 0.5 0.5 0.5 rg ${margin} ${pageHeight - margin + 12} Td (${headerTitle}) Tj ET`,
        `q 0.25 w 0.85 0.85 0.85 RG ${margin} ${pageHeight - margin + 8} m ${pageWidth - margin} ${pageHeight - margin + 8} l S Q`
      );

      // Footer: Page count & J.A.R.V.I.S branding
      const pageInfo = this.escapePdfText(`Page ${p + 1} of ${totalPages}`);
      const footerBrand = this.escapePdfText('Generated by J.A.R.V.I.S');
      pages[p].push(
        `q 0.25 w 0.85 0.85 0.85 RG ${margin} ${margin - 10} m ${pageWidth - margin} ${margin - 10} l S Q`,
        `BT /F1 8 Tf 0.5 0.5 0.5 rg ${margin} ${margin - 22} Td (${footerBrand}) Tj ET`,
        `BT /F1 8 Tf 0.5 0.5 0.5 rg ${pageWidth - margin - 60} ${margin - 22} Td (${pageInfo}) Tj ET`
      );
    }

    // Compile into PDF 1.4 document stream
    return this.buildPdfObjects(pages, pageWidth, pageHeight, title, author, annotations);
  }

  sourceLinesForPages(markdown: string, first: number, last: number, theme?: PdfOptions['theme']): Set<number> {
    const selected = new Set<number>();
    let pages = 1;
    this.generatePdfBuffer(markdown, { theme }, (page, lines) => {
      pages = Math.max(page, pages);
      if (page >= first && page <= last) lines.forEach(line => selected.add(line));
    });
    if (last > pages) throw new Error(`This revision has ${pages} PDF page(s)`);
    return selected;
  }

  private parseMarkdown(md: string, research = false): TextBlock[] {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const blocks: TextBlock[] = [];
    let inCodeBlock = false;
    let codeBuffer: string[] = [];

    let fenceStart = 0;
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      const links = research ? [...trimmed.matchAll(/\[([^\]]+)\]\(<(https?:\/\/[^>\s]+)>\)/gi)] : [];
      const add = (type: TextBlock['type'], text: string, start = index) => blocks.push({
        type, text, url: links.length === 1 ? links[0][2] : undefined,
        sourceLines: Array.from({ length: index - start + 1 }, (_, offset) => start + offset),
      });
      const format = (value: string) => this.stripMarkdownSymbols(value, research);

      if (trimmed.startsWith('```')) {
        if (inCodeBlock) {
          inCodeBlock = false;
          add('code', codeBuffer.join('\n'), fenceStart);
          codeBuffer = [];
        } else {
          inCodeBlock = true;
          fenceStart = index;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBuffer.push(line);
        continue;
      }

      if (!trimmed) continue;

      // Dividers
      if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
        add('hr', '');
        continue;
      }

      // Markdown table separator: skip |---|---|
      if (/^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(trimmed)) {
        continue;
      }

      // Markdown table row: format cleanly as bullet items
      if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|')) {
        const cells = trimmed
          .split('|')
          .map((c) => format(c.trim()))
          .filter(Boolean);
        if (cells.length > 0) {
          const rowText = cells.join('  |  ');
          add('bullet', rowText);
          continue;
        }
      }

      // Headers
      if (trimmed.startsWith('# ')) {
        const title = format(trimmed.slice(2).trim());
        add('h1', research && title.length > 215 ? title.slice(0, 212).trimEnd() + '...' : title);
      } else if (trimmed.startsWith('## ')) {
        add('h2', format(trimmed.slice(3).trim()));
      } else if (trimmed.startsWith('### ')) {
        add('h3', format(trimmed.slice(4).trim()));
      } else if (research && trimmed.startsWith('> ')) {
        const badge = /^> \*\*([^*]+)\*\*\s+(.+)$/.exec(trimmed);
        if (badge && Object.hasOwn(evidenceColors, badge[1]) && badge[2].length < 1600) {
          const body = badge[2].replace(/\[[^\]]+\]\(<https?:\/\/[^>\s]+>\)/gi, '').replace(/(?:\s+·\s*)+$/, '').trim();
          blocks.push({
            type: 'evidence', label: badge[1] as EvidenceLabel, text: format(body), sourceLines: [index],
            citations: links.slice(0, 4).map(link => ({ label: format(link[1]).slice(0, 22), url: link[2] })),
          });
        } else {
          add('quote', format(trimmed.slice(2)));
        }
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
        const text = trimmed.replace(/^[-*]\s+|\d+\.\s+/, '');
        add('bullet', format(text));
      } else {
        add('p', format(trimmed));
      }
    }

    if (inCodeBlock && codeBuffer.length > 0) {
      blocks.push({ type: 'code', text: codeBuffer.join('\n'), sourceLines: Array.from({ length: lines.length - fenceStart }, (_, index) => fenceStart + index) });
    }

    return blocks;
  }

  private stripMarkdownSymbols(text: string, compactLinks = false): string {
    return text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\(<([^>]+)>\)/g, compactLinks ? '$1' : '$1 ($2)')
      .replace(/\\([\\`*_[\]<>])/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/~~(.*?)~~/g, '$1');
  }

  private wrapText(text: string, maxChars: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words.flatMap(word => word.match(new RegExp(`.{1,${maxChars}}`, 'gu')) ?? [])) {
      if ((currentLine + ' ' + word).trim().length <= maxChars) {
        currentLine = (currentLine + ' ' + word).trim();
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [''];
  }

  private escapePdfText(text: string): string {
    const clean = this.sanitizePdfText(text);
    return clean
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  }

  private buildPdfObjects(
    pages: string[][],
    pageWidth: number,
    pageHeight: number,
    title: string,
    author: string,
    annotations: { url: string; rect: string }[][],
  ): Buffer {
    const numPages = pages.length;
    // Objects:
    // 1: Catalog
    // 2: Viewer preferences
    // 3: Pages
    // 4..4+numPages-1: Page objects
    // Font objects: F1 (Helvetica), F2 (Helvetica-Bold), F3 (Courier)
    const font1Id = 4 + numPages;
    const font2Id = font1Id + 1;
    const font3Id = font1Id + 2;
    const infoId = font1Id + 3;
    const contentStartId = infoId + 1;

    const pageKids = [];
    for (let i = 0; i < numPages; i++) {
      pageKids.push(`${4 + i} 0 R`);
    }

    const objects: { id: number; data: string }[] = [];

    objects.push({ id: 1, data: `<< /Type /Catalog /Pages 3 0 R /ViewerPreferences 2 0 R >>` });
    objects.push({ id: 2, data: '<< /DisplayDocTitle true >>' });
    objects.push({
      id: 3,
      data: `<< /Type /Pages /Kids [${pageKids.join(' ')}] /Count ${numPages} >>`,
    });

    // Page Objects
    let annotationId = contentStartId + numPages;
    for (let i = 0; i < numPages; i++) {
      const contentId = contentStartId + i;
      const refs = annotations[i].map(({ url, rect }) => {
        const id = annotationId++;
        objects.push({ id, data: `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /A << /S /URI /URI (${this.escapePdfText(url)}) >> >>` });
        return `${id} 0 R`;
      });
      objects.push({
        id: 4 + i,
        data: `<< /Type /Page /Parent 3 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${contentId} 0 R ${refs.length ? `/Annots [${refs.join(' ')}]` : ''} /Resources << /Font << /F1 ${font1Id} 0 R /F2 ${font2Id} 0 R /F3 ${font3Id} 0 R >> >> >>`,
      });
    }

    // Standard Type 1 Fonts
    objects.push({ id: font1Id, data: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>` });
    objects.push({ id: font2Id, data: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>` });
    objects.push({ id: font3Id, data: `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>` });

    // Info Metadata
    const safeTitle = this.escapePdfText(title);
    const safeAuthor = this.escapePdfText(author);
    objects.push({
      id: infoId,
      data: `<< /Title (${safeTitle}) /Author (${safeAuthor}) /Creator (J.A.R.V.I.S) /Producer (J.A.R.V.I.S Native PDF Engine) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`,
    });

    // Content Streams
    for (let i = 0; i < numPages; i++) {
      const stream = pages[i].join('\n');
      const streamLen = Buffer.byteLength(stream, 'latin1');
      objects.push({
        id: contentStartId + i,
        data: `<< /Length ${streamLen} >>\nstream\n${stream}\nendstream`,
      });
    }

    // Sort objects by id
    objects.sort((a, b) => a.id - b.id);

    let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets: number[] = [0]; // object 0

    for (const obj of objects) {
      offsets[obj.id] = Buffer.byteLength(pdf, 'latin1');
      pdf += `${obj.id} 0 obj\n${obj.data}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf, 'latin1');
    const totalObjs = objects.length + 1;
    let xref = `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
    for (let i = 1; i < totalObjs; i++) {
      xref += `${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`;
    }

    const trailer = `trailer\n<< /Size ${totalObjs} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(pdf + xref + trailer, 'latin1');
  }
}
