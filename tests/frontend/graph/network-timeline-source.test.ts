import { describe, expect, test } from 'bun:test';

import {
  adapterNetworkTimelineSource,
  decodeNetworkTrailFromHash,
  encodeNetworkTrailForHash,
  parseNetworkTrail,
  serializeNetworkTrail,
  recordNetworkTrail,
  scenarioNetworkTimelineSource,
  trailNetworkTimelineSource,
} from '../../../frontend/src/lib/network3d/timeline/networkTimelineSource';
import {
  activityForStep,
  captionForStep,
  describeEvent,
} from '../../../frontend/src/lib/network3d/timeline/networkCaption';

type ReadCall = { path: string; query?: Record<string, unknown> };

const frame = (height: number) => ({
  runtimeId: 'h1',
  height,
  timestamp: 1_000 + height,
  entities: [],
});

const activityEvent = (height: number, id: string, title: string, subtitle = '') => ({
  id,
  runtimeId: 'h1',
  height,
  timestamp: 1_000 + height,
  kind: 'offchain',
  type: 'payment',
  source: 'entity',
  direction: 'out',
  title,
  subtitle,
  status: 'settled',
  rawType: 'directPayment',
});

/** Adapter that pages like the real one: timeline-index and activity both walk backwards. */
const fakeAdapter = (options: { heights: number[]; events: ReturnType<typeof activityEvent>[]; pageSize?: number }) => {
  const calls: ReadCall[] = [];
  const pageSize = options.pageSize ?? 2;
  const descending = [...options.heights].sort((left, right) => right - left);

  const read = async <T>(path: string, query?: Record<string, unknown>): Promise<T> => {
    calls.push({ path, ...(query ? { query } : {}) });
    if (path === 'timeline-index') {
      const before = Number(query?.['beforeHeight'] ?? Math.max(...descending) + 1);
      const window = descending.filter((height) => height < before).slice(0, pageSize);
      const last = window[window.length - 1];
      const hasMore = descending.some((height) => last !== undefined && height < last);
      return {
        runtimeId: 'h1',
        entries: window.map((height) => ({
          runtimeId: 'h1',
          height,
          timestamp: 1_000 + height,
          stateHash: `hash-${height}`,
          materialized: true,
          graphChanged: true,
        })),
        nextBeforeHeight: hasMore && last !== undefined ? last : null,
      } as T;
    }
    if (path === 'graph-frame') {
      const height = Number(query?.['atHeight']);
      if (!descending.includes(height)) throw new Error(`no frame ${height}`);
      return frame(height) as T;
    }
    if (path === 'activity') {
      const before = Number(query?.['beforeHeight'] ?? Math.max(...descending) + 1);
      const window = options.events
        .filter((event) => event.height < before)
        .sort((left, right) => right.height - left.height)
        .slice(0, pageSize);
      const last = window[window.length - 1];
      const hasMore = options.events.some((event) => last !== undefined && event.height < last.height);
      return {
        ok: true,
        events: window,
        nextBeforeHeight: hasMore && last !== undefined ? last.height : null,
      } as T;
    }
    throw new Error(`unexpected path ${path}`);
  };

  return { read: read as never, calls };
};

describe('network timeline source', () => {
  test('reads a paged timeline index through the adapter, local or remote alike', async () => {
    const adapter = fakeAdapter({ heights: [1, 2, 3, 4, 5], events: [] });
    const source = adapterNetworkTimelineSource('H1', adapter);

    const index = await source.readIndex();

    expect(source.runtimeId).toBe('h1');
    expect(index.frames.map((entry) => entry.height)).toEqual([1, 2, 3, 4, 5]);
    // Regression: local runtimes used to read env.history, which is permanently empty
    // (RECENT_RUNTIME_HISTORY_LIMIT = 0), so the browser timeline had zero frames.
    expect(adapter.calls.filter((call) => call.path === 'timeline-index').length).toBeGreaterThan(1);
  });

  test('rejects a frame that does not match the requested runtime or height', async () => {
    const adapter = {
      read: async () => ({ runtimeId: 'other', height: 3, entities: [] }),
    };
    await expect(adapterNetworkTimelineSource('h1', adapter as never).readGraphFrame(3))
      .rejects.toThrow('NETWORK_GRAPH_RUNTIME_ID_MISMATCH:h1:other');

    const shifted = { read: async () => ({ runtimeId: 'h1', height: 9, entities: [] }) };
    await expect(adapterNetworkTimelineSource('h1', shifted as never).readGraphFrame(3))
      .rejects.toThrow('NETWORK_TIMELINE_FRAME_MISMATCH:h1:h3:h9');
  });

  test('collects activity inside a height window and drops everything outside', async () => {
    const events = [
      activityEvent(1, 'a', 'too old'),
      activityEvent(2, 'b', 'Alice → Hub'),
      activityEvent(3, 'c', 'Hub → Bob'),
      activityEvent(5, 'd', 'too new'),
    ];
    const source = adapterNetworkTimelineSource('h1', fakeAdapter({ heights: [1, 2, 3, 5], events }));

    const collected = await source.readActivity(2, 3);

    expect(collected.map((event) => event.id)).toEqual(['b', 'c']);
  });

  test('rejects an inverted activity window', async () => {
    const source = adapterNetworkTimelineSource('h1', fakeAdapter({ heights: [1, 2], events: [] }));
    await expect(source.readActivity(5, 2)).rejects.toThrow('NETWORK_ACTIVITY_RANGE_INVALID:5:2');
  });

  test('a recorded trail replays identically to the live source it came from', async () => {
    const events = [activityEvent(2, 'b', 'Alice → Hub'), activityEvent(3, 'c', 'Hub → Bob')];
    const live = adapterNetworkTimelineSource('h1', fakeAdapter({ heights: [1, 2, 3], events }));

    const trail = await recordNetworkTrail(live);
    const replay = trailNetworkTimelineSource(trail);

    expect(trail.version).toBe(1);
    expect(replay.runtimeId).toBe(live.runtimeId);
    expect((await replay.readIndex()).frames).toEqual((await live.readIndex()).frames);
    expect(await replay.readGraphFrame(2)).toEqual(await live.readGraphFrame(2));
    expect(await replay.readActivity(1, 3)).toEqual(await live.readActivity(1, 3));
  });

  test('a browser scenario run becomes a source: index and captions with no storage', async () => {
    const snapshot = (height: number, entityTxs: unknown[]) => ({
      state: {
        height,
        timestamp: 1_000 + height,
        eReplicas: new Map(),
        jReplicas: new Map(),
      },
      runtimeOutputs: [],
      description: `Frame ${height}`,
      runtimeInput: {
        runtimeTxs: [],
        jInputs: [],
        entityInputs: entityTxs.length > 0 ? [{ entityId: '0xalice', entityTxs }] : [],
      },
    });
    const source = scenarioNetworkTimelineSource('demo-ahb', [
      snapshot(1, []),
      snapshot(2, [{ type: 'openAccount', data: { targetEntityId: '0xhub' } }]),
    ] as never);

    const index = await source.readIndex();
    expect(source.runtimeId).toBe('demo-ahb');
    expect(index.frames.map((frame) => ({ height: frame.height, graphChanged: frame.graphChanged })))
      .toEqual([{ height: 1, graphChanged: false }, { height: 2, graphChanged: true }]);

    // Captions come from the same runtime builder the live adapter uses.
    const events = await source.readActivity(1, 2);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.runtimeId === 'demo-ahb')).toBe(true);
    expect(events.every((event) => event.height === 2)).toBe(true);

    await expect(source.readGraphFrame(9)).rejects.toThrow('NETWORK_SCENARIO_FRAME_MISSING:demo-ahb:h9');
  });

  test('a scenario frame is JSON-safe, which is what lets a browser demo be recorded', async () => {
    const source = scenarioNetworkTimelineSource('demo', [{
      state: {
        height: 1,
        timestamp: 1_000,
        eReplicas: new Map([['0xalice:s', {
          entityId: '0xALICE',
          state: { accounts: new Map([['0xhub', { currentHeight: 4 }]]) },
        }]]),
      },
      runtimeInput: { runtimeTxs: [], jInputs: [], entityInputs: [] },
      gossip: { profiles: [{ entityId: '0xALICE', name: 'Alice' }] },
    }] as never);

    const frame = await source.readGraphFrame(1);

    expect(frame.runtimeId).toBe('demo');
    expect(frame.height).toBe(1);
    expect(frame.entities[0]?.summary.label).toBe('Alice');
    expect(frame.entities[0]?.accounts.items[0]).toMatchObject({
      leftEntity: '0xalice',
      rightEntity: '0xhub',
      currentHeight: 4,
    });
    // Frames carry Maps and bigints, so the trail codec — not plain JSON — is what must
    // round-trip them.
    const trail = { version: 1 as const, runtimeId: 'demo', index: { runtimeId: 'demo', frames: [] }, frames: { '1': frame }, activity: [] };
    expect(parseNetworkTrail(serializeNetworkTrail(trail))).toEqual(trail);
  });

  test('a trail survives a URL round trip with its bigints and maps intact', async () => {
    // Deltas are bigints inside a Map — plain JSON drops both, and a demo without deltas
    // renders as bare spheres with no credit or collateral.
    const trail = {
      version: 1 as const,
      runtimeId: 'demo',
      index: { runtimeId: 'demo', frames: [{ runtimeId: 'demo', height: 1, timestamp: 10, stateHash: 's', materialized: true, graphChanged: true }] },
      frames: {
        '1': {
          runtimeId: 'demo',
          height: 1,
          entities: [{
            summary: { entityId: '0xalice', label: 'Alice' },
            core: { reserves: new Map([[1, 5_000n]]) },
            accounts: { items: [{ leftEntity: '0xalice', rightEntity: '0xhub', deltas: new Map([[1, { collateral: 10n, offdelta: -3n }]]) }] },
          }],
        },
      },
      activity: [],
    } as never;

    const encoded = await encodeNetworkTrailForHash(trail);
    expect(encoded).not.toMatch(/[+/=]/); // URL-safe: survives being pasted into a hash

    const restored = await decodeNetworkTrailFromHash(encoded);
    const account = restored.frames['1']?.entities[0]?.accounts.items[0] as never as { deltas: Map<number, { collateral: bigint }> };
    expect(account.deltas.get(1)?.collateral).toBe(10n);
    expect((restored.frames['1']?.entities[0]?.core as never as { reserves: Map<number, bigint> }).reserves.get(1)).toBe(5_000n);
    expect(restored).toEqual(trail);

    // Replaying the decoded trail must behave like the original.
    expect((await trailNetworkTimelineSource(restored).readIndex()).frames).toHaveLength(1);
  });

  test('rejects a trail that is not a trail instead of rendering garbage', async () => {
    await expect(decodeNetworkTrailFromHash('not-gzip')).rejects.toThrow();
    expect(() => parseNetworkTrail('{"version":2}')).toThrow('NETWORK_TRAIL_VERSION_UNSUPPORTED');
    expect(() => parseNetworkTrail('{"version":1}')).toThrow('NETWORK_TIMELINE_RUNTIME_ID_REQUIRED');
  });

  test('a scenario frame carries the deltas and reserves the graph renders', async () => {
    const source = scenarioNetworkTimelineSource('demo', [{
      state: {
        height: 1,
        timestamp: 1_000,
        eReplicas: new Map([['0xalice:s', {
          entityId: '0xALICE',
          signerId: 's',
          state: {
            profile: { name: 'Alice', isHub: false },
            reserves: new Map([[1, 7n]]),
            accounts: new Map([['0xhub', {
              status: 'open',
              currentHeight: 3,
              mempool: [{ type: 'directPayment' }],
              state: {
                deltas: new Map([[1, { tokenId: 1, collateral: 100n, offdelta: -5n }]]),
              },
              activeDispute: { startedByLeft: true, disputeTimeout: 42, initialNonce: 7 },
            }]]),
          },
        }]]),
      },
      runtimeInput: { runtimeTxs: [], jInputs: [], entityInputs: [] },
    }] as never);

    const entity = (await source.readGraphFrame(1)).entities[0]!;
    const account = entity.accounts.items[0] as never as {
      deltas: Map<number, { collateral: bigint }>;
      mempoolCount: number;
      activeDispute: { initialNonce: number };
    };

    // Without these the bars, the mempool boxes and the dispute marker all render empty.
    expect(account.deltas.get(1)?.collateral).toBe(100n);
    expect(account.mempoolCount).toBe(1);
    expect(account.activeDispute.initialNonce).toBe(7);
    expect(entity.core?.reserves).toEqual(new Map([[1, 7n]]));
    expect(entity.summary.label).toBe('Alice');
  });

  test('a trail reports a missing frame instead of rendering a hole', async () => {
    const replay = trailNetworkTimelineSource({
      version: 1,
      runtimeId: 'h1',
      index: { runtimeId: 'h1', frames: [] },
      frames: {},
      activity: [],
    });
    await expect(replay.readGraphFrame(4)).rejects.toThrow('NETWORK_TRAIL_FRAME_MISSING:h1:h4');
    expect(() => trailNetworkTimelineSource({ version: 2 } as never)).toThrow('NETWORK_TRAIL_VERSION_UNSUPPORTED');
  });
});

describe('network caption', () => {
  const step = (height: number, cues: Array<{ title: string; subtitle?: string; accent?: string }> = []) => ({
    runtimeId: 'h1',
    height,
    cues: cues.map((cue, index) => ({ id: `cue-${index}`, at: { runtimeId: 'h1', height, timestamp: 1 }, ...cue })) as never,
  });

  test('derives the caption from runtime activity, so live debugging needs no authoring', () => {
    const events = [activityEvent(2, 'b', 'Alice → Hub', '100 USDC routed')];

    const caption = captionForStep(step(2), events);

    expect(caption).toEqual({
      title: 'Alice → Hub',
      subtitle: '100 USDC routed',
      mechanic: 'Bilateral transfer — settled between two parties, nothing on-chain.',
      extraCount: 0,
      source: 'activity',
    });
  });

  test('counts the remaining events of a busy frame instead of hiding them', () => {
    const events = [
      activityEvent(2, 'b', 'Alice → Hub'),
      activityEvent(2, 'c', 'Hub → Bob'),
      activityEvent(2, 'd', 'Bob settles'),
      activityEvent(3, 'e', 'next frame'),
    ];

    const caption = captionForStep(step(2), events);

    expect(caption.title).toBe('Alice → Hub');
    expect(caption.extraCount).toBe(2);
  });

  test('an authored cue wins over derived activity', () => {
    const events = [activityEvent(2, 'b', 'Alice → Hub')];

    const caption = captionForStep(step(2, [{ title: 'Bank run begins', subtitle: 'Hub stops cooperating', accent: '#f00' }]), events);

    expect(caption).toEqual({
      title: 'Bank run begins',
      subtitle: 'Hub stops cooperating',
      mechanic: '',
      extraCount: 0,
      source: 'cue',
      accent: '#f00',
    });
  });

  test('falls back to the frame number rather than showing an empty caption', () => {
    expect(captionForStep(step(7), [])).toEqual({
      title: 'Frame 7',
      subtitle: '',
      mechanic: '',
      extraCount: 0,
      source: 'frame',
    });
  });

  test('explains the mechanic behind each step instead of echoing the tx type', () => {
    const mechanicOf = (type: string, rawType: string) =>
      captionForStep(step(2), [{ ...activityEvent(2, 'b', 'x'), type, rawType } as never]).mechanic;

    expect(mechanicOf('payment', 'directPayment')).toContain('nothing on-chain');
    expect(mechanicOf('htlc', 'htlc_lock')).toContain('cannot take the money mid-hop');
    expect(mechanicOf('settlement', 'settle_approve')).toContain('only the difference');
    expect(mechanicOf('j_batch', 'jInput')).toContain('one on-chain transaction');
    // Raw type is sharper than the coarse category where it matters.
    expect(mechanicOf('account', 'set_credit_limit')).toContain('without locking collateral');
    expect(mechanicOf('account', 'reserveToCollateral')).toContain('costs a J-transaction');
    expect(mechanicOf('account', 'openAccount')).toContain('no network-wide registration');
    expect(mechanicOf('j_event', 'disputeStarted')).toContain('last signed frame');
    expect(mechanicOf('unknown-type', 'whatever')).toBe('');
  });

  test('names participants and formats amounts instead of showing hex and minor units', () => {
    const event = { ...activityEvent(2, 'b', 'Payment sent'), entityId: '0xalice', counterpartyId: '0xhub', tokenId: 1, amount: '100000000', direction: 'out' } as never;
    const context = {
      labelFor: (id: string) => ({ '0xalice': 'Alice', '0xhub': 'Hub' })[id] ?? '',
      formatAmount: (tokenId: number, minor: string) => `${Number(minor) / 1e6} USDC${tokenId === 1 ? '' : '?'}`,
    };

    expect(describeEvent(event, context)).toBe('100 USDC  ·  Alice → Hub');
    expect(captionForStep(step(2), [event], context).subtitle).toBe('100 USDC  ·  Alice → Hub');
  });

  test('falls back to shortened ids and the runtime subtitle without a context', () => {
    const known = { ...activityEvent(2, 'b', 'Payment sent'), entityId: '0xaaaabbbbccccdddd', counterpartyId: '0x1111222233334444', tokenId: 1, amount: '5', direction: 'out' } as never;
    expect(describeEvent(known)).toBe('5 (token 1)  ·  0xaaaa…dddd → 0x1111…4444');

    const bare = { ...activityEvent(2, 'c', 'System', 'runtime bookkeeping') } as never;
    expect(describeEvent(bare)).toBe('runtime bookkeeping');
  });

  test('ignores activity belonging to another runtime at the same height', () => {
    const foreign = { ...activityEvent(2, 'x', 'other network'), runtimeId: 'h2' };
    const mine = activityEvent(2, 'b', 'Alice → Hub');

    expect(activityForStep([foreign, mine], step(2)).map((event) => event.id)).toEqual(['b']);
    expect(captionForStep(step(2), [foreign, mine]).title).toBe('Alice → Hub');
  });
});
