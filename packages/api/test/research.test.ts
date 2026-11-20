import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { Message } from '@jarvis/shared';
import { ResearchEngine } from '../src/engine/ResearchEngine.js';
import type { SmartRouter } from '../src/engine/SmartRouter.js';
import { FileService } from '../src/services/FileService.js';
import { canonicalResearchUrl, collectResearchDocument, ResearchSourceReadError } from '../src/services/ResearchSourceReader.js';
import type { WebSearchService } from '../src/services/WebSearchService.js';
import { SQLiteResearchStore } from '../src/stores/SQLiteResearchStore.js';

async function fixture(context: { after: (callback: () => Promise<void>) => void }, model: (messages: Message[]) => Promise<string>, withSources = true,
  overrides?: { search?: (query: string) => Promise<{ url: string; title: string }[]>; rejectSource?: (url: string) => void },
) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-deep-'));
  const store = new SQLiteResearchStore(join(directory, 'research.db'));
  const search = {
    search: overrides?.search ?? (async (query: string) => withSources ? [
      { url: `https://official.example/${encodeURIComponent(query)}`, title: 'Primary record' },
      { url: `https://registry.example/${encodeURIComponent(query)}`, title: 'Independent registry' },
    ] : []),
  } as unknown as WebSearchService;
  const reader = {
    open: async (url: string, title: string) => {
      overrides?.rejectSource?.(url);
      const family = new URL(url).hostname;
      const text = family.startsWith('official')
        ? 'The commissioning record identifies the factory as actively producing commercial units.'
        : 'Regional officials documented continuous industrial operations after reviewing the facility in October.';
      return { url, title, family, retrievedAt: new Date().toISOString(), passages: [{ locator: 'Section 1', text }] };
    },
  };
  const router = { researchChat: model, healthDashboard: () => [] } as unknown as SmartRouter;
  const engine = new ResearchEngine(store, router, search, new FileService(directory), { sourceReader: reader, logFile: join(directory, 'research.log') });
  context.after(async () => {
    engine.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { engine, store, tick: () => (engine as unknown as { tick(): Promise<void> }).tick() };
}

async function model(messages: Message[]): Promise<string> {
  const input = JSON.parse(messages[1].content);
  if (messages[0].content.startsWith('Map')) return JSON.stringify({ questions: [
    { lens: 'breadth', question: 'How many units shipped?', rationale: 'Measure commercial progress', query: 'units shipped official reports' },
    { lens: 'depth', question: 'Was production running continuously?', rationale: 'Check source methods', query: 'continuous operation production records' },
    { lens: 'tangent', question: 'Does electricity capacity constrain the factory?', rationale: 'Power data could explain delays', query: 'electricity grid capacity' },
  ] });
  if (messages[0].content.startsWith('Independently')) {
    return JSON.stringify({ audits: input.map((claim: { id: string; evidence: { index: number }[] }) =>
      ({ claimId: claim.id, validLinks: claim.evidence.map(link => link.index) })) });
  }
  if (messages[0].content.startsWith('Write a coherent research briefing')) {
    const ids = input.evidence.map((claim: { id: string }) => claim.id);
    return JSON.stringify({
      summary: [{ text: 'Independent records connect commissioning to continued operation.', claimIds: ids.slice(0, 2) }],
      sections: [{ heading: 'Commissioning and continued operation', points: [
        { text: 'The records examine operating status from different perspectives, which strengthens the account of commercial activity.', claimIds: ids.slice(0, 2) },
        { text: 'An invented citation should be discarded.', claimIds: ['claim_invented'] },
        { text: 'An unverified inference should be discarded.', claimIds: ids.slice(0, 1) },
        { text: input.evidence[0].text, claimIds: ids.slice(0, 1) },
      ] }],
      implications: [{ text: 'Operating records offer a starting point for comparing industrial activity across sources.', claimIds: ids.slice(0, 2) }],
    });
  }
  if (messages[0].content.startsWith('Audit the briefing prose')) {
    return JSON.stringify({ accepted: ['summary.0', 'section.0.0', 'implication.0'] });
  }
  const evidence = input.passages.slice(0, 2).map((passage: { sourceId: string; locator: string; text: string }) => ({
    sourceId: passage.sourceId, locator: passage.locator, quote: passage.text, relation: 'supports',
  }));
  evidence.push({ sourceId: 'src_invented', locator: 'Nowhere', quote: 'No such quotation was retrieved', relation: 'supports' });
  return JSON.stringify({
    answered: true,
    claims: [{ text: `Commercial operation was documented for ${input.question.question}`, evidence }],
  });
}

async function runToEnd(engine: ResearchEngine, id: string, tick: () => Promise<void>) {
  for (let i = 0; i < 40; i++) {
    const { session } = await engine.getStatus(id);
    if (session?.status === 'completed') return session;
    if (session?.status === 'failed') assert.fail(session.error);
    await tick();
  }
  assert.fail('Research did not finish with the fixture evidence');
}

test('deep research audits original citations, rejects fabricated links, and publishes durable evidence', async context => {
  const { engine, tick } = await fixture(context, model);
  const mission = await engine.startMission('Battery commercialization', 'deep');
  engine.stop();
  const finished = await runToEnd(engine, mission.id, tick);
  const state = engine.getResearchState(mission.id)!;
  assert.deepEqual(state.questions.map(question => question.lens), ['breadth', 'depth', 'tangent']);
  assert(state.questions.every(question => question.status === 'answered'));
  assert.equal(state.claims.length, 3);
  assert(state.claims.every(claim => claim.verdict === 'corroborated' && claim.audit === 'checked' && claim.evidence.length === 2));
  assert(!finished.finalReport?.includes('src_invented'));
  const narrative = finished.finalReport!.split('## Evidence and sources')[0];
  assert.match(narrative, /### Commissioning and continued operation/);
  assert.match(narrative, /The records examine operating status from different perspectives/);
  assert.doesNotMatch(narrative, /Commercial operation was documented for|should be discarded/);
  assert.match(narrative, /What the findings mean/);
  const [reExported] = await engine.exportResearchReport(mission.id);
  assert.match(await readFile(reExported, 'utf8'), /### Commissioning and continued operation/);
  assert(finished.finalReport!.indexOf('## Executive summary') < finished.finalReport!.indexOf('## Evidence and sources'));
  assert.equal(finished.finalReport!.match(/^## .+$/gm)?.at(-1), '## Pending research areas');
  assert.match(await readFile(finished.reportPath!, 'utf8'), /Section 1/);
  const pdf = await readFile(finished.pdfPath!, 'latin1');
  assert(pdf.startsWith('%PDF-'));
  assert.match(pdf, /\/Subtype \/Link/);
  assert.match(pdf, /CORROBORATED|INTERPRETATION/);
  assert.match(pdf, /0\.88 0\.95 0\.91 rg/);
});

test('an unavailable briefing writer still publishes an explicitly labeled evidence digest', async context => {
  const { engine, tick } = await fixture(context, async messages => {
    if (messages[0].content.startsWith('Write a coherent')) throw new Error('Provider unavailable');
    return model(messages);
  });
  const mission = await engine.startMission('Evidence fallback', 'deep');
  engine.stop();
  const finished = await runToEnd(engine, mission.id, tick);
  assert.match(finished.finalReport!, /Evidence digest/);
  assert.match(finished.finalReport!, /Pending research areas/);
});

test('the planner finishes with disclosed gaps when no source yields evidence', async context => {
  const { engine, tick } = await fixture(context, model, false);
  const mission = await engine.startMission('A topic with no available sources', 'deep');
  engine.stop();
  const finished = await runToEnd(engine, mission.id, tick);
  assert.match(finished.finalReport!, /useful search paths were exhausted/);
  assert.equal(finished.findings.length, 0);
  assert(engine.getResearchState(mission.id)!.questions.every(question => question.recoveryRoutes?.includes('alternate')));
});

test('a new fact-check preempts earlier focus and fences work in flight', async context => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: (value: string) => void;
  const pending = new Promise<string>(resolve => { release = resolve; });
  const { engine, tick } = await fixture(context, async () => {
    entered();
    return pending;
  });
  const mission = await engine.startMission('A topic', 'deep');
  engine.stop();
  const tickPromise = tick();
  await started;
  engine.steerMission(mission.id, 'focus', 'Costs');
  engine.steerMission(mission.id, 'fact-check', 'Published estimate https://registry.example/correction');
  engine.stop();
  release('{"questions":[]}');
  await tickPromise;
  const status = await engine.getStatus(mission.id);
  assert(status.steps.some(step => step.status === 'superseded'));
  assert.equal(status.activeStep?.query, 'https://registry.example/correction');
  assert.equal(engine.getResearchState(mission.id)?.instructions.length, 2);
  assert(await engine.stopMission(mission.id));
  assert.equal((await engine.getStatus(mission.id)).session?.status, 'stopped');
});

test('a source-backed correction retains the original claim and flags older documents', async context => {
  const { engine, tick } = await fixture(context, async messages => {
    const input = JSON.parse(messages[1].content);
    if (!messages[0].content.startsWith('Review') || !input.question.claimId) return model(messages);
    const previous = input.existing.find((claim: { id: string }) => claim.id === input.question.claimId);
    const evidence = input.passages.slice(0, 2).map((passage: { sourceId: string; locator: string; text: string }) => ({
      sourceId: passage.sourceId, locator: passage.locator, quote: passage.text,
    }));
    return JSON.stringify({ claims: [
      { claimId: previous.id, text: previous.text, evidence: evidence.map((link: object) => ({ ...link, relation: 'contradicts' })) },
      { text: 'The revised account distinguishes commissioning from shipments.',
        evidence: evidence.map((link: object) => ({ ...link, relation: 'supports' })) },
    ] });
  });
  const mission = await engine.startMission('Update the production account', 'deep');
  engine.stop();
  await runToEnd(engine, mission.id, tick);
  const initial = engine.getResearchState(mission.id)!;
  const original = initial.claims[0];
  const note = await engine.documents.create(mission.id, 'Initial note', `Finding discussed in ${original.id}.`);
  engine.reopenMission(mission.id, 'Check revisions to the commissioning records');
  engine.steerMission(mission.id, 'fact-check', original.id);
  engine.stop();
  await runToEnd(engine, mission.id, tick);
  const updated = engine.getResearchState(mission.id)!;
  const oldClaim = updated.claims.find(claim => claim.id === original.id)!;
  assert.equal(oldClaim.verdict, 'disputed');
  assert(oldClaim.previous?.some(previous => previous.verdict === 'corroborated'));
  assert.equal(updated.claims.find(claim => claim.id === oldClaim.supersededBy)?.verdict, 'corroborated');
  assert.match(engine.documents.correctionNotices(note).join('\n'), /corrected finding/);
});

test('document edits preserve earlier revisions and export Markdown, PDF and a research bundle', async context => {
  const { engine } = await fixture(context, model);
  const mission = await engine.startMission('Documents', 'deep');
  engine.stop();
  const docs = engine.documents;
  const first = await docs.create(mission.id, 'Memo', '# Memo\n\n## Keep\n\nUseful.\n\n## Remove\n\nObsolete.');
  const second = await docs.create(mission.id, 'Notes', '# Notes\n\nExtra evidence.');
  assert.equal(docs.append(mission.id, first.id, 'More detail', 'Keep').revision, 2);
  assert.match(docs.trim(mission.id, first.id, { section: 'Remove' }, '', false).removed, /Obsolete/);
  assert.equal(docs.get(mission.id, first.id).revision, 2);
  docs.trim(mission.id, first.id, { section: 'Remove' }, '', true);
  assert(!docs.get(mission.id, first.id).markdown.includes('Obsolete'));
  assert.equal(docs.merge(mission.id, first.id, [second.id], true).document.revision, 4);
  assert.match(docs.get(mission.id, first.id).markdown, /Extra evidence/);
  assert.match(docs.trim(mission.id, first.id, { pages: '1' }, '', false).removed, /Memo/);
  assert.equal(docs.restore(mission.id, first.id, 1).revision, 5);
  assert.equal((await docs.export(mission.id, first.id, ['md', 'pdf'], 4)).length, 2);
  const bundle = JSON.parse(await readFile(await docs.bundle(mission.id), 'utf8'));
  assert.equal(bundle.documents.length, 2);
  assert.equal(bundle.revisions[first.id].length, 5);
});

test('original-document retrieval rejects private addresses and strips tracking links', () => {
  for (const url of ['http://127.0.0.1', 'https://[::1]', 'http://example.org:8080']) {
    assert.throws(() => canonicalResearchUrl(url));
  }
  assert.equal(canonicalResearchUrl('https://example.org/a?utm_source=copy#x'), 'https://example.org/a');
});

test('large PDFs stream to disk and enforce the byte cap without a content length', async context => {
  const signal = new AbortController().signal;
  const megabyte = Buffer.alloc(1024 * 1024);
  const header = [Buffer.from('%P'), Buffer.from('DF-1.4\n')];
  const result = await collectResearchDocument(Readable.from([...header, ...Array(9).fill(megabyte)]),
    'application/octet-stream', NaN, signal);
  assert('pdfPath' in result);
  context.after(() => rm(result.directory, { recursive: true, force: true }));
  assert.equal((await stat(result.pdfPath)).size, header.reduce((total, chunk) => total + chunk.length, 0) + 9 * megabyte.length);
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  await assert.rejects(collectResearchDocument(Readable.from([...header, megabyte]), 'application/pdf', NaN, signal, megabyte.length),
    (error: unknown) => error instanceof ResearchSourceReadError && error.failure === 'size_limit' && /PDF/.test(error.message));
  await assert.rejects(collectResearchDocument(Readable.from(Array(9).fill(megabyte)), 'text/html', NaN, signal),
    /Web document exceeds the 8 MiB download limit/);
});

test('a forbidden source leads to a public-copy lookup without counting the copy as independent', async context => {
  const original = 'https://publisher.example/original';
  const publicCopy = 'https://repository.example/public-copy';
  const title = 'A chronology of regional industrial production';
  const { engine, tick } = await fixture(context, model, true, {
    search: async query => query.includes('open access repository') ? [
      { url: 'https://publisher.example/alternate', title },
      { url: 'https://repository.example/unrelated', title: 'An unrelated source' },
      { url: publicCopy, title },
    ] : [{ url: original, title }],
    rejectSource: url => {
      if (url === original) throw new ResearchSourceReadError('forbidden', 'Source returned HTTP 403');
    },
  });
  const mission = await engine.startMission('Regional production', 'deep');
  engine.stop();
  for (let i = 0; i < 8; i++) await tick();
  const state = engine.getResearchState(mission.id)!;
  const failed = state.sources.find(source => source.url === original)!;
  const recovered = state.sources.find(source => source.url === publicCopy)!;
  assert.equal(failed.failure, 'forbidden');
  assert.equal(recovered.alternativeFor, failed.id);
  assert.equal(recovered.family, failed.family);
  assert(!state.sources.some(source => source.url.endsWith('/unrelated') || source.url.endsWith('/alternate')));
  assert.match(await engine.diagnoseMission(mission.id), /1 readable alternatives/);
});

test('paused research can publish a styled briefing without changing mission state', async context => {
  const { engine, tick } = await fixture(context, model);
  const mission = await engine.startMission('An unfinished investigation', 'deep');
  engine.stop();
  await tick();
  assert(await engine.pauseMission(mission.id));
  const [markdown, pdf] = await engine.exportResearchReport(mission.id);
  assert.equal((await engine.getStatus(mission.id)).session?.status, 'paused');
  const contents = await readFile(markdown, 'utf8');
  assert.match(contents, /Interim briefing/);
  assert.equal(contents.match(/^## .+$/gm)?.at(-1), '## Pending research areas');
  assert.match(await readFile(pdf, 'latin1'), /0\.05 0\.13 0\.24 rg/);
});

test('diagnostics keep timings and errors, with full traces only when opted in', async context => {
  const { engine, store } = await fixture(context, model);
  const mission = await engine.startMission('Attempt diagnostics', 'deep');
  engine.stop();
  const step = (await engine.getStatus(mission.id)).steps[0];
  const previous = process.env.JARVIS_RESEARCH_TRACE;
  const prompt: Message[] = [{ role: 'user', content: 'trace-specific text' }];
  try {
    delete process.env.JARVIS_RESEARCH_TRACE;
    const failed = store.startModelAttempt(step, 'example', 'model', false, prompt);
    store.finishModelAttempt(failed, 'rate_limited', undefined, false, { error: 'HTTP 429' });
    assert.match(await engine.diagnoseMission(mission.id, true), /HTTP 429/);
    assert(!((await engine.diagnoseMission(mission.id, true)).includes('trace-specific text')));
    process.env.JARVIS_RESEARCH_TRACE = 'true';
    const successful = store.startModelAttempt(step, 'example', 'model', true, prompt);
    store.finishModelAttempt(successful, 'succeeded', { totalTokens: 42 }, false, { response: 'captured answer' });
    assert(!((await engine.diagnoseMission(mission.id)).includes('captured answer')));
    assert.match(await engine.diagnoseMission(mission.id, true), /Prompt:.*trace-specific text/);
    assert.match(await engine.diagnoseMission(mission.id, true), /Response: captured answer/);
  } finally {
    if (previous === undefined) delete process.env.JARVIS_RESEARCH_TRACE;
    else process.env.JARVIS_RESEARCH_TRACE = previous;
  }
});
