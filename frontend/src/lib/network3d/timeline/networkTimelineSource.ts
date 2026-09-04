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
} from '@xln/core/api/public/runtime-module';
import {
  networkTrailFromSnapshots,
} from '../../../../../core/scenarios/network-trail';
import { deserializeTaggedJson, serializeTaggedJson } from '@xln/core/protocol/serialization';
import { normalizeRuntimeTimelineIndex, type RuntimeTimelineIndex } from './runtimeGraphTimeline';
import { isUnknownRecord, rejectExtraKeys } from '$lib/utils/boundary';
import { decodeNetworkMachineCue, type NetworkMachineCue } from '../networkMachine';

const INDEX_PAGE_SIZE = 250;
const INDEX_SCAN_LIMIT = 2_000;
const ACTIVITY_PAGE_SIZE = 250;
const ACTIVITY_SCAN_LIMIT = 2_000;
const GRAPH_FRAME_LIMIT = 500;

export type NetworkTimelineSource = {
  readonly runtimeId: string;
  readonly cues?: NetworkMachineCue[];
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
  /** Optional because previously exported v1 trails did not carry authored narration. */
  cues?: NetworkMachineCue[];
};

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

const requireHeight = (height: number, label: string): number => {
  const normalized = Math.floor(Number(height));
  if (!Number.isFinite(normalized) || normalized < 1) throw new Error(`${label}:${String(height)}`);
  return normalized;
};

const compareActivity = (left: RuntimeActivityEvent, right: RuntimeActivityEvent): number =>
  left.height - right.height || String(left.id).localeCompare(String(right.id));

const isRuntimeAdapterGraphFrame = (value: unknown, runtimeId: string, height: number): value is RuntimeAdapterGraphFrame =>
  isUnknownRecord(value) && typeof value['runtimeId'] === 'string' && normalizeId(value['runtimeId']) === runtimeId &&
  typeof value['height'] === 'number' && Number.isFinite(value['height']) && Math.floor(value['height']) === height &&
  (value['timestamp'] === undefined || (typeof value['timestamp'] === 'number' && Number.isFinite(value['timestamp']))) &&
  (value['stateHash'] === undefined || typeof value['stateHash'] === 'string') &&
  (value['head'] === undefined || isUnknownRecord(value['head'])) && Array.isArray(value['entities']);

const isRuntimeActivityEvent = (value: unknown): value is RuntimeActivityEvent =>
  isUnknownRecord(value) && typeof value['id'] === 'string' && typeof value['height'] === 'number' && Number.isFinite(value['height']) &&
  typeof value['timestamp'] === 'number' && Number.isFinite(value['timestamp']) && typeof value['kind'] === 'string' &&
  typeof value['type'] === 'string' && typeof value['source'] === 'string' && typeof value['direction'] === 'string' &&
  typeof value['title'] === 'string' && typeof value['subtitle'] === 'string' && typeof value['status'] === 'string' && typeof value['rawType'] === 'string';

const decodeRuntimeTimelineIndex = (value: unknown): RuntimeTimelineIndex => {
  if (!isUnknownRecord(value)) throw new Error('NETWORK_TRAIL_INDEX_INVALID');
  rejectExtraKeys(value, ['runtimeId', 'frames'], 'NETWORK_TRAIL_INDEX_EXTRA_FIELD');
  if (typeof value['runtimeId'] !== 'string' || !Array.isArray(value['frames'])) throw new Error('NETWORK_TRAIL_INDEX_FIELD_INVALID');
  return {
    runtimeId: value['runtimeId'],
    frames: value['frames'].map((frame, index) => {
      if (!isUnknownRecord(frame)) throw new Error(`NETWORK_TRAIL_INDEX_FRAME_INVALID:${index}`);
      rejectExtraKeys(frame, ['runtimeId', 'height', 'timestamp', 'stateHash', 'materialized', 'graphChanged'], `NETWORK_TRAIL_INDEX_FRAME_EXTRA_FIELD:${index}`);
      if (typeof frame['runtimeId'] !== 'string' || typeof frame['height'] !== 'number' || !Number.isFinite(frame['height']) ||
        typeof frame['timestamp'] !== 'number' || !Number.isFinite(frame['timestamp']) || typeof frame['stateHash'] !== 'string' ||
        typeof frame['materialized'] !== 'boolean' || (frame['graphChanged'] !== undefined && typeof frame['graphChanged'] !== 'boolean')) {
        throw new Error(`NETWORK_TRAIL_INDEX_FRAME_FIELD_INVALID:${index}`);
      }
      return {
        runtimeId: frame['runtimeId'], height: frame['height'], timestamp: frame['timestamp'], stateHash: frame['stateHash'], materialized: frame['materialized'],
        ...(frame['graphChanged'] === undefined ? {} : { graphChanged: frame['graphChanged'] }),
      };
    }),
  };
};

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
    cues: trail.cues ?? [],
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
  const source = trailNetworkTimelineSource(networkTrailFromSnapshots(runtimeId, snapshots) as NetworkTrail);
  return {
    ...source,
    readGraphFrame: async (height: number) => {
      try {
        return await source.readGraphFrame(height);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('NETWORK_TRAIL_FRAME_MISSING:')) {
          throw new Error(`NETWORK_SCENARIO_FRAME_MISSING:${source.runtimeId}:h${height}`);
        }
        throw error;
      }
    },
  };
};

/**
 * Trails are portable: a recorded scenario is data, not a running system.
 *
 * Graph frames carry bigints and Maps (deltas are the whole point), so plain JSON cannot
 * hold them. The tagged codec below is the same one the browser wire path uses, which keeps
 * an exported trail byte-compatible with what a live adapter would have sent.
 */
export const serializeNetworkTrail = (trail: NetworkTrail): string => {
  if (trail?.version !== 1) throw new Error('NETWORK_TRAIL_VERSION_UNSUPPORTED');
  return serializeTaggedJson(trail);
};

export const parseNetworkTrail = (text: string): NetworkTrail => {
  const parsed = deserializeTaggedJson(String(text || ''));
  if (!isUnknownRecord(parsed)) throw new Error('NETWORK_TRAIL_PAYLOAD_INVALID');
  rejectExtraKeys(parsed, ['version', 'runtimeId', 'index', 'frames', 'activity', 'cues'], 'NETWORK_TRAIL_EXTRA_FIELD');
  if (parsed['version'] !== 1) throw new Error('NETWORK_TRAIL_VERSION_UNSUPPORTED');
  if (typeof parsed['runtimeId'] !== 'string' || !normalizeId(parsed['runtimeId'])) throw new Error('NETWORK_TIMELINE_RUNTIME_ID_REQUIRED');
  if (!isUnknownRecord(parsed['index']) || !isUnknownRecord(parsed['frames']) || !Array.isArray(parsed['activity']) ||
    (parsed['cues'] !== undefined && !Array.isArray(parsed['cues']))) {
    throw new Error('NETWORK_TRAIL_STRUCTURE_INVALID');
  }
  // The graph index/frame/activity projections are already canonical runtime adapter
  // values at capture time. Revalidate their shared runtime and frame index before use.
  const index = normalizeRuntimeTimelineIndex(decodeRuntimeTimelineIndex(parsed['index']));
  if (normalizeId(index.runtimeId) !== normalizeId(parsed['runtimeId'])) throw new Error('NETWORK_TRAIL_RUNTIME_MISMATCH');
  const frames: Record<string, RuntimeAdapterGraphFrame> = {};
  const runtimeId = normalizeId(parsed['runtimeId']);
  for (const [height, frame] of Object.entries(parsed['frames'])) {
    if (!/^\d+$/.test(height) || !isRuntimeAdapterGraphFrame(frame, runtimeId, Number(height))) {
      throw new Error(`NETWORK_TRAIL_FRAME_INVALID:${height}`);
    }
    frames[height] = frame;
  }
  const activity: RuntimeActivityEvent[] = [];
  for (const event of parsed['activity']) {
    if (!isRuntimeActivityEvent(event)) {
      throw new Error('NETWORK_TRAIL_ACTIVITY_INVALID');
    }
    activity.push(event);
  }
  const cues = parsed['cues']?.map(decodeNetworkMachineCue);
  return { version: 1, runtimeId: parsed['runtimeId'], index, frames, activity, ...(cues ? { cues } : {}) };
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const gzip = async (text: string): Promise<Uint8Array> => {
  const stream = new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')));
  return new Uint8Array(await stream.arrayBuffer());
};

const gunzip = async (bytes: Uint8Array): Promise<string> => {
  const buffer = bytes.slice().buffer as ArrayBuffer;
  const stream = new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')));
  return await stream.text();
};

/** Compressed, URL-safe trail for `#trail=` — the hash never reaches a server. */
export const encodeNetworkTrailForHash = async (trail: NetworkTrail): Promise<string> =>
  toBase64Url(await gzip(serializeNetworkTrail(trail)));

export const decodeNetworkTrailFromHash = async (encoded: string): Promise<NetworkTrail> =>
  parseNetworkTrail(await gunzip(fromBase64Url(String(encoded || '').trim())));

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
  return { version: 1, runtimeId: source.runtimeId, index, frames, activity, cues: source.cues ?? [] };
};
