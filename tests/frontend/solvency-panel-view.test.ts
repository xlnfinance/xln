import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { buildSolvencyProjection } from '../../frontend/src/lib/view/panels/solvency-panel-view';

test('solvency projection derives reserves and collateral from an injected runtime frame', () => {
  const left = `0x${'11'.repeat(32)}`;
  const right = `0x${'22'.repeat(32)}`;
  const depository = `0x${'33'.repeat(20)}`;
  const config = {
    mode: 'proposer-based', threshold: 1n, validators: ['signer'], shares: { signer: 1n },
    jurisdiction: {
      address: depository, name: 'Testnet', chainId: 31337,
      entityProviderAddress: `0x${'44'.repeat(20)}`, depositoryAddress: depository,
    },
  } as const;
  const frame = {
    eReplicas: new Map([
      ['left:signer', {
        state: {
          entityId: left,
          height: 1,
          config,
          reserves: new Map([[1, 150n]]),
          accounts: new Map([[right, {
            deltas: new Map([[1, { collateral: 100n }]]),
            pendingFrame: {
              deltas: [{ tokenId: 1, collateral: 50n }],
            },
          }]]),
        },
      }],
      ['right:signer', {
        state: {
          entityId: right,
          height: 1,
          config,
          reserves: new Map(),
          accounts: new Map([[left, {
            deltas: new Map([[1, { collateral: 100n }]]),
            pendingFrame: {
              deltas: [{ tokenId: 1, collateral: 50n }],
            },
          }]]),
        },
      }],
    ]),
  };

  expect(buildSolvencyProjection(frame)).toEqual({
    assets: [{
      stackId: `31337:${depository}`,
      chainId: 31337,
      depositoryAddress: depository,
      tokenId: 1,
      reserves: 150n,
      confirmedCollateral: 100n,
      pendingCollateral: 50n,
      delta: 50n,
      isValid: false,
    }],
    isValid: false,
  });
});

test('solvency projection fails loud on malformed amounts', () => {
  const frame = {
    eReplicas: new Map([
      ['entity:signer', {
        state: {
          entityId: `0x${'11'.repeat(32)}`,
          height: 1,
          config: {
            mode: 'proposer-based', threshold: 1n, validators: ['signer'], shares: { signer: 1n },
            jurisdiction: {
              address: `0x${'33'.repeat(20)}`, name: 'Testnet', chainId: 31337,
              entityProviderAddress: `0x${'44'.repeat(20)}`, depositoryAddress: `0x${'33'.repeat(20)}`,
            },
          },
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
  expect(source).toContain('ASSET CONSERVATION OK');
  expect(source).not.toContain('SYSTEM SOLVENT');
  expect(source).not.toContain("return `$${");
  expect(source).not.toContain('xlnEnvironment');
  expect(source).not.toContain('Date.now');
  expect(dockRoot).toContain('mount(SolvencyPanel, { target: div, props: { runtimeFrameEnv } })');
  expect(dockRoot).toContain("id: 'solvency'");
  expect(architect).toContain('<SolvencyPanel {runtimeFrameEnv} />');
});
