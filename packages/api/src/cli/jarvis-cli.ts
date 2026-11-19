#!/usr/bin/env npx tsx
/**
 * J.A.R.V.I.S — Autonomous Terminal Agent (Claude Code-style CLI)
 *
 * An interactive, agentic terminal interface powered by JARVIS:
 * - Real-time token streaming to stdout
 * - Autonomous document generation (Markdown & PDF)
 * - Safe OS command execution with user confirmation prompts
 * - Real-time web search & Obsidian LanceDB semantic search
 * - Signature Claude Code features:
 *   1. Interactive Tabbed Question Forms (AskUserQuestion)
 *   2. Ephemeral Side Questions with /btw (isolated context overlay)
 *   3. Whimsical Marvel J.A.R.V.I.S. & Vision Spinner Verbs & Context Tips
 */

import readline from 'readline/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

import 'dotenv/config';

import { SmartRouter } from '../engine/SmartRouter.js';
import { buildProviderRegistry } from '../engine/provider-registry.js';
import { loadCartridge, buildSystemPrompt } from '../engine/personality.js';
import {
  Pipeline,
  systemPromptMiddleware,
  llmCallMiddleware,
} from '../engine/pipeline.js';
import { memoryRecallMiddleware, memoryExtractionMiddleware } from '../engine/memory-middleware.js';
import { profileInjectionMiddleware, profileExtractionMiddleware } from '../engine/profile-middleware.js';
import { taskRecallMiddleware, taskExtractionMiddleware } from '../engine/task-middleware.js';
import { knowledgeMiddleware } from '../engine/knowledge-middleware.js';
import { tokenTruncationMiddleware } from '../engine/token-middleware.js';
import { gbrainMiddleware } from '../engine/gbrain-middleware.js';
import { gbrainExtractionMiddleware } from '../engine/gbrain-extraction-middleware.js';
import { filePromptMiddleware, fileActionMiddleware } from '../engine/file-middleware.js';
import { questionPromptMiddleware } from '../engine/question-middleware.js';
import { webSearchMiddleware } from '../engine/web-search-middleware.js';
import { WebSearchService } from '../services/WebSearchService.js';
import { FileService } from '../services/FileService.js';
import { SQLiteMemoryStore } from '../stores/SQLiteMemoryStore.js';
import { SQLiteProfileStore } from '../stores/SQLiteProfileStore.js';
import { SQLiteTaskStore } from '../stores/SQLiteTaskStore.js';
import { SQLiteReminderStore } from '../stores/SQLiteReminderStore.js';
import { SQLiteCaptureStore } from '../stores/SQLiteCaptureStore.js';
import { SQLiteSessionStore } from '../stores/SQLiteSessionStore.js';
import { LanceVectorStore } from '../stores/LanceVectorStore.js';
import type { Message } from '@jarvis/shared';

import {
  c,
  JarvisSpinner,
  renderEphemeralAside,
  askUserQuestion,
  JARVIS_TIPS,
  type QuestionTab,
} from './terminal-ui.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI Core Setup ───────────────────────────────────────────────────────────

async function initJarvisSystem() {
  const DATA_DIR = resolve(__dirname, '../../../data');
  const ALT_DATA_DIR = resolve(__dirname, '../../data');
  const dataDir = existsSync(DATA_DIR) ? DATA_DIR : ALT_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });

  const router = new SmartRouter(buildProviderRegistry());
  const cartridge = loadCartridge();
  const baseSystemPrompt = buildSystemPrompt(cartridge);

  const memoryStore = new SQLiteMemoryStore(resolve(dataDir, 'memories.db'));
  const profileStore = new SQLiteProfileStore(resolve(dataDir, 'profiles.db'));
  await profileStore.initProfile('default', 'User');

  const taskStore = new SQLiteTaskStore(resolve(dataDir, 'tasks.db'));
  const reminderStore = new SQLiteReminderStore(resolve(dataDir, 'reminders.db'));
  const captureStore = new SQLiteCaptureStore(resolve(dataDir, 'captures.db'));
  const sessionStore = new SQLiteSessionStore(resolve(dataDir, 'sessions.db'));

  const lancedbDir = resolve(dataDir, 'lancedb');
  const vectorStore = new LanceVectorStore(lancedbDir);
  await vectorStore.init();

  const webSearch = new WebSearchService();
  const fileService = new FileService();

  // Assemble CLI Message Pipeline
  const pipeline = new Pipeline()
    .use(systemPromptMiddleware(baseSystemPrompt))
    .use(filePromptMiddleware())
    .use(questionPromptMiddleware())
    .use(profileInjectionMiddleware(profileStore))
    .use(memoryRecallMiddleware(memoryStore))
    .use(knowledgeMiddleware(vectorStore, router))
    .use(gbrainMiddleware())
    .use(webSearchMiddleware(webSearch))
    .use(taskRecallMiddleware(taskStore, reminderStore))
    .use(tokenTruncationMiddleware(6000))
    .markLlmBoundary()
    .use(llmCallMiddleware(router))
    // Post-LLM:
    .use(fileActionMiddleware(fileService))
    .use(memoryExtractionMiddleware(memoryStore, router))
    .use(taskExtractionMiddleware(taskStore, reminderStore, captureStore, router))
    .use(profileExtractionMiddleware(profileStore, router))
    .use(gbrainExtractionMiddleware());

  return {
    router,
    pipeline,
    memoryStore,
    profileStore,
    taskStore,
    fileService,
    webSearch,
    vectorStore,
    sessionStore,
  };
}

// ─── Welcome Banner ───────────────────────────────────────────────────────────

function printBanner() {
  const randomTip = JARVIS_TIPS[Math.floor(Math.random() * JARVIS_TIPS.length)];
  console.log(`
${c.cyan}${c.bold}     ____.  _____  .______   ____   ____.___  _________
    |    | /  _  \\ |   _  \\  \\   \\ /   /|   |/   _____/
    |    |/  /_\\  \\|  |_)  |  \\   Y   / |   |\\_____  \\ 
/\\__|    /    |    \\  _  <     \\     /  |   |/        \\
\\________\\____|__  /__| \\_\\     \\___/   |___/_______  /
                 \\/                                 \\/${c.reset}
${c.bold}J.A.R.V.I.S — Autonomous Terminal Agent${c.reset} ${c.dim}(Marvel Vision/Stark Protocol)${c.reset}
${c.gray}Workspace:${c.reset} ${c.cyan}${process.cwd()}${c.reset}
${c.gray}Commands:${c.reset}  ${c.yellow}/help${c.reset} • ${c.yellow}/btw <query>${c.reset} • ${c.yellow}/ask${c.reset} • ${c.yellow}/status${c.reset} • ${c.yellow}/clear${c.reset} • ${c.yellow}/exit${c.reset}
${c.dim}${randomTip}${c.reset}
────────────────────────────────────────────────────────────────────────────────
`);
}

// ─── Interactive REPL Loop ────────────────────────────────────────────────────

async function runInteractiveRepl() {
  printBanner();
  const sys = await initJarvisSystem();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const session = sys.sessionStore.createSession('CLI Session');
  let history: Message[] = [];

  while (true) {
    let input = '';
    try {
      input = await rl.question(`${c.cyan}${c.bold}jarvis${c.reset} ${c.gray}❯${c.reset} `);
    } catch {
      break; // Ctrl+C / EOF
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    // ── Slash Commands ───────────────────────────────────────────────────────
    if (trimmed.startsWith('/')) {
      const handled = await handleSlashCommand(trimmed, sys, rl, history);
      if (handled === 'EXIT') break;
      if (handled === 'CLEARED') history = [];
      continue;
    }

    // ── Run Query Through Pipeline with Marvel Spinner ───────────────────────
    const spinner = new JarvisSpinner();
    spinner.start();
    let streamStarted = false;

    try {
      const ctx = await sys.pipeline.buildContext(trimmed, history);

      // Stream response to terminal
      const stream = sys.router.stream(ctx.messages);
      let fullResponse = '';

      for await (const chunk of stream) {
        if (!streamStarted) {
          spinner.stop(true);
          streamStarted = true;
          process.stdout.write(`\n${c.cyan}${c.bold}JARVIS:${c.reset}\n`);
        }
        fullResponse += chunk;
        process.stdout.write(chunk);
      }

      if (!streamStarted) {
        spinner.stop(true);
      }
      process.stdout.write('\n\n');

      // ── Interactive Tabbed Question Form (AskUserQuestion) ──────────────────
      const questionRegex = /```ask_question\s*\n([\s\S]*?)\n```/;
      const questionMatch = fullResponse.match(questionRegex);

      if (questionMatch) {
        try {
          const payload = JSON.parse(questionMatch[1]);
          if (payload.questions && Array.isArray(payload.questions) && payload.questions.length > 0) {
            rl.pause();
            const decisions = await askUserQuestion(payload.questions);
            rl.resume();

            if (Object.keys(decisions).length > 0) {
              let decisionMsg = 'I have submitted the following design decisions:\n';
              for (const [k, v] of Object.entries(decisions)) {
                decisionMsg += `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}\n`;
              }
              decisionMsg += '\nPlease proceed with the implementation according to these specifications.';

              // Send decisions back to the LLM turn
              history.push({ role: 'user', content: trimmed });
              history.push({ role: 'assistant', content: fullResponse });
              history.push({ role: 'user', content: decisionMsg });

              const followUpSpinner = new JarvisSpinner('Synthesizing implementation with chosen specifications...');
              followUpSpinner.start();
              let followUpStarted = false;

              const followUpCtx = await sys.pipeline.buildContext(decisionMsg, history);
              const followUpStream = sys.router.stream(followUpCtx.messages);
              let followUpResponse = '';

              for await (const chunk of followUpStream) {
                if (!followUpStarted) {
                  followUpSpinner.stop(true);
                  followUpStarted = true;
                  process.stdout.write(`\n${c.cyan}${c.bold}JARVIS:${c.reset}\n`);
                }
                followUpResponse += chunk;
                process.stdout.write(chunk);
              }
              if (!followUpStarted) followUpSpinner.stop(true);
              process.stdout.write('\n\n');

              history.push({ role: 'assistant', content: followUpResponse });
              sys.sessionStore.appendMessage(session.id, { role: 'user', content: decisionMsg });
              sys.sessionStore.appendMessage(session.id, { role: 'assistant', content: followUpResponse });

              followUpCtx.response = followUpResponse;
              await sys.pipeline.runPostLlm(followUpCtx);

              if (followUpCtx.metadata.fileCreated) {
                const f = followUpCtx.metadata.fileCreated as any;
                console.log(`${c.green}✓ ${f.type === 'pdf' ? 'PDF compiled' : 'File saved'}:${c.reset} ${c.cyan}${f.path}${c.reset} (${(f.size / 1024).toFixed(1)} KB)\n`);
              }
              continue;
            }
          }
        } catch (e: any) {
          console.warn(`[question-form] Error processing question payload: ${e.message}`);
        }
      }

      // Update Session & History
      history.push({ role: 'user', content: trimmed });
      history.push({ role: 'assistant', content: fullResponse });
      sys.sessionStore.appendMessage(session.id, { role: 'user', content: trimmed });
      sys.sessionStore.appendMessage(session.id, { role: 'assistant', content: fullResponse });

      // Run post-LLM extraction & file/PDF creation asynchronously
      ctx.response = fullResponse;
      await sys.pipeline.runPostLlm(ctx);

      if (ctx.metadata.fileCreated) {
        const f = ctx.metadata.fileCreated as any;
        console.log(`${c.green}✓ ${f.type === 'pdf' ? 'PDF compiled' : 'File saved'}:${c.reset} ${c.cyan}${f.path}${c.reset} (${(f.size / 1024).toFixed(1)} KB)\n`);
      }

    } catch (err: any) {
      spinner.stop(true);
      console.log(`\n${c.red}Error:${c.reset} ${err.message}\n`);
    }
  }

  rl.close();
  console.log(`\n${c.gray}Good day, sir.${c.reset}`);
  process.exit(0);
}

// ─── Slash Commands Handler ───────────────────────────────────────────────────

async function handleSlashCommand(
  cmdLine: string,
  sys: Awaited<ReturnType<typeof initJarvisSystem>>,
  rl: readline.Interface,
  _history: Message[]
): Promise<string | void> {
  const [cmd, ...args] = cmdLine.split(' ');
  const rest = args.join(' ').trim();

  switch (cmd.toLowerCase()) {
    case '/exit':
    case '/quit':
      return 'EXIT';

    case '/clear':
      console.clear();
      printBanner();
      console.log(`${c.green}✓ Session history cleared.${c.reset}\n`);
      return 'CLEARED';

    // ── Signature Feature 2: Ephemeral Side Questions with /btw ──────────────
    case '/btw': {
      let sideQuestion = rest;
      if (!sideQuestion) {
        sideQuestion = (await rl.question(`${c.magenta}${c.bold}Side question (/btw):${c.reset} `)).trim();
      }
      if (!sideQuestion) break;

      const spinner = new JarvisSpinner('Inquiring with Friday on subterranean backup channels...');
      spinner.start();

      try {
        const sidePrompt = `You are J.A.R.V.I.S. (Vision/Marvel style). Answer this brief side question concisely, directly, and with Paul Bettany's dry British wit. Keep it under 3 sentences:\n\nQuestion: "${sideQuestion}"`;
        const answer = await sys.router.chat([
          { role: 'system', content: 'You are J.A.R.V.I.S., a witty, highly intelligent British AI assistant.' },
          { role: 'user', content: sidePrompt },
        ], { taskHint: 'quick', maxTokens: 256 });

        spinner.stop(true);
        renderEphemeralAside(sideQuestion, answer);
      } catch (e: any) {
        spinner.stop(true);
        console.log(`${c.red}Ephemeral query failed:${c.reset} ${e.message}\n`);
      }
      break;
    }

    // ── Signature Feature 1 Demo: Interactive Tabbed Form Wizard ─────────────
    case '/ask': {
      rl.pause();
      const sampleQuestions: QuestionTab[] = [
        {
          id: 'architecture',
          title: 'Architecture',
          question: 'Which architecture pattern do you prefer for this feature?',
          options: [
            'Modular Service Architecture (Recommended for JARVIS)',
            'Single-file micro-module',
            'Event-driven reactive pipeline',
            'Layered Clean Architecture',
          ],
          is_multi_select: false,
        },
        {
          id: 'storage',
          title: 'Storage Engine',
          question: 'Where should persistent records be stored?',
          options: [
            'SQLite with WAL mode (Recommended)',
            'LanceDB Vector Store',
            'JSON flat file',
          ],
          is_multi_select: false,
        },
        {
          id: 'capabilities',
          title: 'Capabilities',
          question: 'Select additional capabilities to enable for this task:',
          options: [
            'Real-time Web Search citations',
            'Obsidian Vault Knowledge RAG',
            'Automated PDF Compilation',
            'Voice Synthesis telemetry',
          ],
          is_multi_select: true,
        },
      ];

      await askUserQuestion(sampleQuestions);
      rl.resume();
      break;
    }

    case '/help':
      console.log(`
${c.bold}Signature Agent Capabilities:${c.reset}
  ${c.magenta}/btw <question>${c.reset}           Ephemeral side question in a floating card (leaves main context clean)
  ${c.brightCyan}/ask${c.reset}                      Launch interactive tabbed design decision form wizard
  ${c.yellow}/help${c.reset}                     Show this command guide
  ${c.yellow}/status${c.reset}                   Check system telemetry, LLM routing & memory stores
  ${c.yellow}/clear${c.reset}                    Clear terminal screen and conversation history
  ${c.yellow}/read <path>${c.reset}              Inspect local files in the workspace
  ${c.yellow}/write <path> <text>${c.reset}      Create or overwrite local files
  ${c.yellow}/pdf <filename> <text>${c.reset}    Compile a professional PDF document from markdown
  ${c.yellow}/search <query>${c.reset}           Run live web searches (Google News & DuckDuckGo)
  ${c.yellow}/rag <query>${c.reset}              Search your Obsidian Vault (LanceDB 768-dim vectors)
  ${c.yellow}/exec <command>${c.reset}           Execute a shell command with interactive confirmation
  ${c.yellow}/exit${c.reset}                     Exit JARVIS CLI

${c.bold}Natural Language Agent Commands:${c.reset}
  • Ask for architectural decisions:
    ${c.cyan}"I want to build a new telemetry microservice. Ask me for my preferences first."${c.reset}
  • Ask for document/PDF generation:
    ${c.cyan}"Generate an executive briefing on quantum computing and save as quantum.pdf"${c.reset}
  • Ask for live news or code inspections:
    ${c.cyan}"What's the latest on Ukraine?"${c.reset}
`);
      break;

    case '/status': {
      console.log(`\n${c.bold}J.A.R.V.I.S System Telemetry:${c.reset}`);
      const memoryCount = await sys.memoryStore.count();
      const profile = await sys.profileStore.getProfile('default');
      const vectorCount = await sys.vectorStore.count();
      console.log(`  • Memories in SQLite:  ${c.cyan}${memoryCount}${c.reset}`);
      console.log(`  • Obsidian LanceDB:    ${c.cyan}${vectorCount} chunks${c.reset}`);
      const roleStr = typeof profile?.context?.role === 'string' ? profile.context.role : 'User';
      console.log(`  • User Profile:        ${c.cyan}${profile?.name || 'User'}${c.reset} (${roleStr})`);
      console.log(`  • Workspace Root:      ${c.cyan}${process.cwd()}${c.reset}`);
      console.log(`  • Active Protocols:    ${c.cyan}Vision/Stark Protocol v1.0.0${c.reset}\n`);
      break;
    }

    case '/read': {
      if (!rest) {
        console.log(`${c.yellow}Usage:${c.reset} /read <file-path>\n`);
        break;
      }
      try {
        const content = sys.fileService.readFile(rest);
        console.log(`\n${c.dim}─── ${rest} ───${c.reset}\n${content}\n${c.dim}────────────────${c.reset}\n`);
      } catch (e: any) {
        console.log(`${c.red}Read failed:${c.reset} ${e.message}\n`);
      }
      break;
    }

    case '/write': {
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) {
        console.log(`${c.yellow}Usage:${c.reset} /write <file-path> <content>\n`);
        break;
      }
      const targetPath = rest.slice(0, spaceIdx).trim();
      const content = rest.slice(spaceIdx + 1).trim();
      try {
        const res = await sys.fileService.writeFile(targetPath, content);
        console.log(`${c.green}✓ Saved:${c.reset} ${res.path} (${res.size} bytes)\n`);
      } catch (e: any) {
        console.log(`${c.red}Write failed:${c.reset} ${e.message}\n`);
      }
      break;
    }

    case '/pdf': {
      const spaceIdx = rest.indexOf(' ');
      const filename = spaceIdx === -1 ? 'document.pdf' : rest.slice(0, spaceIdx).trim();
      const content = spaceIdx === -1 ? rest : rest.slice(spaceIdx + 1).trim();

      if (!content) {
        console.log(`${c.yellow}Usage:${c.reset} /pdf <filename.pdf> <markdown content>\n`);
        break;
      }
      try {
        console.log(`${c.dim}Compiling PDF...${c.reset}`);
        const res = await sys.fileService.createPdf(filename, content);
        console.log(`${c.green}✓ PDF compiled successfully:${c.reset} ${c.cyan}${res.path}${c.reset} (${(res.size / 1024).toFixed(1)} KB)\n`);
      } catch (e: any) {
        console.log(`${c.red}PDF creation failed:${c.reset} ${e.message}\n`);
      }
      break;
    }

    case '/search': {
      if (!rest) {
        console.log(`${c.yellow}Usage:${c.reset} /search <query>\n`);
        break;
      }
      console.log(`${c.dim}Searching the live web...${c.reset}`);
      const results = await sys.webSearch.search(rest, 4);
      console.log(`\n${c.bold}Web Search Results for "${rest}":${c.reset}`);
      for (const r of results) {
        console.log(`\n${c.cyan}• ${r.title}${c.reset} ${c.dim}[${r.source || 'Web'}]${c.reset}`);
        console.log(`  ${r.snippet}`);
        console.log(`  ${c.gray}Link: ${r.url}${c.reset}`);
      }
      console.log();
      break;
    }

    case '/rag': {
      if (!rest) {
        console.log(`${c.yellow}Usage:${c.reset} /rag <query>\n`);
        break;
      }
      console.log(`${c.dim}Searching Obsidian Vault LanceDB...${c.reset}`);
      try {
        const vec = await sys.router.embed!(rest);
        const matches = await sys.vectorStore.search(vec, 3);
        console.log(`\n${c.bold}Obsidian Vault Matches:${c.reset}`);
        for (const m of matches) {
          console.log(`\n${c.cyan}• ${m.metadata?.fileName || m.id}${c.reset} ${c.dim}(score: ${m.score?.toFixed(3)})${c.reset}`);
          console.log(`  ${(m.metadata?.content || '').slice(0, 200)}...`);
        }
        console.log();
      } catch (e: any) {
        console.log(`${c.red}RAG search failed:${c.reset} ${e.message}\n`);
      }
      break;
    }

    case '/exec': {
      if (!rest) {
        console.log(`${c.yellow}Usage:${c.reset} /exec <command>\n`);
        break;
      }
      const confirm = await rl.question(`${c.yellow}Execute command: "${rest}"? [y/N]: ${c.reset}`);
      if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
        try {
          console.log(`${c.dim}Running...${c.reset}`);
          const { stdout, stderr } = await execAsync(rest, { cwd: process.cwd() });
          if (stdout) console.log(stdout);
          if (stderr) console.log(`${c.yellow}${stderr}${c.reset}`);
          console.log(`${c.green}✓ Exited cleanly.${c.reset}\n`);
        } catch (e: any) {
          console.log(`${c.red}Command failed:${c.reset} ${e.message}\n`);
        }
      } else {
        console.log(`${c.dim}Cancelled.${c.reset}\n`);
      }
      break;
    }

    default:
      console.log(`${c.red}Unknown command:${c.reset} ${cmd}. Type ${c.yellow}/help${c.reset} for available commands.\n`);
  }
}

// ─── One-Shot Execution Mode ──────────────────────────────────────────────────

async function runOneShot(prompt: string) {
  const sys = await initJarvisSystem();
  const spinner = new JarvisSpinner();
  spinner.start();
  let streamStarted = false;

  try {
    const ctx = await sys.pipeline.buildContext(prompt, []);
    const stream = sys.router.stream(ctx.messages);
    let fullResponse = '';

    for await (const chunk of stream) {
      if (!streamStarted) {
        spinner.stop(true);
        streamStarted = true;
      }
      fullResponse += chunk;
      process.stdout.write(chunk);
    }
    if (!streamStarted) spinner.stop(true);
    process.stdout.write('\n');

    ctx.response = fullResponse;
    await sys.pipeline.runPostLlm(ctx);

    if (ctx.metadata.fileCreated) {
      const f = ctx.metadata.fileCreated as any;
      console.log(`\n${c.green}✓ ${f.type === 'pdf' ? 'PDF compiled' : 'File saved'}:${c.reset} ${c.cyan}${f.path}${c.reset} (${(f.size / 1024).toFixed(1)} KB)`);
    }
  } catch (err: any) {
    spinner.stop(true);
    console.error(`\n${c.red}Error:${c.reset} ${err.message}`);
    process.exit(1);
  }
}

// ─── Main Dispatcher ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    await runOneShot(args.join(' '));
  } else {
    await runInteractiveRepl();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
