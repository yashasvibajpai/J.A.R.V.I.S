import type { DeepResearchState, ResearchClaim, ResearchSource } from '../stores/ResearchWorkspace.js';

const inline = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>]/g, '\\$&');
const labels: Record<ResearchClaim['verdict'], string> = {
  corroborated: 'Corroborated', 'single-source': 'Single source', disputed: 'Disputed',
  'under-review': 'Under review', insufficient: 'Insufficient evidence',
};

export function renderDeepReport(topic: string, state: DeepResearchState, reason = 'Interim briefing · Research in progress'): string {
  const readable = state.sources.filter(source => !source.error && source.passages.length);
  const sources = new Map(readable.map(source => [source.id, source]));
  const used = new Map<string, { source: ResearchSource; number: number }>();
  const cite = (id: string) => {
    const source = sources.get(id);
    if (!source) return '';
    const entry = used.get(id) ?? { source, number: used.size + 1 };
    used.set(id, entry);
    return `[Source ${entry.number}](<${source.url}>)`;
  };
  const findings = state.claims.filter(claim => claim.evidence.some(link => sources.has(link.sourceId)) &&
    claim.verdict !== 'insufficient');
  const rank = (claim: ResearchClaim) => claim.verdict === 'corroborated' && claim.audit === 'checked' ? 0
    : claim.verdict === 'single-source' && claim.audit === 'checked' ? 1 : 2;
  const ordered = [...findings].sort((a, b) => rank(a) - rank(b));
  const answered = state.questions.filter(question => question.status === 'answered').length;
  const claimLine = (claim: ResearchClaim) => {
    const links = [...new Set(claim.evidence.map(link => link.sourceId))].slice(0, 3).map(cite).filter(Boolean);
    const qualification = claim.audit === 'checked' ? labels[claim.verdict] : `${labels[claim.verdict]} · audit pending`;
    return `**${qualification}.** ${inline(claim.text)} ${links.join(' · ')}`.trimEnd();
  };
  const selected: ResearchClaim[] = [];
  const topics = new Set<string>();
  for (const claim of ordered) {
    if (topics.has(claim.questionId)) continue;
    topics.add(claim.questionId);
    selected.push(claim);
    if (selected.length === 4) break;
  }
  const corroborated = findings.filter(claim => claim.verdict === 'corroborated' && claim.audit === 'checked').length;
  const lines = [
    `# ${inline(topic)}`, '', `> ${inline(reason)}`,
    `> ${answered} of ${state.questions.length} questions answered · ${readable.length} readable sources · ${corroborated} audited corroborated findings`, '',
    '## Executive summary', '',
    ...(corroborated ? [] : ['The available evidence supports a preliminary account. No finding has both independent corroboration and a completed citation audit.', '']),
    ...(selected.length ? selected.map(claim => `- ${claimLine(claim)}`) : ['There are no source-backed findings to summarize yet.']),
    '', '## Findings', '',
  ];
  for (const question of state.questions) {
    const claims = findings.filter(claim => claim.questionId === question.id);
    if (!claims.length) continue;
    const short = question.question.length > 105 ? `${question.question.slice(0, 105).replace(/\s+\S*$/, '')}…` : question.question;
    lines.push(`### ${inline(short)}`, '');
    for (const claim of claims) lines.push(claimLine(claim), '');
  }
  if (!findings.length) lines.push('No substantive findings are ready to report.', '');
  lines.push('## Evidence and sources', '',
    `Read ${readable.length} of ${state.sources.length} source records. Findings marked as single source or awaiting review should be treated as provisional.`, '');
  for (const claim of findings) {
    lines.push(`- ${claim.id} · ${labels[claim.verdict]}${claim.supersededBy ? ` · corrected in ${claim.supersededBy}` : ''}`);
    for (const link of claim.evidence) {
      if (sources.has(link.sourceId)) lines.push(`  - ${link.relation} · ${cite(link.sourceId)} · ${inline(link.locator)} · “${inline(link.quote)}”`);
    }
  }
  if (used.size) {
    lines.push('', '### References', '');
    for (const [id, { source, number }] of used) {
      lines.push(`- Source ${number} · [${id}](<${source.url}>) · ${inline(source.title)} · accessed ${source.retrievedAt.slice(0, 10)}`);
    }
  }
  lines.push('', '## Pending research areas', '');
  const unfinished = state.questions.filter(question => question.status !== 'answered');
  for (const question of unfinished) {
    const status = question.status === 'exhausted' ? 'Unresolved after attempted searches'
      : question.status === 'deferred' ? 'Deferred' : 'Open';
    lines.push(`- **${status}.** ${inline(question.question)}`);
    if (question.reason) lines.push(`  - Evidence gap: ${inline(question.reason)}`);
    if (question.closure) lines.push(`  - ${inline(question.closure)}`);
    if (question.nextQuery) lines.push(`  - Next search: ${inline(question.nextQuery)}`);
  }
  const unaudited = state.claims.filter(claim => !claim.audit || claim.audit === 'needs-review').length;
  if (unaudited) lines.push(`- Check citation support for ${unaudited} remaining finding${unaudited === 1 ? '' : 's'}.`);
  if (!state.questions.length) lines.push('- Map the main questions and find the first original sources.');
  else if (!unfinished.length && !unaudited) lines.push('No pending areas were recorded.');
  return lines.join('\n') + '\n';
}
