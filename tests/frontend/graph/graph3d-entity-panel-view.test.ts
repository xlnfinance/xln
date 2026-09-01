import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { EnvSnapshot, RuntimeReplica } from '../../../core/api/public/runtime-module';
import {
  createGraph3dEntityPanelView,
  graph3dEntityBigInt,
  selectGraph3dEntityFrame,
} from '../../../frontend/packages/runtime-client/src/graph3d-entity-panel-view';

const liveFrame = (eReplicas: unknown): RuntimeReplica => ({ state: { eReplicas } } as never);
const historyFrame = (id: string, eReplicas: unknown = new Map()): EnvSnapshot => ({
  id,
  state: { eReplicas },
} as never);

const account = (collateral: unknown, ondelta: unknown) => ({
  state: { deltas: new Map([[1, { collateral, ondelta }]]) },
});

describe('Graph3D entity mini-panel view model', () => {
  test('selects live state or the bounded historical frame', () => {
    const live = liveFrame(new Map());
    const history = [historyFrame('first'), historyFrame('last')];

    expect(selectGraph3dEntityFrame(live, history, -1)).toBe(live);
    expect(selectGraph3dEntityFrame(live, history, 0)).toBe(history[0]);
    expect(selectGraph3dEntityFrame(live, history, 99)).toBe(history[1]);
    expect(selectGraph3dEntityFrame(live, [], 0)).toBe(live);
    expect(selectGraph3dEntityFrame(null, history, -1)).toBe(null);
  });

  test('projects Map-backed reserves, collateral, and the bounded account preview', () => {
    const frame = liveFrame(new Map([
      ['alice:signer-a', {
        state: {
          reserves: new Map([['1', '1250000n']]),
          accounts: new Map([
            ['bob', account(10n, 4n)],
            ['carol', account('20n', -5)],
            ['dave', account(30, '6')],
            ['erin', account(undefined, undefined)],
          ]),
        },
      }],
      ['alice-other:signer-b', { state: { reserves: new Map([['1', 999n]]) } }],
    ]));

    expect(createGraph3dEntityPanelView({
      entityId: 'alice',
      entityName: 'Alice Bank',
      liveFrame: frame,
      history: [],
      timeIndex: -1,
    })).toEqual({
      title: 'Alice Bank',
      reserve: 1_250_000n,
      totalCollateral: 60n,
      accountCount: 4,
      accountPreviews: [
        { counterpartyId: 'bob', ondelta: 4n },
        { counterpartyId: 'carol', ondelta: -5n },
        { counterpartyId: 'dave', ondelta: 6n },
      ],
      remainingAccountCount: 1,
    });
  });

  test('normalizes serialized Record frames and falls back to the entity id', () => {
    const historical = historyFrame('serialized', {
      'hub:validator': {
        state: {
          reserves: { '1': '42n' },
          accounts: {
            peer: { state: { deltas: { '1': { collateral: '8', ondelta: '-3n' } } } },
          },
        },
      },
    });

    expect(createGraph3dEntityPanelView({
      entityId: 'hub',
      entityName: '',
      liveFrame: null,
      history: [historical],
      timeIndex: 0,
    })).toEqual({
      title: 'hub',
      reserve: 42n,
      totalCollateral: 8n,
      accountCount: 1,
      accountPreviews: [{ counterpartyId: 'peer', ondelta: -3n }],
      remainingAccountCount: 0,
    });
  });

  test('keeps invalid financial display values fail-fast', () => {
    expect(graph3dEntityBigInt(null)).toBe(0n);
    expect(graph3dEntityBigInt(7.9)).toBe(7n);
    expect(graph3dEntityBigInt('-4n')).toBe(-4n);
    expect(() => graph3dEntityBigInt('not-an-amount')).toThrow();
  });

  test('keeps stores and rendering in Svelte while delegating deterministic projection', () => {
    const source = readFileSync('frontend/src/lib/view/components/EntityMiniPanel.svelte', 'utf8');

    expect(source).toContain("from '../../../../packages/runtime-client/src/graph3d-entity-panel-view'");
    expect(source).toContain('createGraph3dEntityPanelView({');
    expect(source).toContain('$runtimeFrameEnv');
    expect(source).toContain("dispatch('action'");
    expect(source).not.toContain('function getReserveValue');
    expect(source).not.toContain('function getDelta');
  });
});
