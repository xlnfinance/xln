import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  mergeRuntimeGraphProjections,
  projectRuntimeGraphFrame,
  projectRuntimeViewFrame,
  requireActionableGraphNodeRuntimeId,
  resolveActionableGraphNodeRuntimeId,
  type RuntimeGraphAccountState,
  type RuntimeGraphNodeState,
  type RuntimeGraphProjection,
  type RuntimeGraphSource,
} from '../../frontend/src/lib/network3d/runtimeGraphProjection';
import {
  mergeRuntimeTimelineIndexes,
  selectMergedTimelineAt,
  selectMergedTimelineEvent,
  runtimeTimelineColor,
} from '../../frontend/src/lib/network3d/runtimeGraphTimeline';
import {
  connectedRuntimeGraphEntityIds,
  layoutRuntimeGraph,
  resolveRuntimeGraphLayout,
} from '../../frontend/src/lib/network3d/runtimeGraphLayout';
import {
  GRAPH_POSITION_OVERRIDES_KEY,
  readGraphPositionOverrides,
  writeGraphPositionOverride,
} from '../../frontend/src/lib/network3d/graphPositionOverrides';
import { materializeRuntimeGraphReplicas } from '../../frontend/src/lib/network3d/runtimeGraphRender';
import {
  compileNetworkMachine,
  normalizeNetworkMachineConfig,
  parseNetworkMachineConfig,
  type NetworkMachineConfig,
} from '../../frontend/src/lib/network3d/networkMachine';
import {
  readTimelineIndexPages,
  timelineIndexFromBrowserRuntime,
} from '../../frontend/src/lib/network3d/networkTimelineLoader';
import { assertNetworkMachineIsLive } from '../../frontend/src/lib/stores/networkMachineRuntimeStore';
import {
  beginGraphGesture,
  emptyGraphGestureState,
  endGraphGesture,
} from '../../frontend/src/lib/network3d/graphSelectionGesture';
import { immersiveWalletActionAt } from '../../frontend/src/lib/network3d/ImmersiveWalletSurface';

const source = (runtimeId: string, height: number, timestamp: number): RuntimeGraphSource => ({
  runtimeId,
  label: runtimeId,
  adapterKind: runtimeId.startsWith('remote') ? 'remote' : 'browser',
  height,
  timestamp,
});

const node = (
  runtimeId: string,
  entityId: string,
  height: number,
  timestamp: number,
  isHub = false,
): RuntimeGraphNodeState => ({
  ...source(runtimeId, height, timestamp),
  entityId,
  label: `${entityId}@${runtimeId}`,
  signerId: `${runtimeId}-signer`,
  isHub,
  jurisdiction: 'testnet',
  position: null,
  replica: null,
  core: null,
});

const account = (
  runtimeId: string,
  observerEntityId: string,
  height: number,
  timestamp: number,
  observerIsHub = false,
): RuntimeGraphAccountState => ({
  ...source(runtimeId, height, timestamp),
  accountId: 'a:b',
  observerEntityId,
  observerIsHub,
  leftEntityId: 'a',
  rightEntityId: 'b',
  height,
  account: { status: height % 2 ? 'open' : 'disputed' },
});

const projection = (
  runtimeId: string,
  nodes: RuntimeGraphNodeState[],
  accounts: RuntimeGraphAccountState[] = [],
): RuntimeGraphProjection => ({
  source: source(runtimeId, nodes[0]?.height ?? 0, nodes[0]?.timestamp ?? 0),
  nodes,
  accounts,
  jMachines: [],
});

describe('RuntimeGraphProjection', () => {
  test('Merged summary-only entities keep provenance without claiming unverifiable desynchronization', () => {
    const merged = mergeRuntimeGraphProjections([
      projection('browser-a', [node('browser-a', 'a', 5, 1_000)]),
      projection('remote-b', [node('remote-b', 'a', 4, 2_000)]),
    ], 'timestamp');

    expect(merged.nodes).toHaveLength(1);
    expect(merged.nodes[0]?.selected.runtimeId).toBe('remote-b');
    expect(merged.nodes[0]?.provenance).toEqual(['browser-a', 'remote-b']);
    expect(merged.nodes[0]?.desynchronized).toBe(false);
  });

  test('merged rendering and wallet navigation prefer an actionable core over a newer summary-only peer', () => {
    const summaryOnly = node('remote-a', 'hub-b', 9, 2_000, true);
    const actionable = node('remote-b', 'hub-b', 8, 1_000, true);
    actionable.core = {
      entityId: 'hub-b',
      signerId: 'hub-b-signer',
      reserves: new Map([[1, 12n]]),
    } as never;
    actionable.signerId = 'hub-b-signer';
    const merged = mergeRuntimeGraphProjections([
      projection('remote-a', [summaryOnly]),
      projection('remote-b', [actionable]),
    ], 'timestamp');
    const mergedNode = merged.nodes[0];

    expect(mergedNode?.selected.runtimeId).toBe('remote-b');
    expect(mergedNode?.desynchronized).toBe(false);
    const rendered = materializeRuntimeGraphReplicas(merged);
    expect(rendered.get('hub-b:hub-b-signer')?.state.reserves).toEqual(new Map([[1, 12n]]));
    expect(resolveActionableGraphNodeRuntimeId(mergedNode, 'remote-a')).toBe('remote-b');
    expect(resolveActionableGraphNodeRuntimeId(mergedNode, 'remote-b')).toBe('remote-b');
    expect(resolveActionableGraphNodeRuntimeId(
      mergeRuntimeGraphProjections([projection('remote-a', [summaryOnly])], 'timestamp').nodes[0],
      'remote-a',
    )).toBe('');
    expect(() => requireActionableGraphNodeRuntimeId(
      mergeRuntimeGraphProjections([projection('remote-a', [summaryOnly])], 'timestamp').nodes[0],
      'remote-a',
    )).toThrow('GRAPH_ENTITY_NOT_ACTIONABLE:hub-b');
  });

  test('Merged J-Machine summaries keep provenance without treating null projections as conflicts', () => {
    const first = projection('browser-a', [node('browser-a', 'a', 5, 1_000)]);
    first.jMachines = [{ ...source('browser-a', 5, 1_000), jMachineId: 'testnet', name: 'Testnet', position: null, machine: { blockNumber: 5 } }];
    const second = projection('remote-b', [node('remote-b', 'b', 4, 2_000)]);
    second.jMachines = [{ ...source('remote-b', 4, 2_000), jMachineId: 'testnet', name: 'Testnet', position: null, machine: null }];
    const merged = mergeRuntimeGraphProjections([first, second], 'timestamp');
    expect(merged.jMachines).toHaveLength(1);
    expect(merged.jMachines[0]?.selected.runtimeId).toBe('browser-a');
    expect(merged.jMachines[0]?.provenance).toEqual(['browser-a', 'remote-b']);
    expect(merged.jMachines[0]?.desynchronized).toBe(false);
  });

  test('Merged J-Machines report divergence when two materialized machine states differ', () => {
    const first = projection('browser-a', [node('browser-a', 'a', 5, 1_000)]);
    first.jMachines = [{ ...source('browser-a', 5, 1_000), jMachineId: 'testnet', name: 'Testnet', position: null, machine: { blockNumber: 5 } }];
    const sameBlockLaterRuntime = projection('browser-c', [node('browser-c', 'c', 8, 3_000)]);
    sameBlockLaterRuntime.jMachines = [{ ...source('browser-c', 5, 3_000), jMachineId: 'testnet', name: 'Testnet', position: null, machine: { blockNumber: 5 } }];
    const second = projection('browser-b', [node('browser-b', 'b', 4, 2_000)]);
    second.jMachines = [{ ...source('browser-b', 4, 2_000), jMachineId: 'testnet', name: 'Testnet', position: null, machine: { blockNumber: 4 } }];

    expect(mergeRuntimeGraphProjections([first, sameBlockLaterRuntime], 'timestamp').jMachines[0]?.desynchronized).toBe(false);
    expect(mergeRuntimeGraphProjections([first, second], 'timestamp').jMachines[0]?.desynchronized).toBe(true);
  });

  test('account canonicity selects left, right, hub, height, or timestamp deterministically', () => {
    const projections = [
      projection('browser-left', [node('browser-left', 'a', 5, 1_000)], [account('browser-left', 'a', 5, 1_000)]),
      projection('remote-right', [node('remote-right', 'b', 8, 900)], [account('remote-right', 'b', 8, 900, true)]),
    ];

    expect(mergeRuntimeGraphProjections(projections, 'left').accounts[0]?.selected.observerEntityId).toBe('a');
    expect(mergeRuntimeGraphProjections(projections, 'right').accounts[0]?.selected.observerEntityId).toBe('b');
    expect(mergeRuntimeGraphProjections(projections, 'hub').accounts[0]?.selected.runtimeId).toBe('remote-right');
    expect(mergeRuntimeGraphProjections(projections, 'height').accounts[0]?.selected.height).toBe(8);
    expect(mergeRuntimeGraphProjections(projections, 'timestamp').accounts[0]?.selected.timestamp).toBe(1_000);
  });

  test('runtime filter excludes every other source', () => {
    const merged = mergeRuntimeGraphProjections([
      projection('browser-a', [node('browser-a', 'a', 1, 1)]),
      projection('remote-b', [node('remote-b', 'b', 1, 1)]),
    ], 'timestamp', 'remote-b');
    expect(merged.sources.map((item) => item.runtimeId)).toEqual(['remote-b']);
    expect(merged.nodes.map((item) => item.entityId)).toEqual(['b']);
  });

  test('render replicas contain only the policy-selected account observation', () => {
    const merged = mergeRuntimeGraphProjections([
      projection('browser-left', [node('browser-left', 'a', 5, 1_000), node('browser-left', 'b', 5, 1_000)], [account('browser-left', 'a', 5, 1_000)]),
      projection('remote-right', [node('remote-right', 'a', 8, 900), node('remote-right', 'b', 8, 900)], [account('remote-right', 'b', 8, 900)]),
    ], 'right');
    const replicas = materializeRuntimeGraphReplicas(merged);
    const left = Array.from(replicas.values()).find((replica) => replica.entityId === 'a');
    const right = Array.from(replicas.values()).find((replica) => replica.entityId === 'b');
    expect(left?.state.accounts.size).toBe(0);
    expect(right?.state.accounts.get('a')).toMatchObject({ status: 'disputed' });
  });

  test('remote view-frame projects bounded nodes, accounts, and runtime provenance', () => {
    const frame = {
      height: 9,
      entities: [
        { entityId: 'a', label: 'Alice', height: 9 },
        { entityId: 'b', label: 'Bob', height: 8 },
      ],
      activeEntityId: 'a',
      activeEntity: {
        core: { entityId: 'a', signerId: 'alice-signer', height: 9, timestamp: 1_234, profile: {} },
        accounts: { items: [{ leftEntity: 'a', rightEntity: 'b', currentHeight: 7 }], nextCursor: null },
        books: { items: [], nextCursor: null },
      },
    } as never;
    const result = projectRuntimeViewFrame(frame, { runtimeId: 'remote-a', adapterKind: 'remote' });
    expect(result.nodes.map((item) => item.entityId)).toEqual(['a', 'b']);
    expect(result.accounts[0]).toMatchObject({ accountId: 'a:b', observerEntityId: 'a', height: 7 });
    expect(result.source).toMatchObject({ runtimeId: 'remote-a', timestamp: 1_234 });
  });

  test('remote graph-frame projects every local and summary-only peer node', () => {
    const frame = {
      height: 9,
      timestamp: 1_234,
      entities: [
        {
          summary: { entityId: 'a', label: 'Alice', height: 9, jurisdiction: { name: 'Testnet' } },
          core: {
            entityId: 'a',
            signerId: 'alice-signer',
            height: 9,
            timestamp: 1_234,
            profile: { name: 'Alice' },
          },
          accounts: {
            items: [{
              leftEntity: 'a',
              rightEntity: 'b',
              currentHeight: 7,
              currentFrame: { height: 7, accountStateRoot: 'root-a' },
            }],
            nextCursor: null,
          },
        },
        {
          summary: { entityId: 'b', label: 'Bob', height: 8, jurisdiction: { name: 'Testnet' } },
          core: null,
          accounts: { items: [], nextCursor: null },
        },
      ],
    } as never;

    const result = projectRuntimeGraphFrame(frame, { runtimeId: 'remote-a', adapterKind: 'remote' });
    expect(result.nodes.map((item) => item.entityId)).toEqual(['a', 'b']);
    expect(result.nodes.find((item) => item.entityId === 'a')).toMatchObject({ signerId: 'alice-signer' });
    expect(result.nodes.find((item) => item.entityId === 'b')).toMatchObject({ label: 'Bob', core: null });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({ accountId: 'a:b', observerEntityId: 'a', height: 7 });
    expect(result.source).toMatchObject({ runtimeId: 'remote-a', timestamp: 1_234 });
  });

  test('account desynchronization includes the canonical account-state root', () => {
    const left = account('remote-left', 'a', 7, 1_000);
    left.account = {
      status: 'active',
      currentHeight: 7,
      currentFrame: { height: 7, accountStateRoot: 'root-left' },
    };
    const right = account('remote-right', 'b', 7, 1_000);
    right.account = {
      status: 'active',
      currentHeight: 7,
      currentFrame: { height: 7, accountStateRoot: 'root-right' },
    };
    const merged = mergeRuntimeGraphProjections([
      projection('remote-left', [node('remote-left', 'a', 7, 1_000)], [left]),
      projection('remote-right', [node('remote-right', 'b', 7, 1_000)], [right]),
    ], 'timestamp');

    expect(merged.accounts[0]?.desynchronized).toBe(true);
  });

  test('node desynchronization includes reserves that drive rendered node size', () => {
    const left = node('remote-left', 'a', 7, 1_000);
    left.core = { reserves: new Map([[1, 100n]]) } as never;
    const right = node('remote-right', 'a', 7, 1_000);
    right.core = { reserves: new Map([[1, 200n]]) } as never;
    const merged = mergeRuntimeGraphProjections([
      projection('remote-left', [left]),
      projection('remote-right', [right]),
    ], 'timestamp');

    expect(merged.nodes[0]?.desynchronized).toBe(true);
  });

  test('Graph3D projection effect explicitly tracks every asynchronous graph source', async () => {
    const frontendRequire = createRequire(new URL('../../frontend/package.json', import.meta.url));
    const compilerPath = frontendRequire.resolve('svelte/compiler');
    const { compile } = await import(pathToFileURL(compilerPath).href) as typeof import('svelte/compiler');
    const source = readFileSync(
      new URL('../../frontend/src/lib/view/panels/Graph3DPanel.svelte', import.meta.url),
      'utf8',
    );
    const compiled = compile(source, {
      generate: 'client',
      dev: true,
      filename: 'Graph3DPanel.svelte',
    }).js.code;
    const projectionWrite = compiled.indexOf('$.set(graphProjections');
    const effectStart = compiled.lastIndexOf('$.legacy_pre_effect', projectionWrite);
    expect(projectionWrite).toBeGreaterThan(effectStart);
    const dependencyBlock = compiled.slice(effectStart, projectionWrite);

    for (const dependency of [
      '$runtimes()',
      '$activeRuntimeId()',
      '$runtimeControllerHandle()',
      '$runtimeGraphScope()',
      '$networkMachineRuntime()',
      '$runtimeGraphLiveFrameCache()',
      '$.get(env)',
    ]) {
      expect(dependencyBlock).toContain(dependency);
    }
    expect(dependencyBlock).not.toContain('$.legacy_pre_effect(() => {}');
  });
});

describe('Merged runtime timeline', () => {
  const indexes = [
    { runtimeId: 'a', frames: [
      { runtimeId: 'a', height: 1, timestamp: 100, stateHash: 'a1', materialized: true },
      { runtimeId: 'a', height: 2, timestamp: 300, stateHash: 'a2', materialized: true },
    ] },
    { runtimeId: 'b', frames: [
      { runtimeId: 'b', height: 1, timestamp: 200, stateHash: 'b1', materialized: true },
      { runtimeId: 'b', height: 2, timestamp: 300, stateHash: 'b2', materialized: false },
    ] },
  ];

  test('global events use separate deterministic timestamp/runtimeId/height ticks', () => {
    const events = mergeRuntimeTimelineIndexes(indexes);
    expect(events.map((event) => event.timestamp)).toEqual([100, 200, 300, 300]);
    expect(events.slice(2).map((event) => `${event.changed[0]?.runtimeId}:${event.changed[0]?.height}`)).toEqual(['a:2', 'b:2']);
  });

  test('selection uses causal floor and never leaks a future frame backward', () => {
    const at250 = selectMergedTimelineAt(indexes, 250);
    expect(at250.byRuntime.get('a')?.height).toBe(1);
    expect(at250.byRuntime.get('b')?.height).toBe(1);
    const at150 = selectMergedTimelineAt(indexes, 150);
    expect(at150.byRuntime.get('a')?.height).toBe(1);
    expect(at150.byRuntime.get('b')).toBeNull();
  });

  test('same-millisecond runtime events advance in lexical runtime order', () => {
    const events = mergeRuntimeTimelineIndexes(indexes);
    const afterA = selectMergedTimelineEvent(indexes, events[2]!.changed[0]!);
    expect(afterA.byRuntime.get('a')?.height).toBe(2);
    expect(afterA.byRuntime.get('b')?.height).toBe(1);
    const afterB = selectMergedTimelineEvent(indexes, events[3]!.changed[0]!);
    expect(afterB.byRuntime.get('b')?.height).toBe(2);
  });

  test('runtime highlight colors are stable and runtime-specific', () => {
    expect(runtimeTimelineColor('Runtime-A')).toBe(runtimeTimelineColor('runtime-a'));
    expect(runtimeTimelineColor('runtime-a')).not.toBe(runtimeTimelineColor('runtime-b'));
  });
});

describe('NetworkMachine', () => {
  const indexes = [
    { runtimeId: 'b', frames: [
      { runtimeId: 'b', height: 1, timestamp: 200, stateHash: 'b1', materialized: true, graphChanged: true },
      { runtimeId: 'b', height: 2, timestamp: 300, stateHash: 'b2', materialized: true, graphChanged: false },
    ] },
    { runtimeId: 'a', frames: [
      { runtimeId: 'a', height: 1, timestamp: 100, stateHash: 'a1', materialized: true, graphChanged: false },
      { runtimeId: 'a', height: 2, timestamp: 300, stateHash: 'a2', materialized: true, graphChanged: true },
    ] },
  ];
  const config: NetworkMachineConfig = {
    version: 1,
    id: 'investor-demo',
    title: 'RCPAN settlement',
    timelineMode: 'all-frames',
    cues: [{
      id: 'open',
      at: { runtimeId: 'b', height: 1, timestamp: 200 },
      until: { runtimeId: 'a', height: 2, timestamp: 300 },
      title: 'Payment crosses the network',
      subtitle: 'Runtime B observes the account',
      focusEntityIds: ['BOB', 'alice', 'alice'],
    }],
  };

  test('compiles every R-frame in deterministic tuple order by default', () => {
    const machine = compileNetworkMachine(indexes, config);
    expect(machine.indexes.map((index) => index.runtimeId)).toEqual(['a', 'b']);
    expect(machine.steps.map((step) => `${step.event.timestamp}:${step.activeRuntimeId}:${step.event.height}`))
      .toEqual(['100:a:1', '200:b:1', '300:a:2', '300:b:2']);
    expect(machine.steps[1]?.selection.byRuntime.get('a')?.height).toBe(1);
    expect(machine.steps[1]?.cues[0]?.focusEntityIds).toEqual(['alice', 'bob']);
  });

  test('graph-changes mode is an explicit filtered view, not the default', () => {
    const machine = compileNetworkMachine(indexes, { ...config, timelineMode: 'graph-changes' });
    expect(machine.steps.map((step) => `${step.activeRuntimeId}:${step.event.height}`)).toEqual(['b:1', 'a:2']);
  });

  test('runtime filter, cue ranges, and colors stay deterministic after JSON import', () => {
    const parsed = parseNetworkMachineConfig(JSON.stringify({ ...config, runtimeIds: ['B'] }));
    const first = compileNetworkMachine(indexes, parsed);
    const second = compileNetworkMachine(indexes, normalizeNetworkMachineConfig(parsed));
    expect(first).toEqual(second);
    expect(first.steps.map((step) => step.activeRuntimeId)).toEqual(['b', 'b']);
    expect(first.steps[0]?.cues[0]?.title).toBe('Payment crosses the network');
  });

  test('invalid cue ranges and duplicate ids fail loudly', () => {
    expect(() => normalizeNetworkMachineConfig({
      ...config,
      cues: [
        { id: 'same', at: { runtimeId: 'b', height: 2, timestamp: 300 }, title: 'Late' },
        { id: 'same', at: { runtimeId: 'a', height: 1, timestamp: 100 }, title: 'Early' },
      ],
    })).toThrow('NETWORK_MACHINE_CUE_ID_DUPLICATE');
    expect(() => normalizeNetworkMachineConfig({
      ...config,
      cues: [{
        id: 'backward',
        at: { runtimeId: 'b', height: 2, timestamp: 300 },
        until: { runtimeId: 'a', height: 1, timestamp: 100 },
        title: 'Backward',
      }],
    })).toThrow('NETWORK_MACHINE_CUE_RANGE_INVALID');
  });

  test('historical NetworkMachine blocks state transitions globally', () => {
    expect(() => assertNetworkMachineIsLive({ selectedStep: null })).not.toThrow();
    const selectedStep = compileNetworkMachine(indexes, config).steps[0]!;
    expect(() => assertNetworkMachineIsLive({ selectedStep }))
      .toThrow(`RUNTIME_COMMAND_REQUIRES_LIVE_VIEW: network-machine=${selectedStep.activeRuntimeId}:h${selectedStep.event.height}`);
  });
});

describe('NetworkMachine runtime indexes', () => {
  test('browser runtimes expose every materialized R-frame with graph-change metadata', () => {
    const index = timelineIndexFromBrowserRuntime({
      id: 'Browser-A',
      type: 'local',
      label: 'A',
      permissions: 'write',
      status: 'connected',
      env: {
        runtimeId: 'browser-a',
        history: [
          { height: 1, timestamp: 100, runtimeInput: { runtimeTxs: [], jInputs: [], entityInputs: [] } },
          { height: 2, timestamp: 200, runtimeInput: { runtimeTxs: [{ type: 'noop' }], jInputs: [], entityInputs: [] } },
        ],
      } as never,
    });
    expect(index.frames.map((frame) => ({ height: frame.height, graphChanged: frame.graphChanged })))
      .toEqual([{ height: 1, graphChanged: false }, { height: 2, graphChanged: true }]);
  });

  test('remote compact indexes paginate without dropping or reordering frames', async () => {
    const calls: Array<number | undefined> = [];
    const adapter = {
      read: async (_path: string, query?: { beforeHeight?: number }) => {
        calls.push(query?.beforeHeight);
        return query?.beforeHeight === 3
          ? { runtimeId: 'remote-a', latestHeight: 4, entries: [
              { runtimeId: 'remote-a', height: 1, timestamp: 100, stateHash: '1', materialized: true, graphChanged: false },
              { runtimeId: 'remote-a', height: 2, timestamp: 200, stateHash: '2', materialized: true, graphChanged: true },
            ], scannedHeights: 2, nextBeforeHeight: null }
          : { runtimeId: 'remote-a', latestHeight: 4, entries: [
              { runtimeId: 'remote-a', height: 3, timestamp: 300, stateHash: '3', materialized: true, graphChanged: true },
              { runtimeId: 'remote-a', height: 4, timestamp: 400, stateHash: '4', materialized: true, graphChanged: false },
            ], scannedHeights: 2, nextBeforeHeight: 3 };
      },
    };
    const index = await readTimelineIndexPages(adapter as never, 'remote-a');
    expect(calls).toEqual([undefined, 3]);
    expect(index.frames.map((frame) => frame.height)).toEqual([1, 2, 3, 4]);
  });
});

describe('deterministic graph placement', () => {
  test('reuses layout work while balances change but invalidates on topology or user position changes', () => {
    const base = mergeRuntimeGraphProjections([
      projection('browser-a', [node('browser-a', 'a', 1, 1), node('browser-a', 'b', 1, 1)], [
        account('browser-a', 'a', 1, 1),
      ]),
    ], 'timestamp');
    const first = resolveRuntimeGraphLayout(base);
    const balanceOnly = structuredClone(base);
    balanceOnly.nodes[0]!.selected.height = 2;
    const reused = resolveRuntimeGraphLayout(balanceOnly, new Map(), first);
    expect(reused).toBe(first);

    const moved = resolveRuntimeGraphLayout(base, new Map([['a', { x: 9, y: 8, z: 7 }]]), first);
    expect(moved).not.toBe(first);
    expect(moved.positions.get('a')).toMatchObject({ source: 'user', position: { x: 9, y: 8, z: 7 } });

    const topologyChanged = structuredClone(base);
    topologyChanged.accounts = [];
    expect(resolveRuntimeGraphLayout(topologyChanged, new Map(), first)).not.toBe(first);
  });

  test('camera focus includes the account topology without isolated summary-only nodes', () => {
    const graph = mergeRuntimeGraphProjections([
      projection('browser-a', [
        node('browser-a', 'a', 1, 1, true),
        node('browser-a', 'b', 1, 1),
        node('browser-a', 'summary-only', 1, 1),
      ], [account('browser-a', 'a', 1, 1)]),
    ], 'timestamp');

    expect(Array.from(connectedRuntimeGraphEntityIds(graph)).sort()).toEqual(['a', 'b']);
  });

  test('same projection always produces the same 3D layout without random input', () => {
    const graph = mergeRuntimeGraphProjections([
      projection('browser-a', [
        node('browser-a', 'a', 1, 1, true),
        node('browser-a', 'b', 1, 1),
      ], [account('browser-a', 'a', 1, 1)]),
    ], 'timestamp');
    const first = layoutRuntimeGraph(graph);
    const second = layoutRuntimeGraph(graph);
    expect(first).toEqual(second);
    expect(first.get('a')?.position).not.toEqual(first.get('b')?.position);
  });

  test('explicit user x/y/z wins over runtime coordinates and generated layout', () => {
    const positioned = { ...node('browser-a', 'a', 1, 1), position: { x: 1, y: 2, z: 3 } };
    const graph = mergeRuntimeGraphProjections([projection('browser-a', [positioned])], 'timestamp');
    const result = layoutRuntimeGraph(graph, new Map([['a', { x: 9, y: 8, z: 7 }]]));
    expect(result.get('a')).toEqual({ entityId: 'a', position: { x: 9, y: 8, z: 7 }, source: 'user' });
  });

  test('override storage is separate from the old auto-layout cache', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as Storage;
    writeGraphPositionOverride(storage, 'A', { x: 3, y: 4, z: 5 });
    expect(values.has(GRAPH_POSITION_OVERRIDES_KEY)).toBe(true);
    expect(readGraphPositionOverrides(storage).get('a')).toEqual({ x: 3, y: 4, z: 5 });
  });
});

describe('Graph selection gesture', () => {
  test('first select selects, second select opens, and a drag never opens', () => {
    let state = beginGraphGesture(emptyGraphGestureState(), { sourceId: 'xr:right', entityId: 'H1', at: 100 });
    const first = endGraphGesture(state, { sourceId: 'xr:right', entityId: 'H1', at: 140, moved: false });
    expect(first.outcome).toBe('select');
    state = beginGraphGesture(first.state, { sourceId: 'xr:right', entityId: 'H1', at: 300 });
    const second = endGraphGesture(state, { sourceId: 'xr:right', entityId: 'H1', at: 330, moved: false });
    expect(second.outcome).toBe('open');
    state = beginGraphGesture(second.state, { sourceId: 'xr:right', entityId: 'H1', at: 500 });
    const dragged = endGraphGesture(state, { sourceId: 'xr:right', entityId: 'H1', at: 800, moved: true });
    expect(dragged.outcome).toBe('drag-end');
  });

  test('double-select is isolated by source and entity', () => {
    let state = beginGraphGesture(emptyGraphGestureState(), { sourceId: 'touch', entityId: 'h1', at: 100 });
    state = endGraphGesture(state, { sourceId: 'touch', entityId: 'h1', at: 120, moved: false }).state;
    state = beginGraphGesture(state, { sourceId: 'xr:left', entityId: 'h1', at: 200 });
    expect(endGraphGesture(state, { sourceId: 'xr:left', entityId: 'h1', at: 220, moved: false }).outcome).toBe('select');
    state = beginGraphGesture(state, { sourceId: 'touch', entityId: 'h2', at: 250 });
    expect(endGraphGesture(state, { sourceId: 'touch', entityId: 'h2', at: 270, moved: false }).outcome).toBe('select');
  });

  test('immersive wallet hit targets route to real wallet operations', () => {
    expect(immersiveWalletActionAt(100, 520)).toBe('pay');
    expect(immersiveWalletActionAt(350, 520)).toBe('swap');
    expect(immersiveWalletActionAt(600, 520)).toBe('dispute');
    expect(immersiveWalletActionAt(900, 520)).toBe('close');
    expect(immersiveWalletActionAt(10, 10)).toBeNull();
  });
});
