import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { createHash } from 'crypto';
import type { LLMProvider, VectorStore } from '@jarvis/shared';
import { SQLiteSyncStore } from '../stores/SQLiteSyncStore.js';

export class ObsidianCrawler {
  private vaultPath: string;
  private llm: LLMProvider;
  private vectorStore: VectorStore;
  private syncStore: SQLiteSyncStore;

  constructor(vaultPath: string, llm: LLMProvider, vectorStore: VectorStore, syncStore: SQLiteSyncStore) {
    this.vaultPath = vaultPath;
    this.llm = llm;
    this.vectorStore = vectorStore;
    this.syncStore = syncStore;
  }

  /**
   * Main entrypoint to sync the entire vault.
   * Walks the directory, hashes files to detect changes, embeds chunks, and saves to VectorStore.
   */
  async syncVault(): Promise<{ synced: number; skipped: number; chunks: number }> {
    if (!fs.existsSync(this.vaultPath)) {
      throw new Error(`Vault path does not exist: ${this.vaultPath}`);
    }

    const files = this.walkDir(this.vaultPath);
    let synced = 0;
    let skipped = 0;
    let totalChunks = 0;

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      try {
        const stats = fs.statSync(file);
        // Skip hidden files or specific obsidian metadata folders
        if (file.includes('/.obsidian/')) continue;

        const content = fs.readFileSync(file, 'utf-8');
        const fileHash = this.hashContent(content);
        const relativePath = path.relative(this.vaultPath, file);

        // Check against the SyncStore to skip unchanged files
        const existingHash = this.syncStore.getHash(relativePath);
        if (existingHash === fileHash) {
          skipped++;
          continue;
        }

        const parsed = matter(content);
        const text = parsed.content;
        const fileName = path.basename(file, '.md');

        // Simple chunking (by paragraphs/headings)
        const chunks = this.chunkText(text, 1000); 

        // Embed each chunk and store
        for (let i = 0; i < chunks.length; i++) {
          const chunkStr = chunks[i];
          if (chunkStr.trim().length < 5) continue;
          
          // Construct rich document representation for embedding so the vector has maximum context
          const tagsStr = Array.isArray(parsed.data.tags) 
            ? parsed.data.tags.join(', ') 
            : String(parsed.data.tags || 'none');
            
          const documentStr = `Title: ${fileName}\nTags: ${tagsStr}\n\n${chunkStr}`;
          
          let vector: number[] = [];
          if (this.llm.embed) {
            vector = await this.llm.embed(documentStr);
          } else {
             // throw or warn
             console.warn('[obsidian] LLMProvider does not support embeddings!');
             continue;
          }

          const chunkId = `${relativePath}_chunk_${i}`;
          
          await this.vectorStore.upsert(chunkId, vector, {
            filePath: relativePath,
            fileName: fileName,
            content: chunkStr, // Store original raw text for LLM injection
            tags: tagsStr,
            chunkIndex: i,
            totalChunks: chunks.length,
            fileHash
          });
          
          totalChunks++;
        }
        
        // Mark file as completely synced
        this.syncStore.setHash(relativePath, fileHash);
        
        synced++;
        console.log(`[obsidian] Synced: ${fileName} (${chunks.length} chunks)`);
      } catch (err) {
        console.error(`[obsidian] Error parsing ${file}:`, err);
      }
    }

    return { synced, skipped, chunks: totalChunks };
  }

  private walkDir(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      if (fs.statSync(filePath).isDirectory()) {
         // Skip hidden directories and the raw 'data' folders so we only hit 'Obsidian' docs
         if (!file.startsWith('.') && file !== 'data') {
            this.walkDir(filePath, fileList);
         }
      } else {
        fileList.push(filePath);
      }
    }
    return fileList;
  }

  private hashContent(str: string): string {
    return createHash('sha256').update(str).digest('hex');
  }

  /**
   * Extremely simple naive chunker. 
   * Splits by double newlines (paragraphs) and groups them to near maxChunkSize characters.
   */
  private chunkText(text: string, maxChunkSize: number): string[] {
    const paragraphs = text.split('\n\n');
    const chunks: string[] = [];
    let currentChunk = '';

    for (const p of paragraphs) {
      if ((currentChunk.length + p.length) > maxChunkSize && currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      currentChunk += p + '\n\n';
    }
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }
}
