/**
 * Record a scenario into a portable trail.
 *
 *   bun runtime/scripts/record-demo-trail.ts ahb
 *   bun runtime/scripts/record-demo-trail.ts --all
 *
 * Writes `frontend/static/trails/<key>.json`, which `/embed?trail=<key>` replays with no
 * runtime, no EVM and no wait. Running the scenario in the browser takes minutes; replaying
 * a trail is instant, which is the difference between a demo and a loading screen.
 *
 * A scenario that fails still produces a trail of everything before the failure, and the
 * failure is recorded in the file. Partial demos are useful; silent ones are not.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEmptyEnv, recordScenario, scenarioKeys, type ScenarioKey } from '../runtime';
import { serializeTaggedJson } from '../protocol/serialization';
import { buildRuntimeActivityEvents } from '../api/activity-history';
import type { EnvSnapshot } from '../types';

const OUTPUT_DIR = path.join(process.cwd(), 'frontend/static/trails');

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();
const integer = (value: unknown): number => {
  const parsed = Math.floor(Number(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * A step worth stopping on.
 *
 * Counting any transaction marks almost every frame as interesting, because consensus
 * bookkeeping is transactions too — the demo then scrubs through 110 identical
 * "consensusOutput" frames. A story beat is an activity event that moved value or changed
 * the account structure, which is exactly what is not classified as `system`.
 */
const isStoryBeat = (events: Array<{ type: string }>): boolean =>
  events.some(event => event.type !== 'system');

/**
 * Frame shape mirrors the runtime's own graph projection so a recorded demo and a live hub
 * drive the same renderer. `deltas` and `reserves` are what the capacity bars are made of.
 */
const graphFrame = (runtimeId: string, snapshot: EnvSnapshot): Record<string, unknown> => {
  const height = integer(snapshot.height);
  const profiles = new Map(
    (snapshot.gossip?.profiles ?? []).map(profile => [normalizeId(profile.entityId), profile]),
  );
  const entities = Array.from(snapshot.eReplicas?.values?.() ?? []).map(replica => {
    const entityId = normalizeId(replica.entityId);
    const state = replica.state as unknown as {
      reserves?: Map<number, bigint>;
      profile?: { name?: string; isHub?: boolean };
      accounts?: Map<string, Record<string, unknown>>;
    };
    const label = String(profiles.get(entityId)?.name || state?.profile?.name || entityId);
    const accounts = Array.from(state?.accounts?.entries?.() ?? []).map(([counterpartyId, account]) => {
      const other = normalizeId(counterpartyId);
      const [leftEntity, rightEntity] = entityId < other ? [entityId, other] : [other, entityId];
      const mempool = Array.isArray(account['mempool']) ? account['mempool'] : [];
      const dispute = account['activeDispute'] as
        | { startedByLeft?: boolean; disputeTimeout?: number; initialNonce?: number }
        | undefined;
      return {
        leftEntity: normalizeId(account['leftEntity']) || leftEntity,
        rightEntity: normalizeId(account['rightEntity']) || rightEntity,
        status: account['status'] ?? 'open',
        mempool,
        mempoolCount: mempool.length,
        ...(account['currentFrame'] ? { currentFrame: account['currentFrame'] } : {}),
        ...(account['pendingFrame'] ? { pendingFrame: account['pendingFrame'] } : {}),
        deltas: account['deltas'] instanceof Map ? new Map(account['deltas']) : new Map(),
        currentHeight: integer(account['currentHeight']),
        rollbackCount: integer(account['rollbackCount']),
        ...(dispute ? {
          activeDispute: {
            startedByLeft: dispute.startedByLeft === true,
            disputeTimeout: integer(dispute.disputeTimeout),
            initialDisputeNonce: integer(dispute.initialNonce),
          },
        } : {}),
      };
    });
    return {
      summary: { entityId, runtimeId, label, height, isHub: state?.profile?.isHub === true },
      core: {
        entityId,
        signerId: String(replica.signerId || ''),
        height,
        timestamp: integer(snapshot.timestamp),
        reserves: state?.reserves instanceof Map ? new Map(state.reserves) : new Map(),
        profile: { name: label, isHub: state?.profile?.isHub === true },
      },
      accounts: { items: accounts, nextCursor: null },
    };
  }).sort((left, right) => left.summary.entityId.localeCompare(right.summary.entityId));

  return {
    runtimeId,
    height,
    timestamp: integer(snapshot.timestamp),
    stateHash: String((snapshot as EnvSnapshot & { stateHash?: string }).stateHash || ''),
    entities,
  };
};

const recordTrail = async (key: ScenarioKey): Promise<{ frames: number; failure: string | null }> => {
  const runtimeId = `scenario:${key}`;
  const recording = await recordScenario(key, createEmptyEnv());
  const frames: Record<string, unknown> = {};
  const activity = [];
  const beats = new Map<number, boolean>();
  for (const snapshot of recording.frames) {
    const height = integer(snapshot.height);
    if (height < 1) continue;
    frames[String(height)] = graphFrame(runtimeId, snapshot);
    const events = buildRuntimeActivityEvents({
      height,
      timestamp: integer(snapshot.timestamp),
      ...(snapshot.runtimeInput ? { runtimeInput: snapshot.runtimeInput } : {}),
    });
    beats.set(height, isStoryBeat(events));
    activity.push(...events.map(event => ({ ...event, runtimeId })));
  }

  const trail = {
    version: 1 as const,
    runtimeId,
    index: {
      runtimeId,
      frames: recording.frames
        .filter(snapshot => integer(snapshot.height) >= 1)
        .map(snapshot => ({
          runtimeId,
          height: integer(snapshot.height),
          timestamp: integer(snapshot.timestamp),
          stateHash: String((snapshot as EnvSnapshot & { stateHash?: string }).stateHash || ''),
          materialized: true,
          graphChanged: beats.get(integer(snapshot.height)) === true,
        })),
    },
    frames,
    activity,
    ...(recording.failure ? { failure: recording.failure } : {}),
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${key}.json`);
  await writeFile(file, serializeTaggedJson(trail), 'utf8');
  return { frames: recording.frames.length, failure: recording.failure };
};

const requested = process.argv.slice(2).filter(argument => !argument.startsWith('-'));
const all = process.argv.includes('--all');
const targets = (all ? scenarioKeys : requested) as ScenarioKey[];

if (targets.length === 0) {
  console.error(`usage: bun runtime/scripts/record-demo-trail.ts <scenario|--all>\nknown: ${scenarioKeys.join(', ')}`);
  process.exit(1);
}

let failed = 0;
for (const key of targets) {
  if (!scenarioKeys.includes(key)) {
    console.error(`✗ ${key}: unknown scenario`);
    failed += 1;
    continue;
  }
  try {
    const result = await recordTrail(key);
    if (result.failure) {
      failed += 1;
      console.error(`⚠ ${key}: ${result.frames} frames, then failed — ${result.failure}`);
      continue;
    }
    console.log(`✓ ${key}: ${result.frames} frames`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// A partial trail is still written; a non-zero exit keeps CI honest about it.
process.exit(failed > 0 ? 1 : 0);
