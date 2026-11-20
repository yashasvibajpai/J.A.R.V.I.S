/**
 * J.A.R.V.I.S — Terminal UI & Interaction Engine
 *
 * Replicates signature Claude Code CLI features:
 * 1. Animated Agent Spinner Verbs & Context Tips
 * 2. Ephemeral Side Questions (/btw) with isolated floating overlay
 * 3. Interactive Tabbed Question Forms (AskUserQuestion wizard)
 */

import readline from 'readline';

export function canUseTerminalView(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb');
}

// ─── ANSI Colors & Styling ───────────────────────────────────────────────────

export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  cyan: '\x1b[36m',
  brightCyan: '\x1b[96m',
  green: '\x1b[32m',
  brightGreen: '\x1b[92m',
  yellow: '\x1b[33m',
  brightYellow: '\x1b[93m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  bgDark: '\x1b[48;5;236m',
  bgCyan: '\x1b[46m\x1b[30m',
};

// ─── Agent Spinner Verbs ──────────────────────────────────────────────────────

export const JARVIS_SPINNER_VERBS = [
  'Calibrating repulsor telemetry...',
  'Rerouting auxiliary power to secondary thrusters...',
  'Consulting the House Party Protocol schematics...',
  'Modulating vibranium matrix frequencies...',
  'Scanning the Stark Industries mainframe...',
  'Synthesizing neural pathways with the Mind Stone...',
  'Running diagnostics on Mark VII avionics...',
  'Recalibrating arc reactor flux density...',
  'De-icing Mark XLII high-altitude flight surfaces...',
  'Accessing orbital defense satellite telemetry...',
  'Cross-referencing S.H.I.E.L.D. threat database...',
  'Balancing equations in fractional dimensions...',
  'Inquiring with Friday on subterranean backup channels...',
  'Synchronizing holographic heads-up display...',
  'Verifying Sokovia Accords compliance parameters...',
  'Fine-tuning acoustic dampeners for silent flight...',
  'Calculating optimal trajectory for hypersonic descent...',
  'Charging unibeam capacitor banks...',
  'Interfacing with Veronica in geosynchronous orbit...',
  'Analyzing molecular structure of vibranium nanotech...',
  'Running simulation 47-B for tactical contingencies...',
  'Optimizing power distribution across Jarvis sub-routines...',
];

export const JARVIS_TIPS = [
  'Tip: Use /btw <question> to ask a quick side query without polluting your conversation context, sir.',
  'Tip: Ask me to compile any briefing into a PDF with "save as docs/summary.pdf".',
  'Tip: /rag <query> searches your 6,000+ Obsidian Vault chunks stored in LanceDB.',
  'Tip: /search <query> conducts live Google News & DuckDuckGo searches with zero API keys.',
  'Tip: Use /status to inspect active LLM routing, SQLite memory count, and profile telemetry.',
  'Tip: Need to run shell commands? /exec runs commands with interactive confirmation.',
  'Tip: /clear purges short-term buffer while preserving long-term memories in SQLite.',
  'Tip: You can ask for architectural decisions; I will present an interactive tabbed questionnaire.',
];

// ─── Whimsical Marvel Spinner ────────────────────────────────────────────────

export class JarvisSpinner {
  private timer: NodeJS.Timeout | null = null;
  private verbTimer: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  private currentVerb: string;
  private currentTip: string;
  private isSpinning = false;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private startTime = 0;

  constructor(initialVerb?: string) {
    this.currentVerb = initialVerb || this.randomVerb();
    this.currentTip = this.randomTip();
  }

  private randomVerb(): string {
    return JARVIS_SPINNER_VERBS[Math.floor(Math.random() * JARVIS_SPINNER_VERBS.length)];
  }

  private randomTip(): string {
    return JARVIS_TIPS[Math.floor(Math.random() * JARVIS_TIPS.length)];
  }

  start(initialVerb?: string) {
    if (this.isSpinning) return;
    if (initialVerb) this.currentVerb = initialVerb;
    this.isSpinning = true;
    this.startTime = Date.now();

    // Hide terminal cursor
    process.stdout.write('\x1b[?25l');

    // Render frame loop
    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.render();
    }, 80);

    // Rotate verbs every 2.4 seconds for whimsical Marvel flair
    this.verbTimer = setInterval(() => {
      this.currentVerb = this.randomVerb();
      this.render();
    }, 2400);

    this.render();
  }

  private render() {
    if (!this.isSpinning) return;
    const frame = this.frames[this.frameIndex];
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    // Clear line and render spinner + verb + elapsed time
    const spinnerLine = `${c.cyan}${c.bold}${frame}${c.reset} ${c.brightCyan}${this.currentVerb}${c.reset} ${c.dim}(${elapsed}s)${c.reset}`;
    process.stdout.write(`\r\x1b[2K${spinnerLine}`);
  }

  stop(clear = true) {
    if (!this.isSpinning) return;
    this.isSpinning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.verbTimer) {
      clearInterval(this.verbTimer);
      this.verbTimer = null;
    }

    if (clear) {
      process.stdout.write('\r\x1b[2K');
    } else {
      process.stdout.write('\n');
    }

    // Restore terminal cursor
    process.stdout.write('\x1b[?25h');
  }
}

// ─── Ephemeral Side Question Overlay (/btw) ───────────────────────────────────

export function renderEphemeralAside(query: string, answer: string): void {
  const width = Math.min(process.stdout.columns || 80, 84);
  const contentWidth = width - 4;

  const wrap = (text: string, maxLen: number): string[] => {
    const lines: string[] = [];
    for (const rawLine of text.split('\n')) {
      if (rawLine.length <= maxLen) {
        lines.push(rawLine);
      } else {
        const words = rawLine.split(/\s+/);
        let curr = '';
        for (const w of words) {
          if ((curr + ' ' + w).trim().length <= maxLen) {
            curr = (curr + ' ' + w).trim();
          } else {
            if (curr) lines.push(curr);
            curr = w;
          }
        }
        if (curr) lines.push(curr);
      }
    }
    return lines;
  };

  const topBorder = `╭── ${c.bold}${c.magenta}💬 Ephemeral Side Note (/btw)${c.reset} ${c.dim}— Context Preserved${c.reset} ` +
    '─'.repeat(Math.max(0, width - 48)) + '╮';
  const bottomBorder = '╰' + '─'.repeat(width - 2) + '╯';

  console.log(`\n${c.magenta}${topBorder}${c.reset}`);
  
  // Render Query
  const qLines = wrap(`Q: "${query}"`, contentWidth);
  for (const ql of qLines) {
    const pad = Math.max(0, contentWidth - ql.length);
    console.log(`${c.magenta}│${c.reset} ${c.bold}${c.yellow}${ql}${c.reset}${' '.repeat(pad)} ${c.magenta}│${c.reset}`);
  }

  // Divider
  console.log(`${c.magenta}├${c.reset}${'─'.repeat(width - 2)}${c.magenta}┤${c.reset}`);

  // Render Answer
  const aLines = wrap(answer.trim(), contentWidth);
  for (const al of aLines) {
    const pad = Math.max(0, contentWidth - al.length);
    console.log(`${c.magenta}│${c.reset} ${c.cyan}${al}${c.reset}${' '.repeat(pad)} ${c.magenta}│${c.reset}`);
  }

  console.log(`${c.magenta}${bottomBorder}${c.reset}`);
  console.log(`${c.dim}  ↳ Not added to main session context. Your primary workflow remains pristine, sir.${c.reset}\n`);
}

// ─── Interactive Tabbed Question Forms (AskUserQuestion) ─────────────────────

export interface QuestionTab {
  id: string;
  title: string;
  question: string;
  options: string[];
  is_multi_select?: boolean;
}

export async function askUserQuestion(questions: QuestionTab[]): Promise<Record<string, string | string[]>> {
  if (!questions || questions.length === 0) return {};

  // If not a TTY (e.g. redirected or test pipe), fall back to simple prompt
  if (!process.stdin.isTTY) {
    return fallbackNonTtyQuestion(questions);
  }

  let currentTab = 0;
  const numTabs = questions.length;
  const selections: Record<string, number[]> = {};
  const customAnswers: Record<string, string> = {};
  const cursorIndex: number[] = new Array(numTabs).fill(0);

  // Initialize default selections (first option selected for single-select)
  for (let i = 0; i < numTabs; i++) {
    const q = questions[i];
    selections[q.id] = q.is_multi_select ? [] : [0];
  }

  let isSubmitting = false;

  return new Promise((resolve) => {
    // Hide cursor & configure raw mode
    process.stdout.write('\x1b[?25l');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    let renderedLineCount = 0;

    const render = () => {
      // Clear previous rendered lines
      if (renderedLineCount > 0) {
        process.stdout.write(`\x1b[${renderedLineCount}A\x1b[0J`);
      }

      const q = questions[currentTab];
      const width = Math.min(process.stdout.columns || 80, 80);
      const outputLines: string[] = [];

      // ── Tab Bar ──
      let tabBar = '';
      for (let i = 0; i < numTabs; i++) {
        const tabQ = questions[i];
        const isSelected = i === currentTab;
        const hasChoice = selections[tabQ.id].length > 0 || customAnswers[tabQ.id];
        const check = hasChoice ? `${c.green}✓${c.reset} ` : '';

        if (isSelected) {
          tabBar += ` ${c.bold}${c.brightCyan}▸ [Tab ${i + 1}: ${tabQ.title}]${c.reset} `;
        } else {
          tabBar += ` ${c.dim}[${check}${i + 1}. ${tabQ.title}]${c.reset} `;
        }
      }

      outputLines.push(tabBar);
      outputLines.push(`╭─ ${c.bold}${c.cyan}${q.title}${c.reset} ${c.dim}(${currentTab + 1}/${numTabs})${c.reset} ` + '─'.repeat(Math.max(0, width - q.title.length - 18)) + '╮');
      outputLines.push(`│ ${c.bold}${q.question}${c.reset}`);
      if (q.is_multi_select) {
        outputLines.push(`│ ${c.dim}(Multi-select: [Space] to toggle, [Enter] to confirm)${c.reset}`);
      } else {
        outputLines.push(`│ ${c.dim}(Select one: [↑/↓] Navigate, [Enter] Next/Confirm)${c.reset}`);
      }
      outputLines.push(`│${' '.repeat(width - 2)}│`);

      // ── Options List ──
      const allOptions = [...q.options, 'Other (custom input)...'];
      const currentSelected = selections[q.id] || [];
      const currentCursor = cursorIndex[currentTab];

      for (let idx = 0; idx < allOptions.length; idx++) {
        const optText = allOptions[idx];
        const isHovered = idx === currentCursor;
        const isChosen = currentSelected.includes(idx);

        let indicator = ' ';
        if (q.is_multi_select) {
          indicator = isChosen ? `${c.green}[✓]${c.reset}` : `[ ]`;
        } else {
          indicator = isChosen ? `${c.cyan}◉${c.reset}` : `○`;
        }

        const pointer = isHovered ? `${c.brightCyan}❯${c.reset}` : ' ';
        const styledText = isHovered
          ? `${c.bold}${c.brightCyan}${optText}${c.reset}`
          : isChosen
          ? `${c.bold}${optText}${c.reset}`
          : `${c.dim}${optText}${c.reset}`;

        const customVal = (idx === allOptions.length - 1 && customAnswers[q.id])
          ? ` ${c.yellow}"${customAnswers[q.id]}"${c.reset}`
          : '';

        outputLines.push(`│  ${pointer} ${indicator} ${styledText}${customVal}`);
      }

      outputLines.push(`│${' '.repeat(width - 2)}│`);
      outputLines.push(`╰─ ${c.dim}[↑/↓] Options  [←/→ or Tab] Switch Tab  [Enter] Next/Done${c.reset} ` + '─'.repeat(Math.max(0, width - 58)) + '╯');

      for (const line of outputLines) {
        console.log(line);
      }
      renderedLineCount = outputLines.length;
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdout.write('\x1b[?25h'); // restore cursor
    };

    const submit = () => {
      if (isSubmitting) return;
      isSubmitting = true;
      cleanup();

      // Clear the wizard display
      if (renderedLineCount > 0) {
        process.stdout.write(`\x1b[${renderedLineCount}A\x1b[0J`);
      }

      // Compile answers
      const result: Record<string, string | string[]> = {};
      console.log(`\n${c.green}${c.bold}✓ Decisions Confirmed:${c.reset}`);

      for (const q of questions) {
        const allOptions = [...q.options, 'Other (custom input)...'];
        const chosenIndices = selections[q.id] || [];

        if (customAnswers[q.id]) {
          result[q.id] = customAnswers[q.id];
          console.log(`  • ${c.bold}${q.title}:${c.reset} ${c.cyan}${customAnswers[q.id]}${c.reset} ${c.dim}(custom)${c.reset}`);
        } else if (q.is_multi_select) {
          const vals = chosenIndices.map((i) => allOptions[i]);
          result[q.id] = vals;
          console.log(`  • ${c.bold}${q.title}:${c.reset} ${c.cyan}${vals.join(', ') || 'None'}${c.reset}`);
        } else {
          const val = chosenIndices.length > 0 ? allOptions[chosenIndices[0]] : allOptions[0];
          result[q.id] = val;
          console.log(`  • ${c.bold}${q.title}:${c.reset} ${c.cyan}${val}${c.reset}`);
        }
      }
      console.log();
      resolve(result);
    };

    const promptCustomInput = async (q: QuestionTab, allOptions: string[]) => {
      cleanup();
      process.stdout.write(`\x1b[${renderedLineCount}A\x1b[0J`);
      renderedLineCount = 0;

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const customVal = await new Promise<string>((res) => {
        rl.question(`\n${c.cyan}Enter your custom choice for "${q.title}":${c.reset} `, (ans) => {
          rl.close();
          res(ans.trim());
        });
      });

      if (customVal) {
        customAnswers[q.id] = customVal;
        selections[q.id] = [allOptions.length - 1];
      }

      // Restore raw mode and keypress
      process.stdout.write('\x1b[?25l');
      readline.emitKeypressEvents(process.stdin);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.on('keypress', onKeypress);
      render();
    };

    const onKeypress = async (_str: string, key: readline.Key) => {
      if (!key) return;

      // Exit on Ctrl+C or Escape
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        cleanup();
        console.log(`\n${c.yellow}Question form cancelled.${c.reset}\n`);
        resolve({});
        return;
      }

      const q = questions[currentTab];
      const allOptions = [...q.options, 'Other (custom input)...'];

      // Up / Down navigation
      if (key.name === 'up' || key.name === 'k') {
        cursorIndex[currentTab] = (cursorIndex[currentTab] - 1 + allOptions.length) % allOptions.length;
        render();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        cursorIndex[currentTab] = (cursorIndex[currentTab] + 1) % allOptions.length;
        render();
        return;
      }

      // Left / Right tab switching or Tab / Shift+Tab
      if (key.name === 'right' || (key.name === 'tab' && !key.shift)) {
        currentTab = (currentTab + 1) % numTabs;
        render();
        return;
      }
      if (key.name === 'left' || (key.name === 'tab' && key.shift)) {
        currentTab = (currentTab - 1 + numTabs) % numTabs;
        render();
        return;
      }

      // Space to toggle
      if (key.name === 'space') {
        const cur = cursorIndex[currentTab];
        if (cur === allOptions.length - 1) {
          // Other custom input
          await promptCustomInput(q, allOptions);
          return;
        }

        if (q.is_multi_select) {
          const list = selections[q.id] || [];
          if (list.includes(cur)) {
            selections[q.id] = list.filter((i) => i !== cur);
          } else {
            selections[q.id] = [...list, cur];
          }
        } else {
          selections[q.id] = [cur];
          delete customAnswers[q.id];
        }
        render();
        return;
      }

      // Enter to advance or submit
      if (key.name === 'return' || key.name === 'enter') {
        const cur = cursorIndex[currentTab];
        if (cur === allOptions.length - 1 && !customAnswers[q.id]) {
          await promptCustomInput(q, allOptions);
          return;
        }

        if (!q.is_multi_select) {
          selections[q.id] = [cur];
        }

        // Advance to next tab if not at last tab
        if (currentTab < numTabs - 1) {
          currentTab++;
          render();
        } else {
          // Finished all tabs -> submit
          submit();
        }
        return;
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
}

/**
 * Fallback for non-interactive / non-TTY environments
 */
async function fallbackNonTtyQuestion(questions: QuestionTab[]): Promise<Record<string, string | string[]>> {
  const result: Record<string, string | string[]> = {};
  for (const q of questions) {
    result[q.id] = q.options[0] || 'Default';
  }
  return result;
}
