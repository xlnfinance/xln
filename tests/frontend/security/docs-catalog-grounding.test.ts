import { describe, expect, test } from 'bun:test';

import {
  FEATURED_DOC_IDS,
  READING_PATHS,
  classifyDoc,
  getSectionDefinitions,
  getSectionKind,
} from '../../../frontend/docs-catalog.js';
import { rankXlnGuideDocs } from '../../../frontend/src/lib/ai/xln-guide-context';

const entry = (id: string, title: string) => {
  const sectionId = classifyDoc(id);
  return {
    id,
    path: `${id}.md`,
    title,
    summary: title,
    kind: getSectionKind(sectionId),
  };
};

describe('docs catalog architecture grounding', () => {
  test('features competitors in the new-reader theory path', () => {
    expect(FEATURED_DOC_IDS).toContain('competitors');
    expect(READING_PATHS.find(path => path.id === 'new-to-xln')?.items).toContain('competitors');
    expect(classifyDoc('competitors')).toBe('theory');
    expect(getSectionKind(classifyDoc('competitors'))).toBe('live');
    expect(FEATURED_DOC_IDS).not.toContain('status');
    expect(FEATURED_DOC_IDS).not.toContain('mainnet');
  });

  test('keeps evidence, launch snapshots, retired ids, and unknown docs out of architecture grounding', () => {
    expect(getSectionKind(classifyDoc('audit/advisor-scorecard'))).toBe('archive');
    expect(getSectionKind(classifyDoc('releases/0.1.31'))).toBe('archive');
    expect(getSectionKind(classifyDoc('security/consensus-hanko-scan'))).toBe('archive');
    expect(getSectionKind(classifyDoc('unknown-future-note'))).toBe('archive');

    const ranked = rankXlnGuideDocs('Compare architecture, rollups, and data availability', '/app', [
      entry('status', 'Current launch status'),
      entry('mainnet', 'Mainnet readiness snapshot'),
      entry('audit/advisor-scorecard', 'Dated audit evidence'),
      entry('releases/0.1.31', 'Immutable release evidence'),
      entry('unknown-future-note', 'Unclassified architecture claim'),
      entry('competitors', 'Architecture comparison and data availability'),
    ], 10);
    expect(ranked.map(item => item.id)).toEqual(['competitors']);

    const catalogIds = [
      ...FEATURED_DOC_IDS,
      ...READING_PATHS.flatMap(path => path.items),
      ...getSectionDefinitions().flatMap(section => section.items ?? []),
    ];
    expect(catalogIds).not.toContain(['insights', 'bilateral'].join('/'));
  });
});
