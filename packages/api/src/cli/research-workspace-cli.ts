import { stripVTControlCharacters } from 'node:util';
import type { ResearchEngine } from '../engine/ResearchEngine.js';
import { printResearchDocumentHelp } from './research-document-help.js';

export const printResearchText = (value: string) =>
  console.log(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ''));

function args(input: string): string[] {
  return (input.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(value =>
    /^(["'])[^]*\1$/.test(value) ? value.slice(1, -1) : value,
  );
}

function integer(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Expected a positive revision number');
  return parsed;
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value;
}

export async function handleResearchWorkspaceCommand(operation: string, input: string, engine: ResearchEngine): Promise<boolean> {
  if (!['doc', 'steer', 'focus', 'explore', 'fact-check', 'sources', 'reopen', 'publish', 'diagnose'].includes(operation)) return false;
  try {
    if (operation === 'doc') {
      await documents(input, engine);
      return true;
    }
    const [id, ...parts] = args(input);
    const mission = required(id, 'Mission ID');
    const instruction = parts.join(' ');
    if (operation === 'publish') {
      printResearchText((await engine.exportResearchReport(mission)).join('\n'));
      return true;
    }
    if (operation === 'diagnose') {
      printResearchText(await engine.diagnoseMission(mission, parts.includes('--trace')));
      return true;
    }
    if (operation === 'sources') {
      const { session } = await engine.getStatus(mission);
      if (!session) throw new Error('Research mission was not found');
      const state = engine.getResearchState(mission);
      const sourceId = parts[0];
      if (sourceId) {
        const source = state?.sources.find(item => item.id === sourceId);
        if (!source) throw new Error('Source was not found in this mission');
        printResearchText([`${source.id} · ${source.title} · ${source.url}`, source.error ?? '',
          ...source.passages.map(passage => `${passage.locator}\n${passage.text}\n`)].join('\n'));
      } else {
        const lines = state?.sources.map(source =>
          `${source.id} · ${source.title} · ${source.url}${source.error ? ` · ${source.error}` : ''}`)
          ?? session.findings.flatMap(finding => finding.url ? [`${finding.source} · ${finding.url} · search result`] : []);
        printResearchText([...new Set(lines)].join('\n') || 'No sources recorded yet.');
      }
      return true;
    }
    if (operation === 'reopen') {
      const question = engine.reopenMission(mission, instruction);
      printResearchText(`Reopened ${mission}. Next focus: ${question.question}`);
      return true;
    }
    const inferred = operation === 'steer'
      ? /^(?:please\s+)?(fact-check|fact check|verify|correct|explore|investigate|focus)(?=\s|$)\s*(?:on\s+)?/i.exec(instruction)
      : null;
    const prefix = inferred?.[1].toLowerCase();
    const kind = operation === 'steer'
      ? prefix && ['fact-check', 'fact check', 'verify', 'correct'].includes(prefix) ? 'fact-check'
        : prefix && ['explore', 'investigate'].includes(prefix) ? 'explore' : 'focus'
      : operation as 'focus' | 'explore' | 'fact-check';
    const subject = inferred ? instruction.slice(inferred[0].length) : instruction;
    const question = engine.steerMission(mission, kind, required(subject, 'Instruction'));
    printResearchText(`Applied ${kind} to ${mission}. ${question.id} · ${question.question}`);
  } catch (error) {
    printResearchText(error instanceof Error ? error.message : String(error));
  }
  return true;
}

async function documents(input: string, engine: ResearchEngine): Promise<void> {
  const [operation, rawMission, ...parts] = args(input);
  if (!operation || ['help', '--help'].includes(operation.toLowerCase())) return printResearchDocumentHelp();
  const mission = required(rawMission, 'Mission ID');
  const workspace = engine.documents;
  const option = (name: string) => {
    const index = parts.indexOf(name);
    return index >= 0 ? required(parts[index + 1], name) : undefined;
  };
  if (operation === 'list') {
    printResearchText(workspace.list(mission).map(doc => `${doc.id} · r${doc.revision} · ${doc.title}`).join('\n') || 'No documents yet.');
    return;
  }
  if (operation === 'bundle') {
    printResearchText(await workspace.bundle(mission));
    return;
  }
  if (operation === 'new') {
    const separator = parts.indexOf('--');
    const title = (separator < 0 ? parts : parts.slice(0, separator)).join(' ');
    const document = await workspace.create(mission, title, separator < 0 ? undefined : parts.slice(separator + 1).join(' '));
    printResearchText(`${document.id} · r${document.revision} · ${document.title}`);
    return;
  }
  if (operation === 'import') {
    const document = await workspace.importFile(mission, required(parts[0], 'Path'), option('--pages'));
    printResearchText(`${document.id} · ${document.title}`);
    return;
  }
  const document = required(parts.shift(), 'Document ID');
  const revision = option('--revision');
  const format = option('--format');
  switch (operation) {
    case 'show': {
      const version = workspace.get(mission, document, revision ? integer(revision) : undefined);
      const notices = workspace.correctionNotices(version);
      printResearchText([...notices, ...(notices.length ? [''] : []), version.markdown].join('\n'));
      break;
    }
    case 'history':
      printResearchText(workspace.history(mission, document).map(item => `r${item.revision} · ${item.operation} · ${item.createdAt}`).join('\n'));
      break;
    case 'restore': {
      const restored = workspace.restore(mission, document, integer(parts[0]));
      printResearchText(`Restored as revision ${restored.revision}`);
      break;
    }
    case 'append': {
      const separator = parts.indexOf('--');
      const section = separator >= 0 ? option('--section') : undefined;
      const content = (separator >= 0 ? parts.slice(separator + 1) : parts).join(' ');
      printResearchText(`Saved revision ${workspace.append(mission, document, content, section).revision}`);
      break;
    }
    case 'merge': {
      const apply = parts.includes('--apply');
      const result = workspace.merge(mission, document, parts.filter(part => part !== '--apply'), apply);
      printResearchText(apply ? `Merged as revision ${result.document.revision}` : `Merge preview. Repeat with --apply to save.\n\n${result.markdown}`);
      break;
    }
    case 'trim': {
      const section = option('--section');
      const lines = option('--lines');
      const pages = option('--pages');
      if ([section, lines, pages].filter(Boolean).length !== 1) throw new Error('Choose --section, --lines, or --pages');
      const selection = section ? { section } : lines ? { lines } : { pages: pages! };
      const apply = parts.includes('--apply');
      const result = workspace.trim(mission, document, selection, option('--replace') ?? '', apply);
      printResearchText(apply ? 'Saved trimmed revision.' : `Trim preview. Repeat with --apply to save.\n\n${result.removed}`);
      break;
    }
    case 'export':
      printResearchText((await workspace.export(mission, document, (format ?? 'md,pdf').split(','), revision ? integer(revision) : undefined)).join('\n'));
      break;
    default:
      throw new Error('Use doc list, new, show, history, append, merge, trim, restore, import, export, or bundle');
  }
}
