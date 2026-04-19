import * as lancedb from '@lancedb/lancedb';
import type { VectorStore, VectorMatch } from '@jarvis/shared';

export class LanceVectorStore implements VectorStore {
  private uri: string;
  private db!: lancedb.Connection;
  private table!: lancedb.Table;
  private isInitialized = false;

  constructor(uri: string) {
    this.uri = uri;
  }

  async init(): Promise<void> {
    if (this.isInitialized) return;
    this.db = await lancedb.connect(this.uri);

    const tableNames = await this.db.tableNames();
    
    // We create a table with vector(dim) but LanceDB can infer schema off first insert.
    // For safety, Lance prefers schema, but dropping in array works if table doesn't exist.
    // We'll wait to create the table upon first insertion if it doesn't exist.
    if (tableNames.includes('knowledge')) {
      this.table = await this.db.openTable('knowledge');
    }
    this.isInitialized = true;
  }

  async upsert(id: string, vector: number[], metadata?: Record<string, any>): Promise<void> {
    await this.init();

    const data = [{
      id,
      vector,
      ...metadata
    }];

    if (!this.table) {
      this.table = await this.db.createTable('knowledge', data);
    } else {
      // LanceDB table merge/upsert requires strict matching, we'll delete and add or just add
      // Given simple setup, let's just delete by id to simulate upsert
      try {
        await this.table.delete(`id = '${id}'`);
      } catch (e) { /* ignore if not exists */ }
      await this.table.add(data);
    }
  }

  async search(vector: number[], limit = 5): Promise<VectorMatch[]> {
    await this.init();
    if (!this.table) return [];

    const results = await this.table
      .vectorSearch(vector)
      .limit(limit)
      .toArray();

    return results.map(r => {
      // omit internal vector field and return the rest as metadata
      const { vector: _v, _distance, id, ...metadata } = r as any;
      return {
        id,
        score: _distance, // In LanceDB, L2 distance is returned. Lower is better.
        metadata
      };
    });
  }

  async delete(id: string): Promise<void> {
    await this.init();
    if (!this.table) return;
    await this.table.delete(`id = '${id}'`);
  }
  
  async count(): Promise<number> {
    await this.init();
    if (!this.table) return 0;
    return await this.table.countRows();
  }
}
