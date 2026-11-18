# J.A.R.V.I.S. Memory Architecture

The JARVIS project implements a multi-tiered memory architecture designed to emulate natural recall while also supporting external knowledge bases. The system is broken down into three main types of memory: Short-Term, Long-Term, and External/Knowledge Memory.

## 1. Short-Term Memory (Contextual History)
**Implementation**: Pipeline Context (`packages/api/src/engine/pipeline.ts`)

Short-term memory handles the immediate context of the current conversation. 
- When a user sends a message, the `PipelineContext` is initialized with the `userMessage` and the current conversation `history`.
- This array of messages flows through various middleware components in the pipeline (e.g., system prompt injection, LLM call) maintaining the immediate conversational state.

## 2. Long-Term Memory (Personalization & Facts)
**Implementation**: Memory Middleware & Store (`packages/api/src/engine/memory-middleware.ts`, `packages/shared/src/adapters/MemoryStore.ts`)

Long-term memory is how JARVIS "learns" about the user over time, persisting across sessions.
- **Extraction (`memoryExtractionMiddleware`)**: After the LLM generates a response, the conversation is analyzed by an extraction prompt to pull out concrete facts. These facts are categorized into `fact`, `preference`, `event`, `goal`, `relationship`, or `context`.
- **Storage**: The extracted facts are deduplicated using string similarity (Jaccard index) and saved to the `MemoryStore`. Currently, it uses a SQLite backend with FTS5 full-text search (with future plans to upgrade to Mem0 or Qdrant for vector-based retrieval).
- **Recall (`memoryRecallMiddleware`)**: Before processing a new user message, JARVIS searches the `MemoryStore` for relevant past facts and injects them into the LLM's system prompt as "Relevant Memories."

## 3. External / Knowledge Memory (RAG)
**Implementation**: Obsidian Crawler & Vector Store (`packages/api/src/services/ObsidianCrawler.ts`)

Knowledge memory provides JARVIS with access to external files, documents, and reference materials.
- **Obsidian Crawler**: The system syncs an external Obsidian markdown vault. It walks the directory, hashes files to detect changes, and parses the markdown.
- **Chunking & Embedding**: The markdown content is chunked and embedded into vectors using the LLM provider. The vector chunks include rich metadata (like file names and tags) to maximize context.
- **Retrieval**: The vector embeddings are saved to a `VectorStore` enabling Retrieval-Augmented Generation (RAG). When the user asks a knowledge-based question, JARVIS can semantically search the vault and retrieve the relevant document chunks to answer the question accurately.
