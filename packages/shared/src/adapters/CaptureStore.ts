export interface Capture {
  id: string;
  content: string;
  category: 'idea' | 'link' | 'note' | 'thought';
  processed: boolean;
  createdAt: string;
}

export interface CaptureStore {
  createCapture(capture: Omit<Capture, 'id' | 'createdAt' | 'processed'>): Promise<Capture>;
  markProcessed(id: string): Promise<Capture>;
  getUnprocessedCaptures(): Promise<Capture[]>;
  deleteCapture(id: string): Promise<boolean>;
}
