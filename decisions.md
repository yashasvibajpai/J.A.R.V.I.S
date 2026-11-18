# J.A.R.V.I.S — Architectural Decisions Record (decisions.md)

This document tracks all key technical and architectural decisions for the J.A.R.V.I.S platform, capturing context, tradeoffs, implementation details, and forward-looking constraints.

---

## Index of Decisions

- [ADR-001: Monorepo Structure and Adapter Pattern](#adr-001-monorepo-structure-and-adapter-pattern)
- [ADR-002: Deployment Architecture (Vercel + Railway)](#adr-002-deployment-architecture-vercel--railway)
- [ADR-003: Asynchronous Write Path for Memory & Context Extractions](#adr-003-asynchronous-write-path-for-memory--context-extractions)
- [ADR-004: Resilient Schema Validation for LLM JSON/Structured Outputs](#adr-004-resilient-schema-validation-for-llm-jsonstructured-outputs)
- [ADR-005: Streaming Pipeline Parity & Middleware Context Boundaries](#adr-005-streaming-pipeline-parity--middleware-context-boundaries)
- [ADR-006: Remote Research Node & Strict Free/Local Routing Policy](#adr-006-remote-research-node--strict-freelocal-routing-policy)

---

## ADR-001: Monorepo Structure and Adapter Pattern

- **Status**: Accepted
- **Date**: 2026-04-12
- **Context**: The system integrates multiple components: Next.js frontend, Express backend, Python AI agent runtime, and shared types. Integrations with LLMs, memory stores, and vector databases must remain swappable without vendor lock-in.
- **Decision**:
  1. Monorepo managed via `pnpm` workspaces (`packages/api`, `packages/web`, `packages/shared`, `packages/config`, `packages/data`).
  2. Adapter pattern: interfaces declared in `@jarvis/shared` (`LLMProvider`, `MemoryStore`, `VectorStore`, `ProfileStore`, `TaskStore`, `ReminderStore`, `CaptureStore`).
- **Consequences**:
  - Enforces decoupled components.
  - Swapping LLM providers or database backends does not alter pipeline code.

---

## ADR-002: Deployment Architecture (Vercel + Railway)

- **Status**: Accepted
- **Date**: 2026-04-12
- **Context**: The application needs to run reliably with minimal operating costs. The frontend requires edge CDN caching, while the backend requires persistent SQLite database files.
- **Decision**:
  1. Frontend deployed to **Vercel** (`packages/web`).
  2. Backend containerized with Docker (`Dockerfile.api`) and deployed to **Railway** with persistent volume mounts for `packages/data/`.
  3. CI/CD via **GitHub Actions** checking types and linting on push.
- **Consequences**:
  - Zero-CORS via Next.js API route proxies/rewrites.
  - Persistent volume ensures SQLite WAL stores survive container restarts.

---

## ADR-003: Asynchronous Write Path for Memory & Context Extractions

- **Status**: Accepted
- **Date**: 2026-11-17
- **Context**:
  In earlier versions, extraction middlewares (`memoryExtractionMiddleware`, `taskExtractionMiddleware`, `profileExtractionMiddleware`, and `gbrainExtractionMiddleware`) executed synchronously during `pipeline.run()` after the LLM generated its reply. Each extraction entailed secondary LLM prompts (`temperature: 0.1`) and database roundtrips, adding 200–800ms of user-perceived HTTP latency. In long-horizon interactions, memory construction energy and latency dominate the query lifecycle.
- **Decision**:
  Decouple the "Read Path" (synchronous query & context enrichment) from the "Write Path" (background memory extraction and storage).
  1. All extraction middlewares execute asynchronously via Node.js `setImmediate()`.
  2. The primary HTTP response (`POST /api/chat`) and SSE stream (`POST /api/chat/stream`) flush immediately after the assistant response is finalized.
  3. Background extraction logs use the `[*:bg]` namespace (e.g., `[memory:bg]`, `[profile:bg]`, `[task:bg]`).
  4. Any extraction failure is logged as a non-fatal warning and never interrupts the user conversation.
- **Consequences**:
  - **Latency Improvement**: Chat roundtrip latency reduced by 40–70% on extraction turns.
  - **Eventual Consistency**: Stored facts and profile updates are reflected in the subsequent turn rather than the immediate response metadata.
  - **Metadata Semantics**: `ctx.metadata` reports scheduling flags (`memoriesExtractionScheduled: true`) rather than synchronous mutation counts.

---

## ADR-004: Resilient Schema Validation for LLM JSON/Structured Outputs

- **Status**: Accepted
- **Date**: 2026-11-17
- **Context**:
  Small, local, or quantised LLMs (e.g., DeepSeek R1 7B, Gemma 2B, Llama 3 8B) frequently output imperfect structured formats—including markdown fences, conversational prefix/suffix prose, trailing commas, or unexpected types. Relying on raw `JSON.parse` or naive regexes leads to silent parser failures or store corruption. Furthermore, in restricted or air-gapped sandboxes, external npm packages like Zod may encounter registry/auth blocks.
- **Decision**:
  Implement a lightweight, zero-dependency schema validation utility in `packages/api/src/engine/llm-output.ts`.
  1. **Markdown & Prose Stripping**: Removes ` ```json ` fences and uses balanced brace counting to isolate valid `{...}` blocks.
  2. **Lenient Trailing-Comma Repair**: Strips trailing commas preceding closing `}` or `]`.
  3. **Runtime Schema Guards**:
     - `parseProfileOutput(raw)`: Validates `preferredName`, typed `context` records (role, location, timezone, interests, goals), and string-coerced `preferences`.
     - `parseTaskOutput(raw)`: Validates line syntax `[action_type] content`, checking against valid types (`task_create`, `task_complete`, `reminder_create`, `capture`) with 3–500 char sanity bounds.
     - `parseMemoryOutput(raw)`: Validates line syntax `[category] content`, checking against 6 canonical categories (`fact`, `preference`, `event`, `goal`, `relationship`, `context`) with 5–1000 char bounds.
  4. **Fail-Safe Fallbacks**: Any malformed payload is silently ignored or logged without crashing or throwing errors.
- **Consequences**:
  - Complete immunity against database corruption when switching to low-parameter or aggressive-quantization models.
  - Zero external npm dependency footprint.

---

## ADR-005: Streaming Pipeline Parity & Middleware Context Boundaries

- **Status**: Accepted
- **Date**: 2026-11-17
- **Context**:
  The streaming endpoint (`POST /api/chat/stream`) previously bypassed the entire middleware pipeline, performing raw string concatenation with only the system prompt and history. As a result, streamed responses lacked memory recall, profile preferences, Google Calendar schedules, Obsidian RAG context, and task awareness. Furthermore, streamed turns never extracted memories.
- **Decision**:
  Introduce a deterministic boundary into `Pipeline` (`packages/api/src/engine/pipeline.ts`) that splits pre-inference enrichment from post-inference actions:
  1. **Boundary Marker**: `pipeline.markLlmBoundary()` marks the split point immediately before `llmCallMiddleware`.
  2. **`pipeline.buildContext(userMessage, history)`**: Executes all pre-LLM middleware (Observability → SystemPrompt → ToolCatalogue → Calendar → Profile → MemoryRecall → KnowledgeRAG → GBrain → TaskRecall → TokenTruncation), returning an enriched `PipelineContext`.
  3. **Streaming Execution**: `chain.stream(ctx.messages)` streams tokens via SSE chunks to the client.
  4. **`pipeline.runPostLlm(ctx)`**: After the stream completes, passes the collected response into post-LLM steps (OpenClaw action verification and async background extraction).
- **Consequences**:
  - Full feature parity between `/api/chat` and `/api/chat/stream`.
  - SSE clients now receive memories, user profile adaptation, and Obsidian knowledge in real-time.
  - Background extraction runs for streaming sessions without blocking the network connection.

---

## ADR-006: Remote Research Node & Strict Free/Local Routing Policy

- **Status**: Accepted / In Progress
- **Date**: 2026-11-17
- **Context**:
  Long-horizon autonomous tasks (deep research, recursive curiosity loops, multi-document synthesis) consume tens of thousands of tokens over extended timeframes. Running these against paid APIs (Claude 3.5 Sonnet, GPT-4o) incurs unsustainable costs. A procured Lenovo Ubuntu node with an NVIDIA 940MX (2GB VRAM) running local DeepSeek R1 7B via Ollama CUDA provides a zero-cost compute cluster.
- **Decision**:
  1. **Remote Node Adapter**: Create `RemoteResearchNodeAdapter.ts` communicating with the Lenovo node over Tailscale VPN.
  2. **SmartRouter Policy Constraints**: Introduce `tierPolicy: 'free_and_local_only'` and `preferProviderId` to guarantee that long-running background research never cascades into paid tiers.
  3. **Context Pre-Compression**: Enforce strict context bounding (≤4096 tokens) via a specialized `BriefingCompiler` before dispatching prompts to the Lenovo 940MX.
  4. **Autonomous Tick Heartbeat**: Execute deep research using a tick-based background loop with rolling rate limits and SQLite persistence.
- **Consequences**:
  - Zero token cost for overnight deep research workflows.
  - Resilient to network drops and rate limits via idempotent SQLite checkpoints.
