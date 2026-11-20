import type { SQLiteResearchStore } from '../stores/SQLiteResearchStore.js';

function counts(values: string[]): string {
  const grouped = new Map<string, number>();
  values.forEach(value => grouped.set(value, (grouped.get(value) ?? 0) + 1));
  return [...grouped].sort((a, b) => b[1] - a[1]).map(([value, count]) => `${count} ${value}`).join(' · ') || 'none';
}

export async function diagnoseResearch(store: SQLiteResearchStore, id: string, traces: boolean): Promise<string> {
  const session = await store.getSession(id);
  if (!session) throw new Error('Research mission was not found');
  const steps = await store.getSteps(id);
  const state = store.workspace.getState(id);
  const attempts = store.getAttemptDetails(id, traces);
  const usage = store.getUsage(id);
  const recordedTokens = usage.filter(row => !row.estimated)
    .reduce((total, row) => total + (row.totalTokens ?? (row.inputTokens ?? 0) + (row.outputTokens ?? 0)), 0);
  const seconds = Math.max(0, Math.round((Date.parse(session.updatedAt) - Date.parse(session.createdAt)) / 1000));
  const lines = [
    `Research diagnostics · ${id}`, session.topic,
    `State: ${session.status} · Recorded span: ${Math.floor(seconds / 60)}m ${seconds % 60}s (includes pauses)`,
    `Last recorded action: ${session.error || state?.stopReason || session.currentStepTitle || 'None'}`,
    `Completed actions: ${counts(steps.filter(step => step.status === 'completed').map(step => step.stepType))}`,
    `Model calls: ${attempts.length} · ${counts(attempts.map(attempt => attempt.outcome))}`,
    `Provider-reported tokens: ${recordedTokens.toLocaleString()} · ${usage.filter(row => [row.totalTokens, row.inputTokens, row.outputTokens].every(n => n === undefined)).length} attempts without token counts`,
  ];
  if (state) {
    const errors = state.sources.flatMap(source => {
      if (!source.error) return [];
      if (source.failure === 'size_limit') return [source.error];
      if (source.failure === 'access_required') return ['access restricted'];
      if (source.failure === 'no_pdf_text') return ['PDF has no usable text · OCR may be needed'];
      return [source.error.match(/HTTP \d+/)?.[0] ?? (source.error.includes('pdftotext') ? 'PDF extractor unavailable'
        : /cert/i.test(source.error) ? 'TLS error' : source.error)];
    });
    const recovery = steps.filter(step => step.stepType === 'deep_find_copy' && step.status === 'completed');
    const publicCopies = state.sources.filter(source => source.alternativeFor && !source.error);
    lines.push(
      `Source records: ${state.sources.length - errors.length}/${state.sources.length} readable · ${counts(errors)}`,
      ...(recovery.length ? [`Public-copy recovery: ${recovery.length} searches · ${publicCopies.length} readable alternatives`] : []),
      ...publicCopies.map(source => `  ${source.alternativeFor} → ${source.id} · ${source.url}`),
      `Claim verdicts: ${counts(state.claims.map(claim => claim.verdict))}`,
      `Citation audits: ${counts(state.claims.map(claim => claim.audit ?? 'pending'))}`,
      '', 'Question decisions',
      ...state.questions.flatMap(question => [
        `- ${question.status} · ${question.tried.length} searches · ${question.question}`,
        ...(question.reason ? [`  ${question.reason}`] : []),
        ...(question.closure ? [`  Stop decision: ${question.closure}`] : []),
        ...(question.recoveryRoutes?.length ? [`  Recovery routes: ${question.recoveryRoutes.join(', ')}`] : []),
        ...question.tried.map(query => `  Search: ${query}`),
      ]),
    );
  }
  lines.push('', 'Model attempts');
  for (const attempt of attempts) {
    const duration = attempt.startedAt && attempt.finishedAt
      ? ` · ${((Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)) / 1000).toFixed(1)}s` : '';
    lines.push(`- Step ${attempt.step} · ${attempt.provider}/${attempt.model} · ${attempt.outcome}${duration}${attempt.error ? ` · ${attempt.error}` : ''}`);
    if (traces && attempt.prompt) lines.push(`  Prompt: ${attempt.prompt}`);
    if (traces && attempt.response) lines.push(`  Response: ${attempt.response}`);
  }
  if (attempts.some(attempt => !attempt.startedAt)) lines.push('Older calls predate timing and error-detail capture.');
  if (traces && !attempts.some(attempt => attempt.prompt || attempt.response)) {
    lines.push('No transcripts were captured. Set JARVIS_RESEARCH_TRACE=true for future runs.');
  }
  return lines.join('\n');
}
