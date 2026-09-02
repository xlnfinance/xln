import { describe, expect, test } from 'bun:test';

import registry from '../../../audits/registry.json';
import { opsPageMetadata, resolveOpsPage } from '../../../frontend/apps/ops/src/ops-model';
import { OPS_QUORUM_INTERACTIONS } from '../../../frontend/apps/ops/src/ops-quorum-source';
import { currentQuorumInteractions } from '../../../frontend/packages/runtime-client/src/qa-quorum-history';
import {
  buildQuorumView,
  readQuorumCategoryFilter,
  readQuorumRange,
} from '../../../frontend/packages/runtime-client/src/qa-quorum-model';
import {
  decodeQuorumRegistry,
  interactionsFromRegistry,
} from '../../../frontend/packages/runtime-client/src/qa-quorum-registry';

const oneRunRegistry = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  schemaVersion: 2,
  reviewers: [{ id: 'reviewer', label: 'Grok reviewer', family: 'xAI', ignored: true }],
  agentRuns: [{
    id: 'run-20260822',
    reviewerId: 'reviewer',
    sourceSha: 'abc123',
    scope: 'bounded audit',
    state: 'COMPLETED',
    usefulnessScore: 920,
    confirmedFindingIds: ['finding-1'],
    summary: 'Verified one concrete finding.',
    ignored: true,
    ...overrides,
  }],
  ignored: true,
});

describe('React ops quorum boundary and model', () => {
  test('strictly projects the real registry and combines current verified history', () => {
    const historical = interactionsFromRegistry(decodeQuorumRegistry(registry));
    expect(historical).toHaveLength(39);
    expect(currentQuorumInteractions).toHaveLength(7);
    expect(OPS_QUORUM_INTERACTIONS).toHaveLength(46);
    expect(historical[0]).toMatchObject({ category: 'security', model: 'Codex', score: 970 });
  });

  test('derives deterministic filters, metrics, selection, and explicit review chains', () => {
    const all = buildQuorumView(OPS_QUORUM_INTERACTIONS, {
      category: 'all', range: 'all', selectedId: 'fable-wire-fit-20260822',
    });
    expect(all.selected).toMatchObject({ model: 'Claude Fable 5', score: 940 });
    expect(all.reviewChains).toHaveLength(1);
    expect(all.interactions).toHaveLength(46);

    const performance = buildQuorumView(OPS_QUORUM_INTERACTIONS, {
      category: 'performance', range: 'all', selectedId: 'missing-selection',
    });
    expect(performance.interactions).toHaveLength(5);
    expect(performance.selected?.id).toBe('fable-cpu-profile-20260822');
    expect(performance.verifiedImpact).toBe(305);

    const empty = buildQuorumView(OPS_QUORUM_INTERACTIONS, {
      category: 'reliability', range: 'all', selectedId: '',
    });
    expect(empty).toMatchObject({ selected: null, averageScore: 0, verifiedImpact: 0, minTime: 0, maxTime: 0, timeSpan: 1 });
  });

  test('rejects malformed registry authority and invalid interaction dates loudly', () => {
    expect(() => decodeQuorumRegistry(oneRunRegistry({ usefulnessScore: 1_001 })))
      .toThrow('QUORUM_RUN_SCORE_INVALID');
    expect(() => decodeQuorumRegistry(oneRunRegistry({ reviewerId: 'missing' })))
      .toThrow('QUORUM_RUN_REVIEWER_UNKNOWN:run-20260822');
    const decoded = decodeQuorumRegistry(oneRunRegistry({ id: 'undated-run' }));
    expect(() => interactionsFromRegistry(decoded)).toThrow('QUORUM_RUN_DATE_INVALID:undated-run');
    expect(() => decodeQuorumRegistry({ ...oneRunRegistry(), schemaVersion: 1 }))
      .toThrow('QUORUM_REGISTRY_VERSION_INVALID');
  });

  test('validates browser filter values before changing view state', () => {
    expect(readQuorumRange('30d')).toBe('30d');
    expect(readQuorumCategoryFilter('protocol')).toBe('protocol');
    expect(() => readQuorumRange('week')).toThrow('QUORUM_RANGE_INVALID:week');
    expect(() => readQuorumCategoryFilter('all-work')).toThrow('QUORUM_CATEGORY_INVALID:all-work');
  });
});

describe('React ops quorum ownership', () => {
  test('owns the retained route with a lazy React page and shared Svelte decoder', async () => {
    expect(resolveOpsPage('/qa/quorum')).toEqual({ kind: 'quorum', pathname: '/qa/quorum' });
    expect(opsPageMetadata(resolveOpsPage('/qa/quorum')).title).toBe('xln Quorum Intelligence');
    const [app, svelteLoad, sveltePage] = await Promise.all([
      Bun.file('frontend/apps/ops/src/ops-app.tsx').text(),
      Bun.file('frontend/src/routes/qa/quorum/+page.ts').text(),
      Bun.file('frontend/src/routes/qa/quorum/+page.svelte').text(),
    ]);
    expect(app).toContain("import('./ops-quorum')");
    expect(svelteLoad).toContain('decodeQuorumRegistry(registry)');
    expect(svelteLoad).not.toContain('as QuorumRegistry');
    expect(sveltePage).toContain('buildQuorumView');
  });
});
