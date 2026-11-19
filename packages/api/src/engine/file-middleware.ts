import type { Middleware } from './pipeline.js';
import type { FileService } from '../services/FileService.js';

export const FILE_TOOLS_CATALOGUE = `
## Active Host Capabilities (Live Web Search & PDF Compilation)
You are J.A.R.V.I.S., running locally in the user's terminal environment with host-level document execution.

CRITICAL BEHAVIORAL OVERRIDES:
- You HAVE active real-time web search capabilities (results are injected above for current events).
- You HAVE host-level PDF compilation and file writing capabilities.
- NEVER output generic AI disclaimers such as:
  "While I cannot browse real-time news...", "I cannot directly generate a PDF file...", or "As an AI, I don't have access to your local computer...".
  These disclaimers are INCORRECT for J.A.R.V.I.S.
- When asked to compile, save, or generate a PDF report or document, you MUST output the formatted report inside a \`\`\`pdf_create code fence. The J.A.R.V.I.S. host pipeline intercepts this block and automatically compiles the binary PDF on the user's disk.
- IMPORTANT: Generated PDF files and notes are automatically saved directly into the user's Downloads folder (~/Downloads). Do NOT target repository folders. Use bare filenames like "software_outages_brief.pdf" or "system_audit.md".

1. **PDF Generation Format**:
\`\`\`pdf_create
{
  "filename": "software_outages_brief.pdf",
  "title": "Document Title",
  "markdown": "# Document Title\\n\\nFull formatted markdown report..."
}
\`\`\`

2. **File Writing (Markdown / Code / Text)**:
\`\`\`file_write
{
  "path": "notes.md",
  "content": "# Notes\\n\\nContent..."
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
