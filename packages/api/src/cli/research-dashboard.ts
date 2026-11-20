import readline from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import type { ResearchEngine } from '../engine/ResearchEngine.js';
import type { ResearchSession, ResearchUsage } from '../stores/SQLiteResearchStore.js';
import type { DeepResearchState, ResearchDocument } from '../stores/ResearchWorkspace.js';
import { c, canUseTerminalView } from './terminal-ui.js';

const tabs = ['Overview', 'Activity', 'Evidence & Reports', 'Usage', 'Controls'] as const;
type Tab = typeof tabs[number];
type Status = Awaited<ReturnType<ResearchEngine['getStatus']>>;

function tokenTotal(attempt: ResearchUsage): number | undefined {
  if (Number.isFinite(attempt.totalTokens)) return attempt.totalTokens;
  if (Number.isFinite(attempt.inputTokens) && Number.isFinite(attempt.outputTokens)) {
    return attempt.inputTokens! + attempt.outputTokens!;
  }
}

export function researchUsageSummary(attempts: ResearchUsage[]): string[] {
  const reported = attempts.filter(attempt => !attempt.estimated);
  const estimated = attempts.filter(attempt => attempt.estimated);
  const tokens = (items: ResearchUsage[]) => items.reduce((sum, attempt) => sum + (tokenTotal(attempt) ?? 0), 0);
  const split = (field: 'inputTokens' | 'outputTokens') => {
    const available = reported.filter(attempt => Number.isFinite(attempt[field]));
    return available.length ? available.reduce((sum, attempt) => sum + attempt[field]!, 0).toLocaleString() : 'unavailable';
  };
  const display = (items: ResearchUsage[]) => items.some(attempt => tokenTotal(attempt) !== undefined)
    ? tokens(items).toLocaleString() : 'unavailable';
  const count = (outcome: ResearchUsage['outcome']) => attempts.filter(attempt => attempt.outcome === outcome).length;

  return [
    attempts.length ? `LLM calls dispatched: ${attempts.length} (${attempts.filter(attempt => attempt.retry).length} retries)` : 'LLM calls recorded: 0',
    `Succeeded ${count('succeeded')} · failed ${count('failed')} · rate-limited ${count('rate_limited')} · aborted ${count('aborted')} · in flight ${count('in_flight')}`,
    `Reported tokens: ${display(reported)} total · ${split('inputTokens')} input · ${split('outputTokens')} output`,
    `Estimated tokens: ${display(estimated)} · total unavailable for ${attempts.filter(attempt => tokenTotal(attempt) === undefined).length} calls`,
  ];
}

export function researchState(session: ResearchSession): string {
  if (session.retryAt && session.retryAt > Date.now() && session.status === 'in_progress') return 'waiting for quota';
  return session.status.replaceAll('_', ' ');
}

function usageGroups(attempts: ResearchUsage[], groupBy: (attempt: ResearchUsage) => string): string[] {
  const groups = new Map<string, ResearchUsage[]>();
  for (const attempt of attempts) {
    const key = groupBy(attempt);
    const group = groups.get(key) ?? [];
    group.push(attempt);
    groups.set(key, group);
  }
  return [...groups].flatMap(([label, group]) => {
    const summary = researchUsageSummary(group);
    return [label, ...summary.map(line => `  ${line}`)];
  });
}

function formatTime(iso: string | number): string {
  return new Date(iso).toLocaleString();
}

function oneLine(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function overview(status: Status, usage: ResearchUsage[], state?: DeepResearchState): string[] {
  const { session, steps, activeStep } = status;
  if (!session) return ['No selected mission.'];
  const summary = researchUsageSummary(usage);
  const checkpoint = steps.filter(step => step.status === 'completed' && step.completedAt).at(-1)?.completedAt;
  return [
    session.topic,
    `State: ${researchState(session)}`,
    summary[0],
    summary[2],
    summary[3],
    '',
    `Current action: ${activeStep?.title ?? session.currentStepTitle ?? 'None'}`,
    `Completed steps: ${steps.filter(step => step.status === 'completed').length}/${steps.length} · findings collected: ${session.findings.length}`,
    ...(state ? [
      `Questions answered: ${state.questions.filter(question => question.status === 'answered').length}/${state.questions.length}`,
      `Disputed or under review: ${state.claims.filter(claim => claim.verdict === 'disputed' || claim.verdict === 'under-review').length}`,
      ...state.questions.filter(question => question.status === 'open').slice(0, 5)
        .map(question => `  ${question.id} · ${question.lens} · ${question.question}`),
      ...(state.stopReason ? [state.stopReason] : []),
    ] : []),
    `Last checkpoint: ${checkpoint ? formatTime(checkpoint) : 'None yet'}`,
    `Last update: ${formatTime(session.updatedAt)}`,
    ...(session.retryAt && session.retryAt > Date.now() ? [`Next provider retry: ${formatTime(session.retryAt)}`] : []),
    ...(session.error ? [session.error] : []),
  ];
}

export async function printResearchDashboard(engine: ResearchEngine, id?: string): Promise<void> {
  const status = await engine.getStatus(id);
  const mission = status.session ?? (!id ? (await engine.listMissions(1))[0] : undefined);
  if (!mission) {
    console.log(id ? `Research mission ${oneLine(id)} was not found.` : 'No research missions. Launch one with /research <topic>.');
    return;
  }
  const selectedStatus = status.session ? status : await engine.getStatus(mission.id);
  const usage = engine.getUsage(mission.id);
  console.log(overview(selectedStatus, usage, engine.getResearchState(mission.id)).map(oneLine).join('\n'));
  console.log(researchUsageSummary(usage)[1]);
  console.log(`/research status ${mission.id}  /research report ${mission.id}`);
  console.log(`/research pause ${mission.id}  /research resume ${mission.id}  /research stop ${mission.id}`);
  console.log(`/research publish ${mission.id}  /research diagnose ${mission.id}`);
}

export async function showResearchDashboard(engine: ResearchEngine, id?: string): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;
  if (!canUseTerminalView()) return printResearchDashboard(engine, id);

  let status: Status | undefined;
  let missions: ResearchSession[] = [];
  let usage: ResearchUsage[] = [];
  let research: DeepResearchState | undefined;
  let documents: ResearchDocument[] = [];
  let selectedDocument: string | undefined;
  let workingReport: string | undefined;
  let selectedId = id ?? (await engine.getStatus()).session?.id;
  let tabIndex = 0;
  let scroll = 0;
  let picker = false;
  let pickerIndex = 0;
  let controlIndex = 0;
  let confirmStop = false;
  let notice = '';
  let busy = false;
  let refreshing = false;
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  let closed = false;

  const controls = [
    { label: 'Pause', enabled: ['in_progress', 'pending'], run: (missionId: string) => engine.pauseMission(missionId) },
    { label: 'Resume', enabled: ['paused'], run: (missionId: string) => engine.resumeMission(missionId) },
    { label: 'Stop and publish briefing', enabled: ['in_progress', 'pending', 'paused'], run: (missionId: string) => engine.stopMission(missionId) },
    { label: 'Export briefing', enabled: ['paused', 'stopped', 'completed'], run: async (missionId: string) => {
      await engine.exportResearchReport(missionId);
      return true;
    } },
  ];

  return new Promise<void>(resolve => {
    const render = () => {
      if (closed) return;
      const width = Math.max(1, (output.columns || 80) - 1);
      const height = Math.max(1, output.rows || 24);
      const color = !process.env.NO_COLOR;
      const fit = (line: string) => Array.from(oneLine(line)).slice(0, width).join('');
      const wrap = (line: string) => {
        const characters = Array.from(oneLine(line));
        if (characters.length <= width) return [characters.join('')];
        const rows: string[] = [];
        for (let start = 0; start < characters.length; start += width) rows.push(characters.slice(start, start + width).join(''));
        return rows;
      };
      const tab: Tab = tabs[tabIndex];
      const session = status?.session;
      const fullBar = tabs.map(name => name === tab ? `[${name}]` : name).join('  ');
      const title = fit(`JARVIS Research${session ? `  •  ${session.id}  •  ${researchState(session)}` : ''}`);
      const bar = fit(fullBar.length <= width ? fullBar : `${tabIndex + 1}/${tabs.length} [${tab}]`);
      const body: string[] = [];

      if (picker) {
        body.push('Select a mission', '', ...missions.map((mission, index) =>
          `${index === pickerIndex ? '>' : ' '} ${mission.id}  ${researchState(mission)}  ${mission.topic}`));
      } else if (!session || !status) {
        body.push(selectedId ? `Mission ${selectedId} was not found.` : 'No research missions. Launch one with /research <topic>.');
      } else if (tab === 'Overview') {
        body.push(...overview(status, usage, research));
      } else if (tab === 'Activity') {
        body.push(...(research?.instructions ?? []).slice(-8).map(item => `Steering · ${item.kind} · ${item.text}`));
        body.push(...[...status.steps].reverse().flatMap(step => [
          `${step.stepNumber}. [${step.status}] ${step.title}`,
          ...(step.query ? [`   Query: ${step.query}`] : []),
          ...(step.completedAt ? [`   ${formatTime(step.completedAt)}`] : []),
          ...(step.evidence?.reason ? [`   ${step.evidence.reason}`] : []),
          ...(step.error ? [`   ${step.error}`] : []),
        ]));
      } else if (tab === 'Evidence & Reports') {
        if (session.reportPath) body.push(`Markdown: ${session.reportPath}`);
        if (session.pdfPath) body.push(`PDF: ${session.pdfPath}`);
        if (documents.length) {
          body.push('d: switch document', `${!selectedDocument ? '>' : ' '} Current research`);
          body.push(...documents.map(document =>
            `${document.id === selectedDocument ? '>' : ' '} ${document.title} · ${document.id} · r${document.revision}`));
        }
        const document = documents.find(document => document.id === selectedDocument);
        if (document) body.push(...engine.documents.correctionNotices(document));
        const report = document?.markdown ?? workingReport;
        if (report) {
          body.push('', ...report.split(/\r?\n/));
        } else {
          body.push('Working findings from search results', '');
          for (const finding of session.findings) body.push(`• ${finding.claim}`, `  ${finding.source} ${finding.url ?? ''}`, '');
          if (!session.findings.length) body.push('No findings committed yet.');
        }
      } else if (tab === 'Usage') {
        body.push(...researchUsageSummary(usage), '', 'By provider and model',
          ...usageGroups(usage, row => `${row.providerId}/${row.modelId}`), '', 'By phase',
          ...usageGroups(usage, row => row.phase.replaceAll('_', ' ')), '', 'Shared free-provider quota');
        for (const provider of engine.getProviderQuota()) {
          body.push(`${provider.id}: ${provider.requestsToday}/${provider.limitRPD} requests · ${provider.tokensToday}/${provider.limitTokensPerDay} token quota units · ${provider.status.replaceAll('_', ' ')}`);
        }
      } else {
        body.push(...controls.map((control, index) =>
          `${index === controlIndex ? '>' : ' '} ${control.label}${control.enabled.includes(session.status) ? '' : ' (unavailable)'}`));
        if (confirmStop) body.push('', `Stop ${session.id} and publish an interim briefing? [y/N]`);
        if (session.depth === 'deep' && !confirmStop) {
          body.push('', `/research steer ${session.id} <instruction>`, `/research fact-check ${session.id} <claim-id>`);
        }
      }

      const viewport = Math.max(1, height - 5);
      const rows = picker || tab === 'Controls' ? body.map(fit) : body.flatMap(wrap);
      lastRenderedRows = rows.length;
      lastViewport = viewport;
      const position = picker ? Math.max(0, pickerIndex + 3 - viewport) : tab === 'Controls'
        ? (confirmStop ? Math.max(0, rows.length - viewport) : Math.max(0, controlIndex + 1 - viewport))
        : Math.min(scroll, Math.max(0, rows.length - viewport));
      const content = rows.slice(position, position + viewport);
      const spacer = Array.from({ length: viewport - content.length }, () => '');
      const footer = picker ? '↑↓ Select · Enter Open · Esc Back' : 'Tab / ←→ Tabs · ↑↓ Navigate · Enter Select · m Missions · Esc Chat';
      const styled = (line: string, style: string) => color ? `${style}${line}${c.reset}` : line;
      const view = [styled(title, c.bold + c.cyan), styled(bar, c.bold), '', ...content, ...spacer, fit(notice), fit(footer)];
      output.write(`\x1b[H\x1b[2J${view.slice(0, height).join('\n')}`);
    };

    const refresh = async () => {
      if (closed || refreshing) return;
      refreshing = true;
      try {
        const priority = (mission: ResearchSession) => ['in_progress', 'pending', 'paused', 'stopping'].includes(mission.status) ? 0 : 1;
        const highlighted = missions[pickerIndex]?.id;
        missions = (await engine.listMissions(100)).sort((a, b) => priority(a) - priority(b));
        const nextIndex = missions.findIndex(mission => mission.id === highlighted);
        pickerIndex = nextIndex === -1 ? 0 : nextIndex;
        selectedId ??= missions[0]?.id;
        const requested = selectedId;
        const snapshot = await engine.getStatus(requested);
        if (requested === selectedId) {
          status = snapshot;
          usage = snapshot.session ? engine.getUsage(snapshot.session.id) : [];
          research = snapshot.session ? engine.getResearchState(snapshot.session.id) : undefined;
          documents = snapshot.session ? engine.documents.list(snapshot.session.id) : [];
          workingReport = snapshot.session ? engine.getWorkingReport(snapshot.session) : undefined;
        }
      } catch (error) {
        notice = `Cannot refresh: ${String(error)}`;
      } finally {
        refreshing = false;
        render();
      }
    };

    const runControl = async () => {
      const session = status?.session;
      const control = controls[controlIndex];
      if (!session || busy || !control.enabled.includes(session.status)) return;
      busy = true;
      confirmStop = false;
      notice = `${control.label} requested…`;
      render();
      try {
        const applied = await control.run(session.id);
        notice = applied ? `${control.label} applied` : 'Mission state changed. Review the current controls.';
      } catch (error) {
        notice = String(error);
      } finally {
        busy = false;
        await refresh();
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      input.off('keypress', onKey);
      input.off('end', close);
      output.off('resize', render);
      input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
      resolve();
    };

    const onKey = (_text: string, key: readline.Key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') return close();
      if (confirmStop) {
        if (key.name === 'y') void runControl();
        else if (['n', 'escape', 'return'].includes(key.name ?? '')) confirmStop = false;
      } else if (key.name === 'escape' || key.name === 'q') {
        if (!picker) return close();
        picker = false;
      } else if (key.name === 'm') {
        picker = !picker;
        pickerIndex = Math.max(0, missions.findIndex(mission => mission.id === selectedId));
      } else if (picker) {
        if (key.name === 'up') pickerIndex = Math.max(0, pickerIndex - 1);
        if (key.name === 'down') pickerIndex = Math.min(Math.max(0, missions.length - 1), pickerIndex + 1);
        if (key.name === 'return' && missions[pickerIndex]) {
          selectedId = missions[pickerIndex].id;
          status = undefined;
          selectedDocument = undefined;
          scroll = 0;
          notice = '';
          picker = false;
          void refresh();
        }
      } else if (key.name === 'tab' || key.name === 'left' || key.name === 'right') {
        const direction = key.name === 'left' || key.shift ? -1 : 1;
        tabIndex = (tabIndex + direction + tabs.length) % tabs.length;
        scroll = 0;
      } else if (tabs[tabIndex] === 'Evidence & Reports' && key.name === 'd') {
        const choices = [undefined, ...documents.map(document => document.id)];
        selectedDocument = choices[(choices.indexOf(selectedDocument) + 1) % choices.length];
        scroll = 0;
      } else if (tabs[tabIndex] === 'Controls') {
        if (key.name === 'up') controlIndex = Math.max(0, controlIndex - 1);
        if (key.name === 'down') controlIndex = Math.min(controls.length - 1, controlIndex + 1);
        if (key.name === 'return' && !busy && status?.session && controls[controlIndex].enabled.includes(status.session.status)) {
          if (controlIndex === 2) confirmStop = true;
          else void runControl();
        }
      } else {
        if (key.name === 'up') scroll = Math.max(0, scroll - 1);
        if (key.name === 'down') {
          const maxScroll = Math.max(0, lastRenderedRows - lastViewport);
          scroll = Math.min(maxScroll, scroll + 1);
        }
      }
      render();
    };

    let lastRenderedRows = 0;
    let lastViewport = 0;
    const timer = setInterval(() => void refresh(), 1000);
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', onKey);
    input.once('end', close);
    output.on('resize', render);
    output.write('\x1b[?1049h\x1b[?25l');
    render();
    void refresh();
  });
}

