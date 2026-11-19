import type { Middleware } from './pipeline.js';
import type { FileService } from '../services/FileService.js';

export const FILE_TOOLS_CATALOGUE = `
## Document & File Creation Capabilities (Host System Access)
You have direct native execution capabilities to create and compile documents on the host machine without external tools.

CRITICAL INSTRUCTIONS:
- You CAN and MUST create files and compile PDFs on the user's host when requested.
- NEVER say you cannot create, write, save, or compile files or PDFs.
- When the user asks to save, compile, or create a PDF report, document, or file, you MUST emit the appropriate \`\`\`pdf_create or \`\`\`file_write block in your response.

1. **PDF Generation**:
To compile a formatted PDF document, emit a \`\`\`pdf_create block:
\`\`\`pdf_create
{
  "filename": "quantum_brief.pdf",
  "title": "Document Title",
  "markdown": "# Title\\n\\nFormatted content goes here..."
}
\`\`\`

2. **File Writing (Markdown / Code / Text)**:
To create, save, or write a markdown note or code file, emit a \`\`\`file_write block:
\`\`\`file_write
{
  "path": "documents/notes.md",
  "content": "# Notes\\n\\nContent goes here..."
}
\`\`\`
`;

/**
 * Pre-LLM middleware to inject file & PDF creation instructions into system prompt.
 */
export function filePromptMiddleware(): Middleware {
  return async (ctx, next) => {
    const sysIndex = ctx.messages.findIndex((m) => m.role === 'system');
    if (sysIndex >= 0) {
      ctx.messages[sysIndex].content += `\n\n${FILE_TOOLS_CATALOGUE}`;
    } else {
      ctx.messages.unshift({ role: 'system', content: FILE_TOOLS_CATALOGUE });
    }
    await next();
  };
}

/**
 * Post-LLM middleware to execute file & PDF actions.
 */
export function fileActionMiddleware(fileService: FileService): Middleware {
  return async (ctx, next) => {
    if (ctx.response) {
      // 1. Process PDF creation
      const pdfRegex = /```pdf_create\s*\n([\s\S]*?)\n```/;
      const pdfMatch = ctx.response.match(pdfRegex);
      if (pdfMatch) {
        try {
          const payload = JSON.parse(pdfMatch[1]);
          const filename = payload.filename || 'document.pdf';
          const markdown = payload.markdown || payload.content || '';
          const title = payload.title || undefined;

          console.log(`[file-service] Compiling PDF document: ${filename}`);
          const result = await fileService.createPdf(filename, markdown, undefined, title);

          const confirmation = `\n\n📄 **Document Generated**: \`${result.path}\` (${(result.size / 1024).toFixed(1)} KB)\n`;
          ctx.response = ctx.response.replace(pdfRegex, confirmation).trim();
          ctx.metadata.fileCreated = result;
        } catch (err: any) {
          console.error(`[file-service] PDF generation failed: ${err.message}`);
          ctx.response = ctx.response.replace(pdfRegex, `\n\n⚠️ Failed to compile PDF: ${err.message}\n`).trim();
        }
      }

      // 2. Process File write
      const fileRegex = /```file_write\s*\n([\s\S]*?)\n```/;
      const fileMatch = ctx.response.match(fileRegex);
      if (fileMatch) {
        try {
          const payload = JSON.parse(fileMatch[1]);
          const filePath = payload.path || payload.filename || 'note.md';
          const content = payload.content || '';

          console.log(`[file-service] Writing file to disk: ${filePath}`);
          const result = await fileService.writeFile(filePath, content);

          const confirmation = `\n\n📝 **File Created**: \`${result.path}\` (${result.size} bytes)\n`;
          ctx.response = ctx.response.replace(fileRegex, confirmation).trim();
          ctx.metadata.fileCreated = result;
        } catch (err: any) {
          console.error(`[file-service] File write failed: ${err.message}`);
          ctx.response = ctx.response.replace(fileRegex, `\n\n⚠️ Failed to write file: ${err.message}\n`).trim();
        }
      }
    }

    await next();
  };
}
