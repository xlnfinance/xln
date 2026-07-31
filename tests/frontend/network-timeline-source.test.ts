import { describe, expect, test } from 'bun:test';

import {
  adapterNetworkTimelineSource,
  recordNetworkTrail,
  trailNetworkTimelineSource,
} from '../../frontend/src/lib/network3d/networkTimelineSource';
import {
  activityForStep,
  captionForStep,
} from '../../frontend/src/lib/network3d/networkCaption';

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
      extraCount: 0,
      source: 'cue',
      accent: '#f00',
    });
  });

  test('falls back to the frame number rather than showing an empty caption', () => {
    expect(captionForStep(step(7), [])).toEqual({
      title: 'Frame 7',
      subtitle: '',
      extraCount: 0,
      source: 'frame',
    });
  });

  test('ignores activity belonging to another runtime at the same height', () => {
    const foreign = { ...activityEvent(2, 'x', 'other network'), runtimeId: 'h2' };
    const mine = activityEvent(2, 'b', 'Alice → Hub');

    expect(activityForStep([foreign, mine], step(2)).map((event) => event.id)).toEqual(['b']);
    expect(captionForStep(step(2), [foreign, mine]).title).toBe('Alice → Hub');
  });
});
