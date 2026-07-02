import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { buildSolvencyProjection } from '../../frontend/src/lib/view/panels/solvency-panel-view';

test('solvency projection derives reserves and collateral from an injected runtime frame', () => {
  const frame = {
    eReplicas: new Map([
      ['left:signer', {
        state: {
          reserves: new Map([[1, 150n]]),
          accounts: new Map([['right', {
            deltas: new Map([[1, { collateral: 100n }]]),
            pendingFrame: {
              deltas: [{ collateral: 50n }],
            },
          }]]),
        },
      }],
      ['right:signer', {
        state: {
          reserves: new Map(),
          accounts: new Map([['left', {
            deltas: new Map([[1, { collateral: 100n }]]),
            pendingFrame: {
              deltas: [{ collateral: 50n }],
            },
          }]]),
        },
      }],
    ]),
  };

  expect(buildSolvencyProjection(frame)).toEqual({
    m1: 150n,
    m2: 100n,
    m3: 50n,
    total: 150n,
    delta: 0n,
    isValid: true,
  });
});

test('solvency projection fails loud on malformed amounts', () => {
  const frame = {
    eReplicas: new Map([
      ['entity:signer', {
        state: {
          reserves: new Map([[1, 'not-a-number']]),
          accounts: new Map(),
        },
      }],
    ]),
  };

  expect(() => buildSolvencyProjection(frame)).toThrow('bigint-compatible amount');
});

test('SolvencyPanel reads adapter solvency-summary with injected env fallback', () => {
  const source = readFileSync('frontend/src/lib/view/panels/SolvencyPanel.svelte', 'utf8');
  const dockRoot = readFileSync('frontend/src/lib/view/DockRoot.svelte', 'utf8');
  const architect = readFileSync('frontend/src/lib/view/panels/ArchitectPanel.svelte', 'utf8');

  expect(source).toContain("import { createRuntimeQueryStore } from '$lib/stores/runtimeQueryClient'");
  expect(source).toContain('client.readSolvencySummary()');
  expect(source).toContain('$solvencyStore.data ?? buildSolvencyProjection($runtimeFrameEnv)');
  expect(source).toContain('Solvency projection failed');
  expect(source).toContain('buildSolvencyProjection($runtimeFrameEnv)');
  expect(source).not.toContain('xlnEnvironment');
  expect(source).not.toContain('Date.now');
  expect(dockRoot).toContain('mount(SolvencyPanel, { target: div, props: { runtimeFrameEnv } })');
  expect(dockRoot).toContain("id: 'solvency'");
  expect(architect).toContain('<SolvencyPanel {runtimeFrameEnv} />');
});
