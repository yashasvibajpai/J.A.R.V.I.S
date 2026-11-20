import type { DeepResearchState, ResearchBriefing, ResearchBriefingPoint } from '../stores/ResearchWorkspace.js';

export function briefingEvidence(state: DeepResearchState) {
  const sources = new Map(state.sources.filter(source => !source.error && source.passages.length).map(source => [source.id, source]));
  const usable = state.claims.filter(claim => claim.audit === 'checked' && claim.verdict !== 'insufficient' &&
    !claim.supersededBy && claim.evidence.some(link => sources.has(link.sourceId)));
  const grouped = new Map<string, typeof usable>();
  for (const claim of usable) {
    const group = grouped.get(claim.questionId) ?? [];
    group.push(claim);
    grouped.set(claim.questionId, group);
  }
  return [...grouped.values()].flatMap(group => group.slice(0, 4)).slice(0, 20).map(claim => ({
    id: claim.id, text: claim.text, verdict: claim.verdict,
    references: claim.evidence.flatMap(link => {
      const source = sources.get(link.sourceId);
      return source ? [{ publisher: source.title, relation: link.relation, quote: link.quote.slice(0, 210) }] : [];
    }).slice(0, 2),
  }));
}

export function checkBriefingDraft(value: Record<string, unknown>, evidence: ReturnType<typeof briefingEvidence>): ResearchBriefing | undefined {
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  const allowedIds = new Set(evidence.map(claim => claim.id));
  const ledgerText = new Set(evidence.flatMap(claim => [claim.text, ...claim.references.map(reference => reference.quote)]).map(normalize));
  const used = new Set<string>();
  const readPoint = (item: unknown): ResearchBriefingPoint | undefined => {
    if (!item || typeof item !== 'object') return;
    const { text, claimIds } = item as Partial<ResearchBriefingPoint>;
    if (typeof text !== 'string' || !text.trim() || text.length > 900 ||
      !Array.isArray(claimIds) || !claimIds.length || claimIds.some(id => !allowedIds.has(id))) return;
    const normalized = normalize(text);
    if (used.has(normalized) || (normalized.length >= 55 && ledgerText.has(normalized))) return;
    used.add(normalized);
    return { text: text.trim(), claimIds: [...new Set(claimIds)].slice(0, 6) };
  };
  const points = (items: unknown, limit: number) => {
    const valid: ResearchBriefingPoint[] = [];
    for (const item of Array.isArray(items) ? items.slice(0, 12) : []) {
      const point = readPoint(item);
      if (point) valid.push(point);
      if (valid.length === limit) break;
    }
    return valid;
  };
  const summary = points(value.summary, 3);
  const sections = (Array.isArray(value.sections) ? value.sections.slice(0, 5) : []).flatMap(section => {
    const heading = typeof section?.heading === 'string' ? section.heading.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
    const rows = points(section?.points, 3);
    return heading && rows.length ? [{ heading, points: rows }] : [];
  });
  return summary.length && sections.length ? { summary, sections, implications: points(value.implications, 3) } : undefined;
}

export function briefingReview(briefing: ResearchBriefing, accepted: Set<string>): ResearchBriefing | undefined {
  const summary = briefing.summary.filter((_, index) => accepted.has(`summary.${index}`));
  const sections = briefing.sections.flatMap((section, index) => {
    const points = section.points.filter((_, point) => accepted.has(`section.${index}.${point}`));
    return points.length ? [{ ...section, points }] : [];
  });
  const implications = briefing.implications.filter((_, index) => accepted.has(`implication.${index}`));
  return summary.length && sections.length ? { summary, sections, implications } : undefined;
}
