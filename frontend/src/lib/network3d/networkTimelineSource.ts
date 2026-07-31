/**
 * One source of network history, two implementations.
 *
 * The graph must not care whether it is watching a live runtime or a recorded demo, so
 * both go through this interface:
 *
 *   - `adapterNetworkTimelineSource` reads a RuntimeAdapter. The embedded (browser) adapter
 *     and the remote adapter expose the same read paths, so a local runtime is no longer a
 *     special case — this is what previously read the always-empty `env.history`.
 *   - `trailNetworkTimelineSource` replays a NetworkTrail captured in the browser. Same
 *     interface, so a recorded scenario and a live hub render through identical code.
 *
 * `recordNetworkTrail` turns the first into the second.
 */

import type {
  EnvSnapshot,
  RuntimeAdapter,
  RuntimeAdapterActivityPage,
  RuntimeAdapterGraphFrame,
  RuntimeAdapterTimelineIndexPage,
  RuntimeActivityEvent,
  RuntimeState,
} from '@xln/runtime/xln-api';
import { resolveRuntimeAdapterRead } from '../../../../runtime/radapter/resolve';
import { buildRuntimeActivityEvents } from '../../../../runtime/api/activity-history';
import { normalizeRuntimeTimelineIndex, type RuntimeTimelineIndex } from './runtimeGraphTimeline';

const INDEX_PAGE_SIZE = 250;
const INDEX_SCAN_LIMIT = 2_000;
const ACTIVITY_PAGE_SIZE = 250;
const ACTIVITY_SCAN_LIMIT = 2_000;
const GRAPH_FRAME_LIMIT = 500;

export type NetworkTimelineSource = {
  readonly runtimeId: string;
  readIndex(): Promise<RuntimeTimelineIndex>;
  readGraphFrame(height: number): Promise<RuntimeAdapterGraphFrame>;
  /** Activity events inside [fromHeight, toHeight], ascending by height then id. */
  readActivity(fromHeight: number, toHeight: number): Promise<RuntimeActivityEvent[]>;
};

/** A frozen network history captured in the browser. Serializable, replayable offline. */
export type NetworkTrail = {
  version: 1;
  runtimeId: string;
  index: RuntimeTimelineIndex;
  frames: Record<string, RuntimeAdapterGraphFrame>;
  activity: RuntimeActivityEvent[];
};

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

const requireHeight = (height: number, label: string): number => {
  const normalized = Math.floor(Number(height));
  if (!Number.isFinite(normalized) || normalized < 1) throw new Error(`${label}:${String(height)}`);
  return normalized;
};

const compareActivity = (left: RuntimeActivityEvent, right: RuntimeActivityEvent): number =>
  left.height - right.height || String(left.id).localeCompare(String(right.id));

export const adapterNetworkTimelineSource = (
  runtimeId: string,
  adapter: Pick<RuntimeAdapter, 'read'>,
): NetworkTimelineSource => {
  const expected = normalizeId(runtimeId);
  if (!expected) throw new Error('NETWORK_TIMELINE_RUNTIME_ID_REQUIRED');

  return {
    runtimeId: expected,

    async readIndex(): Promise<RuntimeTimelineIndex> {
      const entries: RuntimeAdapterTimelineIndexPage['entries'] = [];
      let beforeHeight: number | undefined;
      while (true) {
        const page = await adapter.read<RuntimeAdapterTimelineIndexPage>('timeline-index', {
          limit: INDEX_PAGE_SIZE,
          scanLimit: INDEX_SCAN_LIMIT,
          ...(beforeHeight === undefined ? {} : { beforeHeight }),
        });
        const actual = normalizeId(page.runtimeId);
        if (actual !== expected) throw new Error(`NETWORK_TIMELINE_RUNTIME_ID_MISMATCH:${expected}:${actual}`);
        entries.push(...page.entries);
        if (page.nextBeforeHeight === null) break;
        const next = Math.floor(Number(page.nextBeforeHeight));
        if (!Number.isFinite(next) || next < 2 || (beforeHeight !== undefined && next >= beforeHeight)) {
          throw new Error(`NETWORK_TIMELINE_CURSOR_INVALID:${expected}:${String(page.nextBeforeHeight)}`);
        }
        beforeHeight = next;
      }
      return normalizeRuntimeTimelineIndex({ runtimeId: expected, frames: entries });
    },

    async readGraphFrame(height: number): Promise<RuntimeAdapterGraphFrame> {
      const target = requireHeight(height, 'NETWORK_TIMELINE_FRAME_HEIGHT_INVALID');
      const frame = await adapter.read<RuntimeAdapterGraphFrame>('graph-frame', {
        atHeight: target,
        limit: GRAPH_FRAME_LIMIT,
        accountsLimit: GRAPH_FRAME_LIMIT,
      });
      const actual = normalizeId(frame.runtimeId);
      if (actual !== expected) throw new Error(`NETWORK_GRAPH_RUNTIME_ID_MISMATCH:${expected}:${actual}`);
      if (Math.floor(Number(frame.height || 0)) !== target) {
        throw new Error(`NETWORK_TIMELINE_FRAME_MISMATCH:${expected}:h${target}:h${String(frame.height)}`);
      }
      return frame;
    },

    async readActivity(fromHeight: number, toHeight: number): Promise<RuntimeActivityEvent[]> {
      const from = requireHeight(fromHeight, 'NETWORK_ACTIVITY_FROM_HEIGHT_INVALID');
      const to = requireHeight(toHeight, 'NETWORK_ACTIVITY_TO_HEIGHT_INVALID');
      if (to < from) throw new Error(`NETWORK_ACTIVITY_RANGE_INVALID:${from}:${to}`);
      const collected = new Map<string, RuntimeActivityEvent>();
      // The activity feed pages backwards from a height cursor, so walk down until the
      // window is covered or the runtime runs out of frames.
      let beforeHeight: number | undefined = to + 1;
      while (true) {
        const page = await adapter.read<RuntimeAdapterActivityPage>('activity', {
          limit: ACTIVITY_PAGE_SIZE,
          scanLimit: ACTIVITY_SCAN_LIMIT,
          ...(beforeHeight === undefined ? {} : { beforeHeight }),
        });
        for (const event of page.events ?? []) {
          const height = Math.floor(Number(event.height || 0));
          if (height < from || height > to) continue;
          collected.set(String(event.id), event);
        }
        if (page.nextBeforeHeight === null) break;
        const next = Math.floor(Number(page.nextBeforeHeight));
        if (!Number.isFinite(next) || next < 2 || (beforeHeight !== undefined && next >= beforeHeight)) break;
        if (next <= from) break;
        beforeHeight = next;
      }
      return Array.from(collected.values()).sort(compareActivity);
    },
  };
};

export const trailNetworkTimelineSource = (trail: NetworkTrail): NetworkTimelineSource => {
  if (trail?.version !== 1) throw new Error('NETWORK_TRAIL_VERSION_UNSUPPORTED');
  const runtimeId = normalizeId(trail.runtimeId);
  if (!runtimeId) throw new Error('NETWORK_TIMELINE_RUNTIME_ID_REQUIRED');
  const index = normalizeRuntimeTimelineIndex(trail.index);
  const activity = [...(trail.activity ?? [])].sort(compareActivity);

  return {
    runtimeId,
    readIndex: async () => index,
    readGraphFrame: async (height: number) => {
      const target = requireHeight(height, 'NETWORK_TIMELINE_FRAME_HEIGHT_INVALID');
      const frame = trail.frames[String(target)];
      if (!frame) throw new Error(`NETWORK_TRAIL_FRAME_MISSING:${runtimeId}:h${target}`);
      return frame;
    },
    readActivity: async (fromHeight: number, toHeight: number) => {
      const from = requireHeight(fromHeight, 'NETWORK_ACTIVITY_FROM_HEIGHT_INVALID');
      const to = requireHeight(toHeight, 'NETWORK_ACTIVITY_TO_HEIGHT_INVALID');
      if (to < from) throw new Error(`NETWORK_ACTIVITY_RANGE_INVALID:${from}:${to}`);
      return activity.filter((event) => {
        const height = Math.floor(Number(event.height || 0));
        return height >= from && height <= to;
      });
    },
  };
};

/** A frame changed the graph when it actually carried work, not just a heartbeat tick. */
const snapshotChangedGraph = (snapshot: EnvSnapshot): boolean => {
  const input = snapshot.runtimeInput;
  if ((input?.runtimeTxs?.length ?? 0) > 0 || (input?.jInputs?.length ?? 0) > 0) return true;
  return (input?.entityInputs ?? []).some((entry) => (entry.entityTxs?.length ?? 0) > 0);
};

/**
 * A scenario executed in the browser, exposed as a network source.
 *
 * Frames are projected by the runtime's own graph projector over each snapshot (a live
 * projection reads `ctx.env` only, so no storage is involved), and captions come from the
 * same `buildRuntimeActivityEvents` the live adapter uses. A scenario demo and a production
 * hub therefore render through identical code — and can be frozen with `recordNetworkTrail`.
 */
export const scenarioNetworkTimelineSource = (
  runtimeId: string,
  snapshots: readonly EnvSnapshot[],
): NetworkTimelineSource => {
  const expected = normalizeId(runtimeId);
  if (!expected) throw new Error('NETWORK_TIMELINE_RUNTIME_ID_REQUIRED');
  const byHeight = new Map<number, EnvSnapshot>();
  for (const snapshot of snapshots) {
    const height = Math.floor(Number(snapshot.height || 0));
    if (height >= 1) byHeight.set(height, snapshot);
  }

  const snapshotAt = (height: number): EnvSnapshot => {
    const snapshot = byHeight.get(height);
    if (!snapshot) throw new Error(`NETWORK_SCENARIO_FRAME_MISSING:${expected}:h${height}`);
    return snapshot;
  };

  return {
    runtimeId: expected,

    readIndex: async () => normalizeRuntimeTimelineIndex({
      runtimeId: expected,
      frames: Array.from(byHeight.values()).map((snapshot) => ({
        runtimeId: expected,
        height: Math.floor(Number(snapshot.height || 0)),
        timestamp: Math.floor(Number(snapshot.timestamp || 0)),
        stateHash: String((snapshot as EnvSnapshot & { stateHash?: string }).stateHash || ''),
        materialized: true,
        graphChanged: snapshotChangedGraph(snapshot),
      })),
    }),

    readGraphFrame: async (height: number) => {
      const target = requireHeight(height, 'NETWORK_TIMELINE_FRAME_HEIGHT_INVALID');
      const snapshot = snapshotAt(target);
      // No `atHeight`: the projector treats this as a live read of the supplied env, which
      // is exactly what a snapshot is. Omitting it keeps storage out of the path.
      const frame = await resolveRuntimeAdapterRead<RuntimeAdapterGraphFrame>(
        { env: snapshot as unknown as RuntimeState },
        'graph-frame',
        { limit: GRAPH_FRAME_LIMIT, accountsLimit: GRAPH_FRAME_LIMIT },
      );
      return { ...frame, runtimeId: expected, height: target };
    },

    readActivity: async (fromHeight: number, toHeight: number) => {
      const from = requireHeight(fromHeight, 'NETWORK_ACTIVITY_FROM_HEIGHT_INVALID');
      const to = requireHeight(toHeight, 'NETWORK_ACTIVITY_TO_HEIGHT_INVALID');
      if (to < from) throw new Error(`NETWORK_ACTIVITY_RANGE_INVALID:${from}:${to}`);
      const events: RuntimeActivityEvent[] = [];
      for (const [height, snapshot] of byHeight) {
        if (height < from || height > to) continue;
        events.push(...buildRuntimeActivityEvents({
          height,
          timestamp: Math.floor(Number(snapshot.timestamp || 0)),
          ...(snapshot.runtimeInput ? { runtimeInput: snapshot.runtimeInput } : {}),
        }).map((event) => ({ ...event, runtimeId: expected })));
      }
      return events.sort(compareActivity);
    },
  };
};

/** Drain a live source into a replayable trail. This is how a browser demo is captured. */
export const recordNetworkTrail = async (source: NetworkTimelineSource): Promise<NetworkTrail> => {
  const index = await source.readIndex();
  const frames: Record<string, RuntimeAdapterGraphFrame> = {};
  for (const frame of index.frames) {
    frames[String(frame.height)] = await source.readGraphFrame(frame.height);
  }
  const heights = index.frames.map((frame) => frame.height);
  const activity = heights.length === 0
    ? []
    : await source.readActivity(Math.min(...heights), Math.max(...heights));
  return { version: 1, runtimeId: source.runtimeId, index, frames, activity };
};
