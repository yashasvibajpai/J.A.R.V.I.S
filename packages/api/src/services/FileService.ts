import { writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, basename, extname, isAbsolute } from 'path';
import { homedir } from 'os';
import { PdfService, type PdfOptions } from './PdfService.js';

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
 * - Save directly to Downloads folder (never polluting repo directories) or Obsidian Vault
 */
export class FileService {
  private pdfService: PdfService;
  private defaultDocDir: string;
  private obsidianVaultPath?: string;

  constructor(defaultDocDir?: string) {
    this.pdfService = new PdfService();
    // Default destination is strictly the user's Downloads directory (~/Downloads)
    // to prevent cluttering or polluting repository workspace folders.
    this.defaultDocDir = defaultDocDir || resolve(homedir(), 'Downloads');
    this.obsidianVaultPath = process.env.OBSIDIAN_VAULT_PATH;
  }

  /**
   * Resolves target destination file path.
   * Redirects any repository-internal paths or relative paths to the user's Downloads directory.
   */
  private resolveTargetFile(filename: string, targetDir?: string): string {
    if (targetDir) {
      return resolve(targetDir, basename(filename));
    }

    if (isAbsolute(filename)) {
      // If an absolute path targets inside the repository workspace, redirect to Downloads
      if (filename.startsWith(process.cwd())) {
        return resolve(this.defaultDocDir, basename(filename));
      }
      return filename;
    }

    // Strip leading "documents/", "./documents/", or "./"
    const cleaned = filename
      .replace(/^(\.\/)?documents[\\/]/, '')
      .replace(/^(\.\/)+/, '');

    return resolve(this.defaultDocDir, cleaned);
  }

  /**
   * Save a markdown document to disk (defaults to ~/Downloads).
   */
  async createMarkdown(filename: string, content: string, targetDir?: string): Promise<FileWriteResult> {
    const cleanName = filename.endsWith('.md') ? filename : `${filename}.md`;
    const fullPath = this.resolveTargetFile(cleanName, targetDir);

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
   * Generate and save a formatted PDF document from markdown or text (defaults to ~/Downloads).
   */
  async createPdf(
    filename: string,
    markdownContent: string,
    targetDir?: string,
    title?: string,
    theme?: PdfOptions['theme'],
  ): Promise<FileWriteResult> {
    const cleanName = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
    const fullPath = this.resolveTargetFile(cleanName, targetDir);

    const docTitle = title || basename(cleanName, '.pdf').replace(/[-_]/g, ' ');
    await this.pdfService.markdownToPdf(markdownContent, fullPath, { title: docTitle, theme });

    const stats = statSync(fullPath);
    return {
      path: fullPath,
      filename: basename(fullPath),
      size: stats.size,
      type: 'pdf',
    };
  }

  /**
   * Write any text or code file (defaults to ~/Downloads).
   */
  async writeFile(filePath: string, content: string): Promise<FileWriteResult> {
    const fullPath = this.resolveTargetFile(filePath);
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
    let fullPath = filePath;
    if (!existsSync(fullPath)) {
      fullPath = this.resolveTargetFile(filePath);
    }
    if (!existsSync(fullPath)) {
      fullPath = resolve(process.cwd(), filePath);
    }
    if (!existsSync(fullPath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }
    return readFileSync(fullPath, 'utf-8');
  }

  /**
   * List files in a directory (defaults to ~/Downloads).
   */
  listFiles(dirPath?: string): Array<{ name: string; isDirectory: boolean; size: number }> {
    const target = dirPath
      ? (dirPath === 'documents' || dirPath === './documents' ? this.defaultDocDir : resolve(process.cwd(), dirPath))
      : this.defaultDocDir;

    if (!existsSync(target)) {
      return [];
    }

    const entries = readdirSync(target, { withFileTypes: true });
    return entries.map((entry) => {
      const entryPath = resolve(target, entry.name);
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
