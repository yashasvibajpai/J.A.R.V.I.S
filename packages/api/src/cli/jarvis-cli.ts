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
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { closeSync, existsSync, mkdirSync, openSync } from 'fs';
import { exec, spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
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
import { SQLiteResearchStore } from '../stores/SQLiteResearchStore.js';
import { SQLiteProviderQuota } from '../stores/SQLiteProviderQuota.js';
import { ResearchEngine } from '../engine/ResearchEngine.js';
import type { Message } from '@jarvis/shared';
import { researchState, researchUsageSummary, showResearchDashboard } from './research-dashboard.js';
import { isResearchDocumentHelp, showResearchDocumentHelp } from './research-document-help.js';
import { handleResearchWorkspaceCommand, printResearchText } from './research-workspace-cli.js';

import {
  c,
  canUseTerminalView,
  JarvisSpinner,
  renderEphemeralAside,
  askUserQuestion,
  JARVIS_TIPS,
  type QuestionTab,
} from './terminal-ui.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI Core Setup ───────────────────────────────────────────────────────────

function jarvisDataDirectory() {
  const DATA_DIR = resolve(__dirname, '../../../data');
  const ALT_DATA_DIR = resolve(__dirname, '../../data');
  return process.env.JARVIS_DATA_DIR ? resolve(process.env.JARVIS_DATA_DIR)
    : existsSync(DATA_DIR) ? DATA_DIR : ALT_DATA_DIR;
}

function wakeResearchWorker(store: SQLiteResearchStore, dataDir: string): void {
  if (!store.hasUnfinishedWork()) return;
  const pid = store.workerPid();
  if (pid) {
    try {
      process.kill(pid, 0);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
    }
  }
  const log = openSync(resolve(dataDir, 'research.log'), 'a');
  try {
    const worker = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--research-worker', dataDir], {
      detached: true, stdio: ['ignore', log, log],
    });
    worker.on('error', error => console.error(`Could not start research worker: ${error.message}`));
    worker.unref();
  } finally {
    closeSync(log);
  }
}

async function runResearchWorker(dataDir: string): Promise<void> {
  const store = new SQLiteResearchStore(resolve(dataDir, 'research.db'));
  const owner = randomUUID();
  if (!store.acquireWorker(owner, process.pid)) return;
  const quota = new SQLiteProviderQuota(resolve(dataDir, 'provider-quota.sqlite'));
  const router = new SmartRouter(buildProviderRegistry(), quota);
  const engine = new ResearchEngine(store, router, new WebSearchService(quota), new FileService(process.env.JARVIS_RESEARCH_OUTPUT_DIR), {
    logFile: resolve(dataDir, 'research.log'),
  });
  engine.start();
  const heartbeat = setInterval(() => {
    if (!store.renewWorker(owner) || store.releaseWorkerWhenIdle(owner)) {
      clearInterval(heartbeat);
      engine.stop();
    }
  }, 3000);
}

export async function initJarvisSystem() {
  const dataDir = jarvisDataDirectory();
  mkdirSync(dataDir, { recursive: true });

  const quota = new SQLiteProviderQuota(resolve(dataDir, 'provider-quota.sqlite'));
  const router = new SmartRouter(buildProviderRegistry(), quota);
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

  const webSearch = new WebSearchService(quota);
  const fileService = new FileService();

  const researchStore = new SQLiteResearchStore(resolve(dataDir, 'research.db'));
  const researchEngine = new ResearchEngine(
    researchStore,
    router,
    webSearch,
    process.env.JARVIS_RESEARCH_OUTPUT_DIR ? new FileService(process.env.JARVIS_RESEARCH_OUTPUT_DIR) : fileService,
    { logFile: resolve(dataDir, 'research.log'), wakeWorker: () => wakeResearchWorker(researchStore, dataDir) }
  );
  // Resume unfinished research independently of the REPL.
  researchEngine.start();

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
    researchStore,
    researchEngine,
  };
}

// ─── Welcome Banner ───────────────────────────────────────────────────────────

const VISION_ASCII = `********************************************************************************
************************************###%%###****#*******************************
***********************#*##%%%@@@@@@@@@@@@@@@@@@@@%%%##*************************
*********************%@@@@@#++=----------------==+++#@@@@@%*#*******************
******************@@@@*-:.................::::.:::::.:::-*@@@@******************
***************%@@@=-...........:::=#%%%#*+++*#+==----:::--==%@@%#**************
*************%@@#=-........:-*@#%@%%%%%##*****#**####++*+==+==+#@@#*************
***********#%@%+-::...:--*@@@%%#**#**+=+======+++*##**##**+==+==+%@%#***********
**********#%@*=++#%%%#*@@%%%##*===---------==========++*#%%%@%%#*=*@%#**********
*******###%@**#++***#%@@@@%*+=----==+*+**##*#%#%%%%###%%##%#%#**%%**@%#*********
*********%@***+****%@@%%****#*==++*********#***##%%@@@@@@%%######@%**@%*********
********#@%#*****#@@##***++**#%%#**************##%%%%@@@@@@@%####%%*%%@%%###****
******#%@@*#***+*#%#***=+**##%%%%%#*#*#***##**#%%%%%%%%@@@@@@%####@@#*@@@@@@%%#*
**@@@@@%%@#+**+=#%%**+-=*##%%%%%%%@####***###%%%%%%%%%%%@@@@@@%#*#%#*@@*====#@@@
@@%+...=@@@#**==#@#*+--*##%#%%%%%%%#@**#***%%%%%%%%%%%%%@@@@@@@%**##*@@@*==-:...
.......=@###%%++%@**=-=*#%%%%%%%%%%%%@####@#%%%%%%%%%%%%@@@@@@@@%*##*#%@*==-:...
.......=@###%%++%%**==+*#%%%%%%%%%%%%%%@#%%%%%%%%%%%%%%@@@@@@@@@##%#**#@*==-:...
.......=@#*#%%++%%**==+*#%%%%%%%%%%%%%%%@%%%%%%%%%%%%@@@@@@@@@@@#*#*++#@*==-:...
.......=@#+#%#++%@#*==+*%%%%%%%%%%%%%%@. @%%%%%%%%@@@%%@@@@@@@@@##%*=*@@*=--:...
.......=@@*#@#++#@#*==+*#%%%%%%%%%%%%%%  #%%%%%%@@@@%%@@@@@@@@@%#***=#@@*=-::...
.......=@@%#%*=+%@#*+=+*#%#%%%%%%%%%%%@:-%%%%%@@@@@%%@@@@@@@@@@%#+**=#@@*=-::...
.......-#@%#+=+*%@%%****##%%%%%%%@@%%#%#=@%%%%@@@@%%@@@@@@##**#@@%%#+#@#+=-::...
.......=%@##*+*%@%#*==-==*##%@@@@%@@%%%%%%%%%%@@@%%@@@%%%%%%##***%@%##@%+=-:::..
......=@@@#*++*%%#****====+*%@@@@%%@@%%%%%#%%%@%##@@%###%%%%###**@@@#*%@@+=-::::
.....-@%@%*++*%@@@@@*******#**%@@%%@@@@%%%#%%#*#%@@#+++*####@@@@@@%#*#%@@@+-::::
....-@*=@%*++*%@@@@@@%#++****###%@%#@@@@%%%%%####*+===+=+%@@@@@@@%%##%%%+#%+-:::
....-%-=@%+==+#%@@@@%#+:=+****#%####%@@@%@@%###*+=+***+--+*%@@@@%%%##%%%++%+-:::
...:=#.=@%+===*#%@@@%#*=+*%@@@%%%%#%%#@%#@%######%@@@%*+=*#@@@@%%%%##@@@*-#*=-::
....=#-*@%**===**#%@@%%%%@@@@@@@@@@@%%%%%%#%%@@@@@@@@@%%%@@@@@%%###*#@@@#*%*==-:
....-%*#@%#**+=++***#%%%%%%%%%@@@@@%##%%%#+#@@@@@@@%%@@@@@@@%##*+**#%@@@#*%+====
....-%%*#@%##***======++****%@@@@@%++#%%%@+#@@@@@@@@@@@@@@@%%*+++*#%@@@#*%@+====
....:=@##@@@%##**#==+#****#%%%%%%#*=+%%%%%@#@@@@%@@@@%%%%%#*+++**#@@@@@##@+=====
...:::=@##@@@@%###****####%%######+=+*#%%%%+@@@@@%%##%%####***##@@@@@@##@*======
:::::::=#@@%%@@@%%#%%##%%%%%%##*+===+*%%#@@@@@@@%%%#%%%%%%@%%%@@@@%%%@@%+=======
::::::-==*@@%*#%%%#*####%%%##%#*=-==+*#%#@%@@@@%%%%%%###%@@@@@@@@#*%@@*=========
::::--====#@*++%@%#*+*#%%%%%###*+++=+#%%%@@@@%%#%%%%%%#**#@@@@%*++**@#==========
:::-======*@#+=%@%#*=*#%%%#***#%%++###%%%@#%#@%#%###%@%*+*%@@@@@%*+#@*==========
--========*@%*=%@%#*=*#%%#*+*%%%%%*%%*%%%%#%%#%%@%%**#@%*+#%@@@@#**%@*==========
===========#@*=%@%#*=*#%##**#%#**%%%%*#%%#+%@@@@@@@%*+#@#+*#@@@#***@#===========
===========#@@##@%#++*#%#####*+***#%%@%#*#@@@%%%%@@@%*+*#++*@@@%+#@@#===========
===========#@@@%%%#+=**###%#*+****#%@%%@@%@@%%#%%%%@@%+**++#@@#+#@@@#===========
===========#@@@@@%%*=**###%%#**#@@@@@@@@@@@@@@@@%%%%%@*+*++%@@@%@@@@#===========
===========#@#*%@@#*+**###%%#**++++++++++******#*##%#%@**++@@+@@@%#@#===========
===========#@*+*%@@%++%####%##%#%%%@%%%%%%%%%@%%%%%%%@@**+%@%@@@%#+@#===========
===========#@*=**#@@@++%##**++#%%%%%%@@@@@@%%%%%%%%%%@@#%++@@#@%+=*@#===========
===========#@*=+*%#@@@*+#%##*#%%@@@%%%#%%%%%%%%%%%%@@@%*+*@@@@%+==*@#==========+
%*=========#@*++**@#@@@@#####***##%%%%%%%%%%%%%%%%%%@%+*%@%@@%*+=+*@#========*@@
@@@*=======#@*++***@#@@@@%*##*++**#%%%%%%%%%%%%%%@%*++#@@@@@@**+##+@#======*%@+.
.-*@%*=====#@*#++**%@#@@@@%*+*####%%%%%%%%%%%%%%%%#+*%@@@@@@**=+##+@#====*%@#:..
...:+@%*=+#%%+*++***@%#@@@@%##**%%@@@@*++*%@@@@@@%%%@@@@@@@%*+++##+%%#+=#@@+:...
.....:+@@@##*===+#*#@@#@@@@@@@@@@@%%%%@@@%%%%%%@@@@@@@@@@@@**++#%%=*%#@@@+:...::
.......:+@@%*+##****%++#@@@@@%%@@@@@@@@@@@@@@@@@%#@@@@@@@@#*+==*%#=+**@@=..::::%
:::::.....+@@#*%+**#*%=+#@@@@@@@@@@@@@@@@@@@@@%%#@@@@@@@@#**+=+#@#=+%@*:.::-%@@@
@---::::::.=%@@#+***@@=+#@@@@@%#%@@@@@@@@@@@%@%*#@@@@@@@%@*++++%@%*@@+:::-%@%+==
%%@@@%*=-::::+%@@***@#++*%@@@@@%**%@@@@@@@@@@#+*@@@@@@@%@%#++++@@@@%+::-#@%+====
====+#%@@@#+-:=%@@%%@@*+*#@@@@@@#++**@@@@@@@%**@@@@@@@@@@@*+*+#@@@%+::=#@%+===-:
-=======+*%@@#+-%@%@@@%=+%%@@@@@@#+++#@@@@@@%*@@@@@@@@%@@@+++*#@@#-::+%@*===-:::`;

function printBanner() {
  console.log(`\n${c.cyan}${VISION_ASCII}${c.reset}\n\n${c.bold}${c.brightCyan}                                    JARVIS${c.reset}\n`);
}

/**
 * Streams LLM output to terminal with rich support for reasoning/thoughts (<think> tags).
 * When reasoning tokens arrive, dims the output and indicates active reasoning matrix.
 * When actual response arrives, switches to bold cyan JARVIS banner.
 */
async function streamResponseWithReasoning(
  stream: AsyncGenerator<string>,
  spinner: JarvisSpinner
): Promise<string> {
  let streamStarted = false;
  let inThink = false;
  let jarvisHeaderPrinted = false;
  let fullResponse = '';

  for await (const rawChunk of stream) {
    if (!streamStarted) {
      spinner.stop(true);
      streamStarted = true;
    }
    fullResponse += rawChunk;

    let remaining = rawChunk;
    while (remaining.length > 0) {
      if (!inThink) {
        const thinkIndex = remaining.indexOf('<think>');
        if (thinkIndex !== -1) {
          const before = remaining.slice(0, thinkIndex);
          if (before) {
            if (!jarvisHeaderPrinted) {
              process.stdout.write(`\n${c.cyan}${c.bold}JARVIS:${c.reset}\n`);
              jarvisHeaderPrinted = true;
            }
            process.stdout.write(before);
          }
          inThink = true;
          process.stdout.write(`\n${c.magenta}🧠 Deliberative Reasoning Matrix:${c.reset}\n${c.dim}`);
          remaining = remaining.slice(thinkIndex + 7);
        } else {
          if (!jarvisHeaderPrinted) {
            process.stdout.write(`\n${c.cyan}${c.bold}JARVIS:${c.reset}\n`);
            jarvisHeaderPrinted = true;
          }
          process.stdout.write(remaining);
          remaining = '';
        }
      } else {
        const closeIndex = remaining.indexOf('</think>');
        if (closeIndex !== -1) {
          const thinkText = remaining.slice(0, closeIndex);
          process.stdout.write(thinkText);
          inThink = false;
          process.stdout.write(`${c.reset}\n\n${c.cyan}${c.bold}JARVIS:${c.reset}\n`);
          jarvisHeaderPrinted = true;
          remaining = remaining.slice(closeIndex + 8);
        } else {
          process.stdout.write(remaining);
          remaining = '';
        }
      }
    }
  }

  if (inThink) {
    process.stdout.write(`${c.reset}\n`);
  }

  if (!streamStarted) {
    spinner.stop(true);
    console.log(`\n${c.yellow}⚠️  No response received from model. Please verify provider status or try rephrasing.${c.reset}`);
  }
  process.stdout.write('\n\n');
  return fullResponse;
}

// ─── Interactive REPL Loop ────────────────────────────────────────────────────

async function runInteractiveRepl() {
  printBanner();
  const sys = await initJarvisSystem();
  const createInput = () => readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  let rl = createInput();
  let terminalViewOpen = false;

  const session = sys.sessionStore.createSession('CLI Session');
  let history: Message[] = [];
  let activeReasoningEffort: 'low' | 'medium' | 'high' | undefined = undefined;

  const notified = new Map((await sys.researchEngine.listMissions(100))
    .map(mission => [mission.id, mission.status]));
  const researchNotifications = setInterval(() => {
    if (terminalViewOpen) return;
    void sys.researchEngine.listMissions(100).then(missions => {
      if (terminalViewOpen) return;
      for (const mission of missions) {
        const previous = notified.get(mission.id);
        notified.set(mission.id, mission.status);
        if (previous === mission.status) continue;
        if (mission.status === 'completed') printResearchText(`\nResearch completed · ${mission.id} · ${mission.reportPath ?? mission.topic}`);
        if (mission.status === 'failed') printResearchText(`\nResearch failed · ${mission.id} · ${mission.error ?? mission.topic}`);
      }
    }).catch(error => console.error(String(error)));
  }, 2500);
  researchNotifications.unref();

  while (true) {
    let input = '';
    try {
      input = await rl.question(`${c.cyan}${c.bold}jarvis${c.reset} ${c.gray}❯${c.reset} `);
    } catch {
      break; // Ctrl+C / EOF
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    let activeQuery = trimmed;
    let queryEffort: 'low' | 'medium' | 'high' | undefined = activeReasoningEffort;

    // ── Deep Investigation Prefix /deep <query> ──────────────────────────────
    if (trimmed.startsWith('/deep ')) {
      activeQuery = trimmed.slice(6).trim();
      queryEffort = 'high';
      console.log(`\n${c.magenta}🧠 Deep Reasoning Matrix Engaged${c.reset} ${c.dim}(reasoning_effort: high)${c.reset}\n`);
    } else if (trimmed.startsWith('/')) {
      const dashboard = researchDashboardCommand(trimmed);
      const view = isResearchDocumentHelp(trimmed) ? showResearchDocumentHelp
        : dashboard ? () => showResearchDashboard(sys.researchEngine, dashboard.id) : undefined;
      if (view && canUseTerminalView()) {
        terminalViewOpen = true;
        rl.close();
        try {
          await view();
        } catch (error) {
          console.error(String(error));
        } finally {
          terminalViewOpen = false;
          rl = createInput();
        }
        continue;
      }
      const handled = await handleSlashCommand(trimmed, sys, rl, history, {
        getReasoning: () => activeReasoningEffort,
        setReasoning: val => { activeReasoningEffort = val; },
      });
      if (handled === 'EXIT') break;
      if (handled === 'CLEARED') history = [];
      continue;
    }

    // ── Run Query Through Pipeline with Marvel Spinner ───────────────────────
    const spinner = new JarvisSpinner(
      queryEffort === 'high' ? 'Engaging deep deliberative reasoning matrix...' : undefined
    );
    spinner.start();

    try {
      const ctx = await sys.pipeline.buildContext(activeQuery, history);

      // Stream response to terminal with designated reasoning effort
      const stream = sys.router.stream(
        ctx.messages,
        queryEffort ? { reasoningEffort: queryEffort, taskHint: queryEffort === 'high' ? 'reasoning' : undefined } : undefined
      );

      const fullResponse = await streamResponseWithReasoning(stream, spinner);

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
              history.push({ role: 'user', content: activeQuery });
              history.push({ role: 'assistant', content: fullResponse });
              history.push({ role: 'user', content: decisionMsg });

              const followUpSpinner = new JarvisSpinner('Synthesizing implementation with chosen specifications...');
              followUpSpinner.start();

              const followUpCtx = await sys.pipeline.buildContext(decisionMsg, history);
              const followUpStream = sys.router.stream(
                followUpCtx.messages,
                queryEffort ? { reasoningEffort: queryEffort, taskHint: queryEffort === 'high' ? 'reasoning' : undefined } : undefined
              );

              const followUpResponse = await streamResponseWithReasoning(followUpStream, followUpSpinner);

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

  clearInterval(researchNotifications);
  rl.close();
  console.log(`\n${c.gray}Good day, sir.${c.reset}`);
  process.exit(0);
}

// ─── Slash Commands Handler ───────────────────────────────────────────────────

async function handleSlashCommand(
  cmdLine: string,
  sys: Awaited<ReturnType<typeof initJarvisSystem>>,
  rl: readline.Interface,
  _history: Message[],
  reasoningControls?: {
    getReasoning: () => 'low' | 'medium' | 'high' | undefined;
    setReasoning: (val: 'low' | 'medium' | 'high' | undefined) => void;
  }
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

    // ── Long-Running Autonomous Background Research Engine ─────────────────
    case '/research':
    case '/bg': {
      await handleResearchCommand(rest, sys.researchEngine);
      break;
    }

    // ── Reasoning Engine Effort Control ──────────────────────────────────────
    case '/reason': {
      const mode = rest.toLowerCase();
      if (!mode) {
        const current = reasoningControls?.getReasoning() ?? 'auto (SmartRouter adaptive)';
        console.log(`\n${c.bold}Reasoning Engine Configuration:${c.reset}`);
        console.log(`  • Active Level: ${c.cyan}${current}${c.reset}`);
        console.log(`  • Usage:        ${c.yellow}/reason high${c.reset} | ${c.yellow}/reason medium${c.reset} | ${c.yellow}/reason low${c.reset} | ${c.yellow}/reason auto${c.reset}\n`);
        break;
      }
      if (mode === 'high' || mode === 'medium' || mode === 'low') {
        reasoningControls?.setReasoning(mode);
        console.log(`${c.green}✓ Reasoning effort set to:${c.reset} ${c.bold}${mode.toUpperCase()}${c.reset} (Allocating extended deliberation tokens)\n`);
      } else if (mode === 'auto') {
        reasoningControls?.setReasoning(undefined);
        console.log(`${c.green}✓ Reasoning effort reset to:${c.reset} ${c.bold}AUTO${c.reset} (SmartRouter will select dynamically per task)\n`);
      } else {
        console.log(`${c.yellow}Invalid option. Use:${c.reset} /reason [high | medium | low | auto]\n`);
      }
      break;
    }

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
        const sidePrompt = `You are J.A.R.V.I.S., a witty, highly intelligent British AI assistant. Answer this brief side question concisely, directly, and with dry British wit. Keep it under 3 sentences:\n\nQuestion: "${sideQuestion}"`;
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
  ${c.brightGreen}/research <topic>${c.reset}          Start a background research mission
  ${c.brightGreen}/research -d <topic>${c.reset}       Investigate until the evidence is sufficient or leads are exhausted
  ${c.brightGreen}/research dashboard [id]${c.reset}   Open the interactive research monitor
  ${c.brightGreen}/research status [id]${c.reset}      Inspect progress, steps, findings, and model usage
  ${c.brightGreen}/research list${c.reset}             List all recent background research sessions
  ${c.brightGreen}/research pause|resume <id>${c.reset}  Pause or resume a research mission
  ${c.brightGreen}/research stop <id>${c.reset}        Stop and publish the latest checkpoint
  ${c.brightGreen}/research report <id>${c.reset}      Read the report or current findings
  ${c.brightGreen}/research publish <id>${c.reset}     Export a paused, stopped, or completed briefing
  ${c.brightGreen}/research diagnose <id> [--trace]${c.reset} Inspect source failures, branch decisions, and model calls
  ${c.brightGreen}/research steer <id> <instruction>${c.reset}  Redirect a deep mission
  ${c.brightGreen}/research fact-check <id> <claim>${c.reset}    Recheck a finding with original sources
  ${c.brightGreen}/research sources <id> [source]${c.reset}      Inspect retrieved sources
  ${c.brightGreen}/research reopen <id> [instruction]${c.reset}  Continue a finished deep mission
  ${c.brightGreen}/research doc <operation> <id>${c.reset}      List, create, edit, merge, trim, or export research documents
  ${c.brightGreen}/research doc help${c.reset}        Open the tabbed guide to research document commands
  ${c.magenta}/reason [low|med|high|auto]${c.reset} Adjust reasoning effort & thinking token depth
  ${c.magenta}/deep <query>${c.reset}              Run query with deep analytical investigation and maximum reasoning
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
  • Ask for autonomous background research:
    ${c.cyan}"/research Comprehensive analysis of solid-state battery commercialization"${c.reset}
  • Ask for deep investigations:
    ${c.cyan}"/deep Create a comprehensive outage report with root causes and blast radiuses"${c.reset}
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
      const activeResearch = await sys.researchStore.getActiveSession();
      const currentReasoning = reasoningControls?.getReasoning()?.toUpperCase() ?? 'Adaptive (SmartRouter)';
      console.log(`  • Memories in SQLite:  ${c.cyan}${memoryCount}${c.reset}`);
      console.log(`  • Obsidian LanceDB:    ${c.cyan}${vectorCount} chunks${c.reset}`);
      const roleStr = typeof profile?.context?.role === 'string' ? profile.context.role : 'User';
      console.log(`  • User Profile:        ${c.cyan}${profile?.name || 'User'}${c.reset} (${roleStr})`);
      console.log(`  • Workspace Root:      ${c.cyan}${process.cwd()}${c.reset}`);
      console.log(`  • Reasoning Effort:    ${c.cyan}${currentReasoning}${c.reset}`);
      const researchStr = activeResearch
        ? `${c.green}Active${c.reset} (${activeResearch.progress}% - ${activeResearch.currentStepTitle || 'Running'})`
        : `${c.dim}Idle (Ready for /research)${c.reset}`;
      console.log(`  • Background Research: ${researchStr}`);
      console.log(`  • Core Architecture:  ${c.cyan}Autonomous Agentic Pipeline v2.5.0${c.reset}\n`);
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

// ─── Research Command Handler ─────────────────────────────────────────────────

function researchDashboardCommand(input: string): { id?: string } | undefined {
  const match = /^\/(?:research|bg)\s+dashboard(?:\s+(.+))?$/i.exec(input);
  return match ? { id: match[1]?.trim() } : undefined;
}

async function handleResearchCommand(
  rawInput: string,
  engine: ResearchEngine
): Promise<void> {
  const parts = rawInput.trim().split(/\s+/);
  const subCmd = parts[0]?.toLowerCase();
  const rest = rawInput.trim().slice(parts[0]?.length ?? 0).trim();

  if (subCmd === 'dashboard') {
    await showResearchDashboard(engine, rest || undefined);
    return;
  }
  if (await handleResearchWorkspaceCommand(subCmd, rest, engine)) return;

  if (!rawInput.trim() || subCmd === 'list') {
    const missions = await engine.listMissions(10);
    if (missions.length === 0) {
      console.log(`\n${c.yellow}No research missions found.${c.reset}`);
      console.log(`Launch one with: ${c.cyan}/research <topic>${c.reset}\n`);
      return;
    }
    console.log(`\n${c.bold}Autonomous Research Missions:${c.reset}`);
    for (const m of missions) {
      const statusColor = m.status === 'completed' ? c.green : m.status === 'in_progress' ? c.cyan : m.status === 'paused' ? c.yellow : c.red;
      const bar = m.depth === 'deep' ? '[deep]' : renderProgressBar(m.progress);
      console.log(`  ${c.dim}${m.id}${c.reset} [${statusColor}${researchState(m).toUpperCase()}${c.reset}] ${bar} ${c.bold}${m.topic.slice(0, 45)}${c.reset}`);
      if (m.currentStepTitle && m.status === 'in_progress') {
        console.log(`    ${c.dim}↳ Active: ${m.currentStepTitle}${c.reset}`);
      }
      if (m.reportPath) {
        console.log(`    ${c.dim}↳ Report: ${m.reportPath}${c.reset}`);
      }
    }
    console.log();
    return;
  }

  if (subCmd === 'status') {
    const targetId = rest || undefined;
    const { session, steps, activeStep } = await engine.getStatus(targetId);
    if (!session) {
      console.log(`\n${c.yellow}No active or matching research session found.${c.reset}\n`);
      return;
    }

    const statusColor = session.status === 'completed' ? c.green : session.status === 'in_progress' ? c.cyan : c.yellow;
    console.log(`\n${c.bold}Mission Telemetry:${c.reset} ${c.dim}${session.id}${c.reset}`);
    console.log(`  • Topic:    ${c.bold}${session.topic}${c.reset}`);
    const state = engine.getResearchState(session.id);
    console.log(`  • State:    [${statusColor}${researchState(session).toUpperCase()}${c.reset}] ${session.depth === 'deep' ? 'Deep research' : renderProgressBar(session.progress)}`);
    if (state) {
      const answered = state.questions.filter(question => question.status === 'answered').length;
      console.log(`  • Coverage: ${answered}/${state.questions.length} questions answered · ${state.sources.length} source records`);
      if (state.stopReason) printResearchText(`  • Finish: ${state.stopReason}`);
    }
    console.log(`  • Findings: ${c.cyan}${session.findings.length} collected${c.reset}`);
    if (session.retryAt && session.retryAt > Date.now()) console.log(`  • Next retry: ${new Date(session.retryAt).toLocaleString()}`);
    if (session.error) console.log(`  • Error: ${session.error}`);
    for (const line of researchUsageSummary(engine.getUsage(session.id))) console.log(`  • ${line}`);
    if (activeStep) {
      console.log(`  • Current:  ${c.brightCyan}Step ${activeStep.stepNumber}/${session.totalSteps}:${c.reset} ${activeStep.title}`);
    }
    if (session.reportPath) {
      console.log(`  • Report:   ${c.green}${session.reportPath}${c.reset}`);
    }
    if (session.pdfPath) {
      console.log(`  • PDF:      ${c.green}${session.pdfPath}${c.reset}`);
    }

    if (steps.length > 0) {
      console.log(`\n  ${c.dim}Execution Steps:${c.reset}`);
      for (const s of steps) {
        const icon = s.status === 'completed' ? `${c.green}✓${c.reset}` : s.status === 'running' ? `${c.cyan}⠋${c.reset}` : s.status === 'failed' ? `${c.red}✗${c.reset}` : `${c.gray}○${c.reset}`;
        console.log(`    ${icon} ${s.stepNumber}. ${s.title}`);
      }
    }
    console.log();
    return;
  }

  if (subCmd === 'report') {
    if (!rest) {
      console.log('Usage: /research report <mission-id>');
      return;
    }
    const [id, document] = rest.split(/\s+/, 2);
    const { session } = await engine.getStatus(id);
    if (!session) {
      console.log(`Research mission ${rest} was not found.`);
      return;
    }
    if (document) {
      await handleResearchWorkspaceCommand('doc', `show ${id} ${document}`, engine);
      return;
    }
    const findings = session.findings.map(finding => `- ${finding.claim} (${finding.url ?? finding.source})`);
    printResearchText(engine.getWorkingReport(session) || ['Working findings', ...(findings.length ? findings : ['No findings committed yet.'])].join('\n'));
    if (session.reportPath) console.log(`Markdown: ${session.reportPath}`);
    if (session.pdfPath) console.log(`PDF: ${session.pdfPath}`);
    return;
  }

  if (subCmd === 'stop') {
    if (!rest) {
      console.log('Usage: /research stop <mission-id>');
      return;
    }
    try {
      const stopped = await engine.stopMission(rest);
      const report = stopped ? (await engine.getStatus(rest)).session?.reportPath : undefined;
      console.log(stopped ? `Stopped research mission ${rest}. Checkpoint saved to ${report}.` : `Cannot stop mission ${rest} in its current state.`);
    } catch (error) {
      console.error(String(error));
    }
    return;
  }

  if (subCmd === 'cancel') {
    if (!rest) {
      console.log(`${c.yellow}Usage:${c.reset} /research cancel <mission-id>\n`);
      return;
    }
    const ok = await engine.cancelMission(rest);
    if (ok) {
      console.log(`${c.green}✓ Cancelled research mission ${rest}.${c.reset}\n`);
    } else {
      console.log(`${c.red}Mission ${rest} not found or already completed.${c.reset}\n`);
    }
    return;
  }

  if (subCmd === 'pause') {
    if (!rest) {
      console.log(`${c.yellow}Usage:${c.reset} /research pause <mission-id>\n`);
      return;
    }
    const ok = await engine.pauseMission(rest);
    console.log(ok ? `${c.yellow}⏸ Paused mission ${rest}.${c.reset}\n` : `${c.red}Could not pause ${rest}.${c.reset}\n`);
    return;
  }

  if (subCmd === 'resume') {
    if (!rest) {
      console.log(`${c.yellow}Usage:${c.reset} /research resume <mission-id>\n`);
      return;
    }
    const ok = await engine.resumeMission(rest);
    console.log(ok ? `${c.green}▶ Resumed mission ${rest}.${c.reset}\n` : `${c.red}Could not resume ${rest}.${c.reset}\n`);
    return;
  }

  // Otherwise treat entire rawInput as research topic
  const deep = /^(?:-d|--depth\s+deep)(?:\s+--(?=\s|$))?(?:\s+|$)/i.exec(rawInput.trim());
  const topic = deep ? rawInput.trim().slice(deep[0].length).trim() : rawInput.trim();
  if (!topic || (subCmd === '--depth' && !deep)) {
    console.log('Usage: /research -d <topic>');
    return;
  }
  const session = await engine.startMission(topic, deep ? 'deep' : 'brief');

  console.log(`\n${c.cyan}┌─────────────────────────────────────────────────────────────┐${c.reset}`);
  console.log(`${c.cyan}│${c.reset} ${c.bold}${c.brightCyan}🚀 Autonomous Research Matrix Dispatched${c.reset}                   ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}                                                             ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  • Mission ID:  ${c.brightYellow}${session.id.padEnd(42)}${c.reset} ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  • Topic:       ${c.bold}"${session.topic.slice(0, 39).padEnd(39)}"${c.reset} ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  • Heartbeat:   ${c.green}Tick engine active (3.5-second interval)${c.reset}     ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  • Providers:   ${c.dim}Configured free model providers${c.reset}              ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  • Deliverable: ${c.cyan}~/Downloads (Markdown + PDF)${c.reset}                 ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}                                                             ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}│${c.reset}  ${c.dim}JARVIS remains unblocked. Chat as normal or run /research status.${c.reset} ${c.cyan}│${c.reset}`);
  console.log(`${c.cyan}└─────────────────────────────────────────────────────────────┘${c.reset}\n`);
  console.log(`Open the dashboard with /research dashboard ${session.id}\n`);
}

function renderProgressBar(pct: number): string {
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const empty = Math.max(0, width - filled);
  return `${c.cyan}[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%${c.reset}`;
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
  if (args[0] === '--research-worker' && args[1]) {
    await runResearchWorker(args[1]);
    return;
  }
  if (args.length > 0) {
    const fullInput = args.join(' ').trim();
    if (fullInput.startsWith('/')) {
      if (isResearchDocumentHelp(fullInput)) {
        await showResearchDocumentHelp();
        return;
      }
      const sys = await initJarvisSystem();
      const dashboard = researchDashboardCommand(fullInput);
      if (dashboard) {
        await showResearchDashboard(sys.researchEngine, dashboard.id);
        process.exit(0);
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await handleSlashCommand(fullInput, sys, rl, []);
      rl.close();
      process.exit(0);
    }
    await runOneShot(fullInput);
  } else {
    await runInteractiveRepl();
  }
}

const isDirectRun = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith('jarvis-cli.ts') ||
   process.argv[1].endsWith('jarvis-cli.js') ||
   basename(process.argv[1]) === 'jarvis')
);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
