import { writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, basename, extname } from 'path';
import { PdfService } from './PdfService.js';

export interface FileWriteResult {
  path: string;
  filename: string;
  size: number;
  type: 'markdown' | 'pdf' | 'text' | 'code';
}

/**
 * FileService — Native Document & File Operations for JARVIS
 *
 * Provides capabilities to:
 * - Create and save Markdown documents (.md)
 * - Generate professional PDF documents (.pdf) from text or markdown
 * - Read and inspect files
 * - Save directly to workspace, documents directory, or Obsidian Vault
 */
export class FileService {
  private pdfService: PdfService;
  private defaultDocDir: string;
  private obsidianVaultPath?: string;

  constructor(defaultDocDir?: string) {
    this.pdfService = new PdfService();
    this.defaultDocDir = defaultDocDir || resolve(process.cwd(), 'documents');
    this.obsidianVaultPath = process.env.OBSIDIAN_VAULT_PATH;
  }

  /**
   * Save a markdown document to disk.
   */
  async createMarkdown(filename: string, content: string, targetDir?: string): Promise<FileWriteResult> {
    const cleanName = filename.endsWith('.md') ? filename : `${filename}.md`;
    let fullPath: string;
    if (targetDir) {
      fullPath = resolve(targetDir, cleanName);
    } else if (filename.includes('/') || filename.includes('\\')) {
      fullPath = resolve(process.cwd(), cleanName);
    } else {
      fullPath = resolve(this.defaultDocDir, cleanName);
    }

    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');

    const stats = statSync(fullPath);
    return {
      path: fullPath,
      filename: basename(fullPath),
      size: stats.size,
      type: 'markdown',
    };
  }

  /**
   * Generate and save a formatted PDF document from markdown or text.
   */
  async createPdf(
    filename: string,
    markdownContent: string,
    targetDir?: string,
    title?: string
  ): Promise<FileWriteResult> {
    const cleanName = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
    let fullPath: string;
    if (targetDir) {
      fullPath = resolve(targetDir, cleanName);
    } else if (filename.includes('/') || filename.includes('\\')) {
      fullPath = resolve(process.cwd(), cleanName);
    } else {
      fullPath = resolve(this.defaultDocDir, cleanName);
    }

    const docTitle = title || basename(cleanName, '.pdf').replace(/[-_]/g, ' ');
    await this.pdfService.markdownToPdf(markdownContent, fullPath, { title: docTitle });

    const stats = statSync(fullPath);
    return {
      path: fullPath,
      filename: basename(fullPath),
      size: stats.size,
      type: 'pdf',
    };
  }

  /**
   * Write any text or code file.
   */
  async writeFile(filePath: string, content: string): Promise<FileWriteResult> {
    const fullPath = resolve(process.cwd(), filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');

    const stats = statSync(fullPath);
    const ext = extname(fullPath).toLowerCase();
    const type = ext === '.md' ? 'markdown' : ext === '.pdf' ? 'pdf' : 'text';

    return {
      path: fullPath,
      filename: basename(fullPath),
      size: stats.size,
      type,
    };
  }

  /**
   * Save a note directly into the user's Obsidian Vault if configured.
   */
  async saveToObsidian(filename: string, content: string, subfolder = ''): Promise<FileWriteResult> {
    if (!this.obsidianVaultPath || !existsSync(this.obsidianVaultPath)) {
      throw new Error('Obsidian Vault path is not configured or does not exist on disk.');
    }

    const targetDir = subfolder
      ? resolve(this.obsidianVaultPath, subfolder)
      : this.obsidianVaultPath;

    return this.createMarkdown(filename, content, targetDir);
  }

  /**
   * Read file content.
   */
  readFile(filePath: string): string {
    const fullPath = resolve(process.cwd(), filePath);
    if (!existsSync(fullPath)) {
      throw new Error(`File does not exist: ${fullPath}`);
    }
    return readFileSync(fullPath, 'utf-8');
  }

  /**
   * List files in a directory.
   */
  listFiles(dirPath = '.'): Array<{ name: string; isDirectory: boolean; size: number }> {
    const fullPath = resolve(process.cwd(), dirPath);
    if (!existsSync(fullPath)) {
      throw new Error(`Directory does not exist: ${fullPath}`);
    }

    const entries = readdirSync(fullPath, { withFileTypes: true });
    return entries.map((entry) => {
      const entryPath = resolve(fullPath, entry.name);
      let size = 0;
      try {
        if (!entry.isDirectory()) {
          size = statSync(entryPath).size;
        }
      } catch {}

      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size,
      };
    });
  }
}
