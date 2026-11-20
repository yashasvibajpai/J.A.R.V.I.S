import readline from 'node:readline';
import { c, canUseTerminalView } from './terminal-ui.js';

const help = [
  {
    title: 'Start',
    commands: [
      ['list <mission>', 'Find document IDs and current revisions for a mission. Get a mission ID from /research list.', 'list res_12345678'],
      ['new <mission> <title> [-- <markdown>]', 'Create a named document. Put any starting Markdown after --.', 'new res_12345678 "Source notes" -- "## Evidence"'],
      ['show <mission> <document> [--revision n]', 'Read the current document or a specific revision. The view includes notices when referenced claims are being rechecked or have been corrected.', 'show res_12345678 doc_12345678 --revision 2'],
    ],
  },
  {
    title: 'Edit',
    commands: [
      ['append <mission> <document> [--section "Heading"] -- <markdown>', 'Append to the whole document or to the end of a named section. The edit creates a new revision.', 'append res_12345678 doc_12345678 --section "Evidence" -- "Added the primary source."'],
      ['merge <mission> <target> <source> […] [--apply]', 'Preview a merge into an existing target, then repeat with --apply to save it. Use "doc_id#Heading" for a single section. Source documents stay available.', 'merge res_12345678 doc_12345678 doc_abcdef12 --apply'],
      ['trim <mission> <document> (--section "Heading" | --lines 3-8 | --pages 2) [--replace "Text"] [--apply]', 'Preview the selected content. Repeat with --apply to remove it or save the replacement. Page numbers refer to the PDF layout for the current revision.', 'trim res_12345678 doc_12345678 --lines 3-8 --apply'],
    ],
  },
  {
    title: 'Revisions',
    commands: [
      ['history <mission> <document>', 'List revisions, when each was created, and which operation created it.', 'history res_12345678 doc_12345678'],
      ['restore <mission> <document> <revision>', 'Make an earlier revision current by copying it into a new revision. History remains available.', 'restore res_12345678 doc_12345678 2'],
    ],
  },
  {
    title: 'Import & export',
    commands: [
      ['import <mission> "<path>" [--pages 1-3]', 'Create a document from Markdown, plain text, or PDF. PDF text import uses pdftotext or macOS PDFKit. Quote paths that contain spaces.', 'import res_12345678 "field notes.pdf" --pages 1-3'],
      ['export <mission> <document> [--format md,pdf] [--revision n]', 'Write Markdown, PDF, or both from the selected revision. The default is both formats from the latest revision.', 'export res_12345678 doc_12345678 --format pdf --revision 2'],
      ['bundle <mission>', 'Export a JSON research bundle containing the evidence ledger, current documents, and document revision history.', 'bundle res_12345678'],
    ],
  },
] as const;

const command = (value: string) => `/research doc ${value}`;

export function isResearchDocumentHelp(input: string): boolean {
  return /^\/(?:research|bg)\s+doc(?:\s+(?:help|--help))?\s*$/i.test(input);
}

export function printResearchDocumentHelp(): void {
  console.log(['Research document help', ...help.flatMap(tab => [
    '', tab.title, ...tab.commands.flatMap(([syntax, explanation, example]) =>
      [command(syntax), `  ${explanation}`, `  Example  ${command(example)}`, '']),
  ])].join('\n').trimEnd());
}

export async function showResearchDocumentHelp(): Promise<void> {
  if (!canUseTerminalView()) return printResearchDocumentHelp();

  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = Boolean(input.isRaw);
  const wasFlowing = input.readableFlowing === true;
  const color = !process.env.NO_COLOR;
  let active = 0;
  let scroll = 0;
  let maxScroll = 0;

  const render = () => {
    const width = Math.max(1, (output.columns || 80) - 1);
    const height = output.rows || 24;
    const style = (line: string, tone: string) => color ? `${tone}${line}${c.reset}` : line;
    const tab = help[active];
    const tabs = help.map((item, index) => index === active ? `[${item.title}]` : item.title).join('  ');
    const wrap = (line: string) => {
      const rows: string[] = [];
      while (line.length > width) {
        const space = line.lastIndexOf(' ', width);
        const split = space > 0 ? space : width;
        rows.push(line.slice(0, split));
        line = line.slice(split).trimStart();
      }
      return [...rows, line];
    };
    const body = tab.commands.flatMap(([syntax, explanation, example]) => [
      ...wrap(command(syntax)).map(line => style(line, c.bold)),
      ...wrap(explanation),
      ...wrap(`Example  ${command(example)}`).map(line => style(line, c.cyan)),
      '',
    ]);
    const viewport = Math.max(1, height - 5);
    maxScroll = Math.max(0, body.length - viewport);
    scroll = Math.min(scroll, maxScroll);
    const content = body.slice(scroll, scroll + viewport);
    const spacer = Array.from({ length: viewport - content.length }, () => '');
    const footer = width >= 52 ? 'Tab / ←→ Switch tabs · ↑↓ Scroll · Esc Back' : 'Tab Tabs · ↑↓ Scroll · Esc Back';
    output.write('\x1b[H\x1b[2J' + [
      style('JARVIS Research · Document help'.slice(0, width), c.bold + c.cyan),
      style((tabs.length <= width ? tabs : `${active + 1}/${help.length} [${tab.title}]`).slice(0, width), c.bold),
      '',
      ...content, ...spacer,
      maxScroll ? `Lines ${scroll + 1}–${scroll + content.length} of ${body.length}`.slice(0, width) : '',
      footer.slice(0, width),
    ].slice(0, height).join('\n'));
  };

  await new Promise<void>(resolve => {
    const close = () => {
      input.off('keypress', onKey);
      input.off('end', close);
      output.off('resize', render);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
      resolve();
    };
    const onKey = (_text: string, key: readline.Key) => {
      if (!key) return;
      if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) return close();
      if (key.name === 'tab' || key.name === 'left' || key.name === 'right') {
        const direction = key.name === 'left' || (key.name === 'tab' && key.shift) ? -1 : 1;
        active = (active + direction + help.length) % help.length;
        scroll = 0;
      } else if (key.name === 'up') scroll = Math.max(0, scroll - 1);
      else if (key.name === 'down') scroll = Math.min(maxScroll, scroll + 1);
      else if (key.name === 'home') scroll = 0;
      else if (key.name === 'end') scroll = maxScroll;
      render();
    };
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', onKey);
    input.once('end', close);
    output.on('resize', render);
    output.write('\x1b[?1049h\x1b[?25l');
    render();
  });
}
