import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface PdfOptions {
  title?: string;
  author?: string;
  margin?: number;
  fontSize?: number;
}

interface TextBlock {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'bullet' | 'code' | 'hr';
  text: string;
}

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
  generatePdfBuffer(markdown: string, options: PdfOptions = {}): Buffer {
    const title = options.title || 'J.A.R.V.I.S Document';
    const author = options.author || 'J.A.R.V.I.S';
    const margin = options.margin ?? 54; // 0.75 in = 54 pt
    const pageWidth = 612; // Standard Letter width (points)
    const pageHeight = 792; // Standard Letter height (points)
    const printableWidth = pageWidth - margin * 2;

    const blocks = this.parseMarkdown(markdown);

    // Layout blocks into pages
    const pages: string[][] = [[]];
    let currentPage = 0;
    let currentY = pageHeight - margin - 20; // Top margin

    const newPage = () => {
      pages.push([]);
      currentPage++;
      currentY = pageHeight - margin - 20;
    };

    for (const block of blocks) {
      if (block.type === 'hr') {
        if (currentY < margin + 40) newPage();
        currentY -= 10;
        // Draw horizontal line
        pages[currentPage].push(
          `q 0.5 w 0.8 0.8 0.8 RG ${margin} ${currentY} m ${pageWidth - margin} ${currentY} l S Q`
        );
        currentY -= 15;
        continue;
      }

      let font = '/F1'; // Helvetica
      let size = 10.5;
      let leading = 14;
      let color = '0.15 0.15 0.15 rg'; // dark charcoal
      let indent = 0;

      if (block.type === 'h1') {
        font = '/F2'; // Helvetica-Bold
        size = 18;
        leading = 24;
        color = '0.05 0.1 0.25 rg'; // Navy
        currentY -= 8;
      } else if (block.type === 'h2') {
        font = '/F2';
        size = 14;
        leading = 19;
        color = '0.1 0.2 0.35 rg';
        currentY -= 6;
      } else if (block.type === 'h3') {
        font = '/F2';
        size = 12;
        leading = 16;
        color = '0.15 0.25 0.4 rg';
        currentY -= 4;
      } else if (block.type === 'bullet') {
        indent = 16;
      } else if (block.type === 'code') {
        font = '/F3'; // Courier
        size = 9;
        leading = 12;
        color = '0.2 0.2 0.25 rg';
        indent = 12;
      }

      // Wrap text
      const maxCharsPerLine = Math.floor((printableWidth - indent) / (size * 0.52));
      const lines = this.wrapText(block.text, maxCharsPerLine);

      for (let i = 0; i < lines.length; i++) {
        if (currentY < margin + 40) {
          newPage();
        }

        const line = lines[i];
        const xPos = margin + indent;

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

        currentY -= leading;
      }

      currentY -= 5; // Paragraph spacing
    }

    // Add header & footer to each page
    const totalPages = pages.length;
    for (let p = 0; p < totalPages; p++) {
      // Header: Document title & subtle divider
      const headerTitle = this.escapePdfText(title);
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
    return this.buildPdfObjects(pages, pageWidth, pageHeight, title, author);
  }

  private parseMarkdown(md: string): TextBlock[] {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const blocks: TextBlock[] = [];
    let inCodeBlock = false;
    let codeBuffer: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('```')) {
        if (inCodeBlock) {
          inCodeBlock = false;
          blocks.push({ type: 'code', text: codeBuffer.join('\n') });
          codeBuffer = [];
        } else {
          inCodeBlock = true;
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
        blocks.push({ type: 'hr', text: '' });
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
          .map((c) => this.stripMarkdownSymbols(c.trim()))
          .filter(Boolean);
        if (cells.length > 0) {
          const rowText = cells.join('  |  ');
          blocks.push({ type: 'bullet', text: rowText });
          continue;
        }
      }

      // Headers
      if (trimmed.startsWith('# ')) {
        blocks.push({ type: 'h1', text: trimmed.slice(2).trim() });
      } else if (trimmed.startsWith('## ')) {
        blocks.push({ type: 'h2', text: trimmed.slice(3).trim() });
      } else if (trimmed.startsWith('### ')) {
        blocks.push({ type: 'h3', text: trimmed.slice(4).trim() });
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
        const text = trimmed.replace(/^[-*]\s+|\d+\.\s+/, '');
        blocks.push({ type: 'bullet', text: this.stripMarkdownSymbols(text) });
      } else {
        blocks.push({ type: 'p', text: this.stripMarkdownSymbols(trimmed) });
      }
    }

    if (inCodeBlock && codeBuffer.length > 0) {
      blocks.push({ type: 'code', text: codeBuffer.join('\n') });
    }

    return blocks;
  }

  private stripMarkdownSymbols(text: string): string {
    return text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/~~(.*?)~~/g, '$1');
  }

  private wrapText(text: string, maxChars: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
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
    author: string
  ): Buffer {
    const numPages = pages.length;
    // Objects:
    // 1: Catalog
    // 2: Outlines
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

    // Catalog & Outlines & Pages
    objects.push({ id: 1, data: `<< /Type /Catalog /Pages 3 0 R /Outlines 2 0 R >>` });
    objects.push({ id: 2, data: `<< /Type /Outlines /Count 0 >>` });
    objects.push({
      id: 3,
      data: `<< /Type /Pages /Kids [${pageKids.join(' ')}] /Count ${numPages} >>`,
    });

    // Page Objects
    for (let i = 0; i < numPages; i++) {
      const contentId = contentStartId + i;
      objects.push({
        id: 4 + i,
        data: `<< /Type /Page /Parent 3 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${font1Id} 0 R /F2 ${font2Id} 0 R /F3 ${font3Id} 0 R >> >> >>`,
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
