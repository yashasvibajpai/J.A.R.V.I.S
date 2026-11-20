<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=fff" />
  <img src="https://img.shields.io/badge/Next.js_16-000?logo=nextdotjs&logoColor=fff" />
  <img src="https://img.shields.io/badge/Express_5-000?logo=express&logoColor=fff" />
  <img src="https://img.shields.io/badge/SQLite_WAL-003B57?logo=sqlite&logoColor=fff" />
  <img src="https://img.shields.io/badge/LanceDB-FF6F00?logoColor=fff" />
  <img src="https://img.shields.io/badge/pnpm_Monorepo-F69220?logo=pnpm&logoColor=fff" />
</p>

# J.A.R.V.I.S

**Just A Rather Very Intelligent System**

A local-first, privacy-respecting personal AI assistant built as a TypeScript monorepo. JARVIS routes intelligently across multiple LLM providers, remembers your preferences and facts across sessions, searches your Obsidian vault via semantic RAG, manages tasks and reminders, integrates with Google Calendar, executes tools through OpenClaw, and speaks with a dry British wit inspired by Paul Bettany's portrayal.

---

## Architecture

```
jarvis-monorepo/
├── packages/
│   ├── api/          # Express 5 backend — middleware pipeline, SmartRouter, stores
│   ├── web/          # Next.js 16 PWA — chat UI, session switcher, voice recorder
│   ├── shared/       # TypeScript interfaces — LLMProvider, MemoryStore, VectorStore, etc.
│   ├── config/       # Personality cartridge (YAML) — edit a file, change the brain
│   └── data/         # SQLite databases & LanceDB vectors (auto-created at runtime)
├── skills/           # OpenClaw skill definitions (WhatsApp/Telegram bridge)
├── docs/             # Architecture Decision Records (ADR-001 through ADR-003)
├── flow.md           # End-to-end execution flow with diagrams
├── decisions.md      # All architectural decisions in one place
├── Dockerfile.api    # Multi-stage Docker build for the API
├── railway.toml      # Railway deployment config
└── vercel.json       # Vercel deployment config for the frontend
```

### Core Design Principles

- **Adapter Pattern** — Every integration (LLMs, memory, vectors, profiles, tasks) implements a shared interface from `@jarvis/shared`. Swap the adapter, swap the brain.
- **Middleware Pipeline** — Every message flows through a deterministic chain of middleware steps. Each step is isolated, non-blocking, and can fail without crashing the conversation.
- **Local-First Storage** — All data lives in SQLite (WAL mode) and LanceDB on disk. No external database required.
- **Async Write Path** — Memory, task, and profile extraction runs in the background after the response is sent. The user never waits for writes.

---

## Features

### 🧠 Intelligent Multi-Provider Routing (SmartRouter)

JARVIS doesn't lock you into a single LLM. The SmartRouter:

- **Auto-discovers** every configured provider from environment variables
- **Classifies** each prompt by task type (quick, coding, reasoning, creative, tool_use, general) using zero-token heuristic regex
- **Scores** providers on task affinity × latency × cost
- **Enforces** per-provider RPM, RPD, and daily token budgets
- **Fails over** automatically with exponential backoff and circuit breakers

Supported providers:

| Provider | Key Variable | Free Tier |
|---|---|---|
| Google Gemini | `GOOGLE_AI_API_KEY` | ✅ Generous |
| Groq | `GROQ_API_KEY` | ✅ |
| Cerebras | `CEREBRAS_API_KEY` | ✅ 1M tokens/day |
| Mistral | `MISTRAL_API_KEY` | ✅ 1B tokens/month |
| OpenRouter | `OPENROUTER_API_KEY` | ✅ Select models |
| Ollama (local) | `OLLAMA_HOST` | ✅ Fully local |
| Ollama Cloud | `OLLAMA_CLOUD_API_KEY` | ✅ |
| OpenAI | `OPENAI_API_KEY` | Paid |
| Anthropic | `ANTHROPIC_API_KEY` | Paid |

> **Tip:** Configure 2–3 free providers for robust failover. JARVIS works perfectly with zero paid keys.

### 💬 Conversational Memory

JARVIS learns about you across sessions:

- **Memory Recall** — FTS5 full-text search retrieves the top 5 relevant facts before every LLM call
- **Memory Extraction** — After each reply, a background LLM call extracts concrete facts (preferences, goals, events, relationships) and stores them with Jaccard deduplication
- **Categories**: `fact`, `preference`, `event`, `goal`, `relationship`, `context`

### 👤 Adaptive User Profile

- Automatically extracts and updates your name, role, location, timezone, interests, goals, and preferences
- Profile injection runs before every LLM call — JARVIS always knows who it's talking to
- Versioned history in SQLite — every profile change is tracked

### 📋 Task & Reminder Management

- **Auto-extraction** — JARVIS detects when you mention tasks, reminders, or fleeting thoughts and stores them
- **Context injection** — Pending tasks and active reminders are injected into every conversation
- **Quick capture** — Unstructured thoughts go into a scratchpad (`captures.db`) for later processing

### 📚 Obsidian Vault RAG (Knowledge Base)

If you use [Obsidian](https://obsidian.md), JARVIS can search your entire vault semantically:

- **Hash-based sync** — Only re-indexes files that have changed (SHA-256 tracking)
- **Vector search** — Embeds document chunks into LanceDB; retrieves the 4 nearest neighbours
- **Anti-hallucination guardrails** — Injected context explicitly instructs the LLM to only use retrieved notes and admit when information is insufficient

**Setup:**
```bash
# In packages/api/.env
OBSIDIAN_VAULT_PATH=/path/to/your/vault
```
Then trigger a sync:
```bash
curl -X POST http://localhost:3001/api/knowledge/sync
```

### 📅 Google Calendar Integration

JARVIS checks your schedule and injects today's events into the conversation context.

**Setup:**
1. Create OAuth 2.0 credentials in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Enable the Google Calendar API
3. Add to `.env`:
   ```
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   ```
4. Visit `http://localhost:3001/auth/google` in your browser to complete OAuth

### 💻 Autonomous Terminal Agent (Claude Code-style CLI)

JARVIS can run directly inside your terminal as an interactive agent with real-time token streaming, file inspection, live internet search, and command execution:

```bash
# Launch interactive REPL
pnpm jarvis

# One-shot command execution
pnpm jarvis "What's the latest on Iran?"
```

**Slash Commands in CLI:**
| Command | Description |
|---|---|
| `/help` | Display command reference and agent capabilities |
| `/btw <question>` | **Ephemeral Side Question**: Ask a quick aside in a floating overlay card without polluting your main conversation context |
| `/ask` | **Interactive Tabbed Question Wizard**: Launch multi-tab design decision forms with arrow navigation and multi-select |
| `/status` | View system health, active profile, memory count, and vector database stats |
| `/read <path>` | Inspect local workspace files with preview |
| `/write <path> <text>` | Create or update files directly |
| `/pdf <file.pdf> <markdown>` | Compile formatted PDF documents directly from terminal |
| `/search <query>` | Perform real-time web search (Google News RSS & DuckDuckGo) |
| `/rag <query>` | Query Obsidian Vault vector embeddings via LanceDB |
| `/exec <command>` | Run shell commands with interactive `[y/N]` confirmation prompts |
| `/clear` | Clear conversation history and reset terminal |
| `/exit` | Exit the terminal session |

**Signature Claude Code-style UX Highlights:**
- **Tabbed Question Forms (`AskUserQuestion`)**: When design choices or technical decisions are required, JARVIS displays a native terminal wizard with `[↑/↓]` selection, `[Space]` toggle, and `[Tab]` switching instead of walls of numbered questions.
- **Floating Ephemeral Asides (`/btw`)**: Pop up quick side questions mid-workflow. The response is displayed in a distinct floating card and excluded from session history.
- **Whimsical Marvel J.A.R.V.I.S. & Vision Spinners**: Real-time rotating telemetry verbs (*"Calibrating repulsor telemetry..."*, *"Synthesizing neural pathways with the Mind Stone..."*, *"Modulating vibranium matrix frequencies..."*) with context-aware tips.

### Background research

`/research <topic>` starts a brief. Use `/research -d <topic>` for an open-ended investigation. A local worker keeps running after the terminal closes and advances one action per tick. Deep missions read original sources, compare supporting and conflicting evidence, and check citations before publishing. They finish when the evidence answers the questions or useful search paths are exhausted.

- Use `/research dashboard [id]` to follow the mission, browse documents, and pause, resume, or stop it. Stopping publishes the committed evidence.
- Use `/research steer <id> focus on <area>` or `/research explore <id> <related question>` to change direction. Use `/research fact-check <id> <claim-id> [source URL or correction]` to reopen a finding.
- Open `/research doc help` for a tabbed guide with command examples for creating, editing, and exporting research documents. Use Tab or the arrow keys to switch tabs and Esc to return. Revisions can be exported as Markdown and PDF, and `/research doc bundle <id>` saves the research ledger and document history as JSON.
- Use `/research publish <id>` to export a briefing from a paused, stopped, or completed mission. This leaves the mission state as it is. The report ends with pending research areas.
- Use `/research diagnose <id>` for retrieval failures, question stop decisions, and per-call timing and provider errors. Set `JARVIS_RESEARCH_TRACE=true` before starting the worker to capture full prompts and responses locally, then use `/research diagnose <id> --trace`.

Research requires a configured free model provider. Configure account-specific model and search limits in `.env` where needed. Report export uses the built-in PDF renderer. For PDF text extraction, JARVIS uses Poppler's `pdftotext` or falls back to PDFKit on macOS through the Swift command-line tools. See the [research plan](docs/research-mode-plan.md).

### 📄 Native Document & PDF Generation

JARVIS creates and compiles documents directly to disk without requiring external tools or headless browsers:

- **PDF Documents** — Generates PDF 1.4-compliant multi-page documents with word wrapping, Helvetica headers, bullet points, code blocks, dividers, and page numbers (`Page X of Y`).
- **Markdown Notes** — Writes structured `.md` files directly to your workspace or Obsidian Vault.
- **Natural Language Trigger** — Simply ask in chat or CLI:
  ```
  "Generate an executive briefing on AI chips and save it to documents/chips.pdf"
  ```

### 🌐 Native Real-Time Web Search (Zero OpenClaw Dependency)

- Queries **Google News RSS** for real-time news headlines, articles, and breaking events.
- Queries **DuckDuckGo Instant Answer API** for zero-bot-challenge entity definitions.
- Automatically upgrades to **Tavily** (`TAVILY_API_KEY`) or **Brave Search** (`BRAVE_API_KEY`) if present in `.env`.

### 🔧 Tool Execution (OpenClaw)

When [OpenClaw](https://openclaw.dev) is enabled, JARVIS can execute real actions:

| Tool | Safety | Description |
|---|---|---|
| `web.search` | ✅ Safe (auto-exec) | Search the live web |
| `file.read` | ✅ Safe (auto-exec) | Read file contents |
| `file.write` | ⚠️ Destructive | Write files — requires confirmation |
| `os.exec` | ⚠️ Destructive | Run shell commands — requires confirmation |
| `message.send` | ⚠️ Destructive | Send WhatsApp/Telegram — requires confirmation |

Destructive actions display a confirmation modal in the UI. Nothing dangerous runs without explicit approval.

**Setup:**
```bash
# In packages/api/.env
OPENCLAW_ENABLED=true
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your_token
```

### 🗣️ Voice Interaction (Voicebox)

Bidirectional voice: speak to JARVIS through the browser mic, hear responses through the speakers.

- **STT**: Browser captures audio → forwarded to Voicebox → returns transcribed text
- **TTS**: Response text → Voicebox LuxTTS engine → audio streamed back to the browser

**Setup:**
```bash
# In packages/api/.env
VOICEBOX_URL=http://127.0.0.1:17493
VOICEBOX_PROFILE_ID=your_profile_id
```

### 🧩 GBrain Integration

Optional integration with [GBrain](https://github.com/yashasvibajpai/gbrain) for synthesised historical context:

- **Think** — `gbrain think "<query>"` synthesises knowledge across people, companies, and timeline events
- **Capture** — Every conversation is piped to `gbrain capture --stdin` as a Markdown note

```bash
# In packages/api/.env
GBRAIN_ENABLED=true
```

### 🎭 Personality Cartridge

JARVIS's personality is defined in a single YAML file — no code changes needed:

```yaml
# packages/config/jarvis-personality.yaml
identity:
  name: JARVIS
  fullName: "Just A Rather Very Intelligent System"
  vibe: "Witty, concise, brilliant — slightly formal but genuinely warm."

persona:
  role: >
    You are JARVIS, a personal intelligent assistant...
  traits:
    - "Concise and direct — say more with fewer words"
    - "Witty when the moment calls for it"
    - "Slightly formal British tone"
  rules:
    - "Never use filler phrases: 'Certainly!', 'I'd be happy to!'"
    - "Never start responses with 'I'"
```

Edit the file, restart the server, and JARVIS speaks differently.

### 🌐 WhatsApp / Telegram Bridge

The OpenClaw bridge skill (`skills/jarvis-bridge/SKILL.md`) routes inbound messages from any channel (WhatsApp, Telegram) through the full JARVIS pipeline — memory, personality, RAG, and all. Your mobile chat gets the same intelligence as the web UI.

---

## Local Setup

### Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 9
- At least one LLM provider key (or [Ollama](https://ollama.com) running locally)

### 1. Clone & Install

```bash
git clone https://github.com/yashasvibajpai/J.A.R.V.I.S.git
cd J.A.R.V.I.S
pnpm install
```

### 2. Configure Environment

```bash
cp packages/api/.env.example packages/api/.env
```

Open `packages/api/.env` and add at least one provider key. The quickest free options:

```bash
# Pick any one (or several for failover):
GOOGLE_AI_API_KEY=your_key      # https://aistudio.google.com/apikey
GROQ_API_KEY=your_key           # https://console.groq.com/keys
CEREBRAS_API_KEY=your_key       # https://cloud.cerebras.ai/

# Or run fully local with Ollama (no key needed):
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=gemma3:4b
```

### 3. Start Development Servers

```bash
# Terminal 1 — API backend (port 3001)
pnpm --filter @jarvis/api dev

# Terminal 2 — Web frontend (port 3000)
pnpm --filter @jarvis/web dev
```

Open **http://localhost:3000** in your browser.

### 4. Run Diagnostics

```bash
pnpm run doctor
# or: pnpm --filter @jarvis/api run doctor
```

This checks Node version, `.env` configuration, provider connectivity, personality cartridge, data directories, and GBrain integration status.

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/chat` | Send a message through the full pipeline |
| `POST` | `/api/chat/stream` | SSE streaming with full pipeline parity |
| `POST` | `/api/actions/confirm` | Execute a confirmed destructive action |
| `GET` | `/api/sessions` | List all chat sessions |
| `GET` | `/api/sessions/:id/messages` | Get messages for a session |
| `DELETE` | `/api/sessions/:id` | Delete a session |
| `GET` | `/api/memories` | List all stored memories |
| `GET` | `/api/memories/search?q=...` | Search memories by keyword |
| `GET` | `/api/profile` | Get the current user profile |
| `GET` | `/api/tasks` | List tasks |
| `GET` | `/api/reminders` | List reminders |
| `POST` | `/api/knowledge/sync` | Trigger Obsidian vault sync |
| `POST` | `/api/voice/transcribe` | Speech-to-text (requires Voicebox) |
| `POST` | `/api/voice/synthesize` | Text-to-speech (requires Voicebox) |
| `GET` | `/api/providers` | SmartRouter provider dashboard |
| `GET` | `/health` | Health check with memory count & provider status |

---

## Deployment

### Frontend → Vercel

```bash
# Configured via vercel.json — just connect the GitHub repo
# Build command: pnpm --filter @jarvis/web build
# Output: packages/web/.next
```

### Backend → Railway (Docker)

```bash
# Build locally:
docker build -t jarvis-api -f Dockerfile.api .
docker run -p 3001:3001 --env-file packages/api/.env jarvis-api

# Or deploy via Railway — connect the repo, it reads railway.toml automatically.
# Ensure persistent volume is mounted for packages/data/ (SQLite databases).
```

---

## Middleware Pipeline

Every message flows through this chain. Each step is isolated and non-fatal:

```
 Observability → System Prompt → Tool Catalogue → Calendar
       → Profile Injection → Memory Recall → Knowledge RAG
       → GBrain Think → Task Recall → Token Truncation
       ─── markLlmBoundary() ───
       → SmartRouter LLM Call → OpenClaw Action
       → Memory Extraction* → Task Extraction* → Profile Extraction*
       → GBrain Capture*
       (* = async, fire-and-forget via setImmediate)
```

See [`flow.md`](flow.md) for the complete execution flow with Mermaid diagrams, and [`decisions.md`](decisions.md) for all architectural decisions.

---

## Documentation

| Document | Description |
|---|---|
| [`flow.md`](flow.md) | End-to-end execution flow with diagrams |
| [`decisions.md`](decisions.md) | All architectural decision records |
| [`docs/ADR-001.md`](docs/ADR-001.md) | Monorepo structure & adapter pattern |
| [`docs/ADR-002.md`](docs/ADR-002.md) | Deployment architecture |
| [`docs/ADR-003.md`](docs/ADR-003.md) | Async write path, output validation, streaming parity |
| [`docs/memory-explainer.md`](docs/memory-explainer.md) | How the memory system works |
| [`packages/api/.env.example`](packages/api/.env.example) | All environment variables documented |

---

## License

Private project. All rights reserved.
