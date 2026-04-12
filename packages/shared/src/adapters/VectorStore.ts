export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, any>;
}

export interface VectorStore {
  upsert(id: string, vector: number[], metadata?: Record<string, any>): Promise<void>;
  search(vector: number[], limit?: number): Promise<VectorMatch[]>;
  delete(id: string): Promise<void>;
}
