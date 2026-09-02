import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  createGraph3dSceneInputView,
  graph3dSceneTransactionOf,
} from '../../../frontend/packages/runtime-client/src/graph3d-scene-input';

describe('Graph3D scene input model', () => {
  test('projects runtime options, desynchronization count, and jurisdictions', () => {
    const projections = [
      { source: { runtimeId: 'runtime-a', label: 'Alice runtime', adapterKind: 'browser' } },
      { source: { runtimeId: 'runtime-b', label: 'Hub runtime', adapterKind: 'remote' } },
    ];
    const merged = {
      nodes: [{ desynchronized: true }, { desynchronized: false }],
      accounts: [{ desynchronized: true }],
      jMachines: [{
        desynchronized: false,
        provenance: ['runtime-a', 'runtime-b'],
        selected: {
          name: 'US Federal Reserve',
          height: 42,
          position: null,
          machine: { mempool: [{ type: 'settle' }] },
        },
      }],
    };

    expect(createGraph3dSceneInputView(projections, merged)).toEqual({
      runtimeOptions: [
        { value: 'merged', label: 'Merged (2)' },
        { value: 'runtime-a', label: 'Alice runtime · browser' },
        { value: 'runtime-b', label: 'Hub runtime · remote' },
      ],
      desyncCount: 2,
      activeJurisdictionName: 'US Federal Reserve',
      jurisdictions: [{
        name: 'US Federal Reserve',
        jMachine: {
          position: { x: 0, y: 600, z: 0 },
          capacity: 3,
          jHeight: 42,
          mempool: [{ type: 'settle' }],
          provenance: ['runtime-a', 'runtime-b'],
        },
      }],
    });
  });

  test('preserves explicit jurisdiction positions and rejects malformed mempools', () => {
    const selected = {
      name: 'ECB',
      height: 0,
      position: { x: 10, y: 20, z: 30 },
      machine: {},
    };
    expect(createGraph3dSceneInputView([], {
      nodes: [],
      accounts: [],
      jMachines: [{ desynchronized: false, provenance: [], selected }],
    }).jurisdictions[0]?.jMachine.position).toEqual({ x: 10, y: 20, z: 30 });
    expect(() => createGraph3dSceneInputView([], {
      nodes: [],
      accounts: [],
      jMachines: [{
        desynchronized: false,
        provenance: [],
        selected: { ...selected, machine: { mempool: 'invalid' } },
      }],
    })).toThrow('GRAPH_JURISDICTION_MEMPOOL_INVALID:ECB');
  });

  test('normalizes nested graph transactions without inventing fields', () => {
    expect(graph3dSceneTransactionOf({
      type: 'accountInput',
      kind: 123,
      amount: undefined,
      targetEntityId: 'target',
      ignored: 'value',
      data: {
        amount: '15',
        tokenId: 1,
        fromEntityId: 'alice',
        toEntityId: 'bob',
        accountTx: { kind: 'payment', amount: 7n },
      },
    })).toEqual({
      type: 'accountInput',
      targetEntityId: 'target',
      amount: '15',
      data: {
        amount: '15',
        tokenId: 1,
        fromEntityId: 'alice',
        toEntityId: 'bob',
        accountTx: { kind: 'payment', amount: 7n },
      },
    });
    expect(graph3dSceneTransactionOf(null)).toEqual({});
    expect(graph3dSceneTransactionOf({ data: 'invalid' })).toEqual({});
  });

  test('keeps Three.js scene mutation in the Svelte facade', () => {
    const source = readFileSync('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte', 'utf8');

    expect(source).toContain('createGraph3dSceneInputView(graphProjections, mergedRuntimeGraph)');
    expect(source).toContain('graph3dSceneTransactionOf(tx)');
    expect(source).toContain('graphWorld.add(jMachineGroup)');
    expect(source).not.toContain('const graphTransactionOf =');
    expect(source).not.toContain('$: graphRuntimeOptions = [');
  });
});
