/**
 * Sovereign load-user Runtimes.
 *
 * Every user owns a unique RuntimeReplica, runtimeId, signer scope, WAL,
 * queues and P2P relay session. Several replicas may share one Bun process and
 * listener; no Runtime, Entity, Account or transport state is shared.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deriveRuntimeAdapterCapabilityToken } from '../../../../api/runtime-adapter/security/auth';
import type { ManagedEntityIdentity } from '../../../../orchestrator/daemon-control';
import {
  spawnBunChild,
  stopManagedChild,
  waitForHttpReady,
  type ManagedChild,
} from '../../../../orchestrator/bootstrap/custody-bootstrap';
import {
  deserializeTaggedJson,
  safeStringify,
  serializeTaggedJson,
} from '../../../../protocol/serialization';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';
import type { RuntimeInput } from '../../../../runtime/types';
import { parseProfile, type Profile } from '../../../../entity/profile';
import { toEntityId } from '../../../../protocol/identity';
import type {
  AccountDeliveryHop,
  HltPaymentOperationLedgerSnapshot,
  HltPaymentOperationLedgerStage,
} from '../../../../support/performance/account-delivery-trace';
import {
  assertSocketCounterCoverage,
  summarizeHltIoCounters,
  type HltOpCounter,
  connectRuntime,
  decodeHltOpCounterSnapshot,
  type ConnectedRuntime,
} from '../worker-runtime';
import {
  encodeSovereignRuntimeSeeds,
  SOVEREIGN_RUNTIMES_PER_WORKER,
  sovereignRuntimeWorkerStart,
} from './sovereign-runtime-sharding';

export type LaneRuntimeHostIngress = Readonly<{
  authKey: string;
  baseUrl: string;
  id: string;
  sequence: { nextWave: number };
}>;

export type LaneRuntime = Readonly<{
  identity: ManagedEntityIdentity;
  laneKey: string;
  port: number;
  child: ManagedChild;
  runtime: ConnectedRuntime | null;
  runtimeId: string;
  relayUrl: string;
  hostIngress: LaneRuntimeHostIngress;
  /** A sovereign user Runtime owns exactly one user Entity. */
  hostedEntityIds: readonly [string];
}>;

export type LaneRuntimeInputSubmission = Readonly<{
  input: RuntimeInput;
  lane: LaneRuntime;
}>;

const postHostRuntimeInputBatch = async (
  host: LaneRuntimeHostIngress,
  wave: number,
  entries: ReadonlyArray<Readonly<{ runtimeId: string; input: RuntimeInput }>>,
  waitForCommit: boolean,
): Promise<void> => {
  const payload = { wave, entries, waitForCommit };
  const body = serializeTaggedJson(payload);
  const controller = new AbortController();
  // An open-loop command submitted near second 20 may receive its process-local
  // queue ACK during the separately authorized drain. Thirty seconds is still
  // the global hard ceiling; committed Account completion remains the result.
  const timer = setTimeout(() => controller.abort(`HLT host batch timed out: ${host.id}:${wave}`), 30_000);
  try {
    const response = await fetch(`${host.baseUrl}/api/hlt/runtime-input-batch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${host.authKey}`,
        'content-type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
    const raw = await response.text();
    const decoded = requireBoundaryRecord(
      raw.trim() ? deserializeTaggedJson(raw) : {},
      'HLT_HOST_RUNTIME_INPUT_BATCH_RESPONSE_INVALID',
    );
    if (!response.ok) {
      throw new Error(
        `HLT_HOST_RUNTIME_INPUT_BATCH_REJECTED:status=${response.status}:body=${safeStringify(decoded)}`,
      );
    }
    requireExactBoundaryKeys(
      decoded,
      ['ok', 'wave', 'accepted'],
      [],
      'HLT_HOST_RUNTIME_INPUT_BATCH_RESPONSE_FIELDS_INVALID',
    );
    const accepted = requireBoundaryInteger(
      decoded['accepted'],
      'HLT_HOST_RUNTIME_INPUT_BATCH_RESPONSE_ACCEPTED_INVALID',
    );
    const acceptedWave = requireBoundaryInteger(
      decoded['wave'],
      'HLT_HOST_RUNTIME_INPUT_BATCH_RESPONSE_WAVE_INVALID',
    );
    if (decoded['ok'] !== true || acceptedWave !== wave || accepted !== entries.length) {
      throw new Error(
        `HLT_HOST_RUNTIME_INPUT_BATCH_RESPONSE_MISMATCH:${safeStringify(decoded)}`,
      );
    }
  } catch (error) {
    // Never retry an ambiguous queue admission. The HLT stops with the exact
    // host and wave; a fresh run starts from a fresh Runtime/WAL. Dumping the
    // complete population payload hid the actual cause behind megabytes of
    // diagnostics and could itself exhaust the parent control channel.
    throw new Error(
      `HLT_HOST_RUNTIME_INPUT_BATCH_TRANSPORT_FAILED:host=${host.id}:wave=${wave}:` +
      `entries=${entries.length}:bytes=${Buffer.byteLength(body)}:` +
      `cause=${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
};

/** Bound setup work per event-loop turn; each chunk returns after commit. */
export const HLT_SETUP_RUNTIME_INPUT_CHUNK_ENTRIES = 10;

export const requireConnectedLaneRuntime = (lane: LaneRuntime): ConnectedRuntime => {
  if (!lane.runtime) throw new Error(`HLT_LANE_CONTROL_NOT_CONNECTED:${lane.laneKey}`);
  return lane.runtime;
};

/** One authenticated transport write per OS host; every target Runtime stays sovereign. */
export const queueLaneRuntimeInputWave = async (
  wave: number,
  submissions: readonly LaneRuntimeInputSubmission[],
  options: Readonly<{
    maxEntriesPerHostRequest?: number;
    waitForCommit?: boolean;
  }> = {},
): Promise<void> => {
  if (!Number.isSafeInteger(wave) || wave < 0) throw new Error(`HLT_RUNTIME_INPUT_WAVE_INVALID:${wave}`);
  if (submissions.length < 1) throw new Error('HLT_RUNTIME_INPUT_WAVE_EMPTY');
  const seenRuntimeIds = new Set<string>();
  const groups = new Map<string, {
    host: LaneRuntimeHostIngress;
    entries: Array<Readonly<{ runtimeId: string; input: RuntimeInput }>>;
  }>();
  for (const { lane, input } of submissions) {
    if (seenRuntimeIds.has(lane.runtimeId)) {
      throw new Error(`HLT_RUNTIME_INPUT_WAVE_RUNTIME_DUPLICATE:${lane.runtimeId}`);
    }
    seenRuntimeIds.add(lane.runtimeId);
    const group = groups.get(lane.hostIngress.id) ?? { host: lane.hostIngress, entries: [] };
    group.entries.push({ runtimeId: lane.runtimeId, input });
    groups.set(lane.hostIngress.id, group);
  }
  const maxEntries = options.maxEntriesPerHostRequest ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`HLT_RUNTIME_INPUT_CHUNK_ENTRIES_INVALID:${String(maxEntries)}`);
  }
  await Promise.all([...groups.values()].map(async group => {
    // Sequence is host-local because a fresh sovereign host starts at wave 0.
    // Allocate the complete chunk block synchronously before the first I/O,
    // so concurrent open-loop callers cannot interleave later logical waves.
    const chunks = Array.from(
      { length: Math.ceil(group.entries.length / maxEntries) },
      (_, index) => ({
        entries: group.entries.slice(
          index * maxEntries,
          (index + 1) * maxEntries,
        ),
        wave: group.host.sequence.nextWave + index,
      }),
    );
    group.host.sequence.nextWave += chunks.length;
    for (const chunk of chunks) {
      await postHostRuntimeInputBatch(
        group.host,
        chunk.wave,
        chunk.entries,
        options.waitForCommit === true,
      );
    }
  }));
};

/** Enable the production Jurisdiction watcher for one sovereign Runtime. */
export const startLaneJurisdictionWatcher = async (lane: LaneRuntime): Promise<void> => {
  const response = await fetch(`${lane.hostIngress.baseUrl}/api/hlt/jurisdiction-watcher-start`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${lane.hostIngress.authKey}`,
      'content-type': 'application/json',
    },
    body: serializeTaggedJson({ runtimeId: lane.runtimeId }),
  });
  const payload = requireBoundaryRecord(
    deserializeTaggedJson(await response.text()),
    'HLT_LANE_JURISDICTION_WATCHER_RESPONSE_INVALID',
  );
  if (!response.ok || payload['ok'] !== true) {
    throw new Error(
      `HLT_LANE_JURISDICTION_WATCHER_REJECTED:${response.status}:` +
      `${String(payload['error'] ?? 'unknown')}`,
    );
  }
};

/** Read diagnostic Account rows already produced by the bounded host scan. */
export const readLaneAccountDetails = async (
  lane: LaneRuntime,
  hubRuntimeId: string,
): Promise<readonly unknown[]> => {
  const response = await fetch(`${lane.hostIngress.baseUrl}/api/hlt/quiescence`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${lane.hostIngress.authKey}`,
      'content-type': 'application/json',
    },
    body: serializeTaggedJson({ hubRuntimeId, runtimeIds: [lane.runtimeId] }),
  });
  const payload = requireBoundaryRecord(
    deserializeTaggedJson(await response.text()),
    'HLT_LANE_ACCOUNT_DETAILS_RESPONSE_INVALID',
  );
  if (!response.ok || payload['ok'] !== true) {
    throw new Error(`HLT_LANE_ACCOUNT_DETAILS_REJECTED:${response.status}`);
  }
  const details = payload['details'];
  if (details === undefined) return [];
  if (!Array.isArray(details)) throw new Error('HLT_LANE_ACCOUNT_DETAILS_INVALID');
  return details;
};

/** Commit the imported user Entity and configure every sovereign Runtime with
 * one authenticated request per OS host, not two HTTP requests per user. */
export const configureLanePopulationP2P = async (
  lanes: readonly LaneRuntime[],
  options: Readonly<{ announceProfiles?: boolean }> = {},
): Promise<void> => {
  if (lanes.length < 1) throw new Error('HLT_LANE_POPULATION_CONFIGURE_EMPTY');
  const groups = new Map<string, {
    host: LaneRuntimeHostIngress;
    targets: Array<Readonly<{ runtimeId: string; entityId: string }>>;
  }>();
  for (const lane of lanes) {
    const group = groups.get(lane.hostIngress.id) ?? {
      host: lane.hostIngress,
      targets: [],
    };
    group.targets.push({ runtimeId: lane.runtimeId, entityId: lane.identity.entityId });
    groups.set(lane.hostIngress.id, group);
  }
  await Promise.all([...groups.values()].map(async group => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(`HLT population configure timed out: ${group.host.id}`), 20_000);
    try {
      const response = await fetch(`${group.host.baseUrl}/api/hlt/population-configure`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${group.host.authKey}`,
          'content-type': 'application/json',
        },
        body: serializeTaggedJson({
          targets: group.targets,
          announceProfiles: options.announceProfiles ?? true,
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      const decoded = requireBoundaryRecord(
        raw.trim() ? deserializeTaggedJson(raw) : {},
        'HLT_HOST_POPULATION_CONFIGURE_RESPONSE_INVALID',
      );
      if (!response.ok) {
        throw new Error(
          `HLT_HOST_POPULATION_CONFIGURE_REJECTED:host=${group.host.id}:status=${response.status}:` +
          `body=${safeStringify(decoded)}`,
        );
      }
      requireExactBoundaryKeys(
        decoded,
        ['ok', 'configured'],
        [],
        'HLT_HOST_POPULATION_CONFIGURE_RESPONSE_FIELDS_INVALID',
      );
      const configured = requireBoundaryInteger(
        decoded['configured'],
        'HLT_HOST_POPULATION_CONFIGURE_RESPONSE_COUNT_INVALID',
      );
      if (decoded['ok'] !== true || configured !== group.targets.length) {
        throw new Error(
          `HLT_HOST_POPULATION_CONFIGURE_RESPONSE_MISMATCH:host=${group.host.id}:` +
          `expected=${group.targets.length}:actual=${safeStringify(decoded)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }));
};

/** Planned Hub replacement must not look like an unexpected financial-socket
 * failure. Drain and detach every user P2P client before the old Hub exits;
 * configureLanePopulationP2P later creates fresh authenticated clients. */
export const stopLanePopulationP2P = async (
  lanes: readonly LaneRuntime[],
): Promise<void> => {
  if (lanes.length < 1) throw new Error('HLT_LANE_POPULATION_P2P_STOP_EMPTY');
  const groups = new Map<string, {
    host: LaneRuntimeHostIngress;
    runtimeIds: string[];
  }>();
  for (const lane of lanes) {
    const group = groups.get(lane.hostIngress.id) ?? {
      host: lane.hostIngress,
      runtimeIds: [],
    };
    group.runtimeIds.push(lane.runtimeId);
    groups.set(lane.hostIngress.id, group);
  }
  await Promise.all([...groups.values()].map(async group => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(`HLT population P2P stop timed out: ${group.host.id}`), 5_000);
    try {
      const response = await fetch(`${group.host.baseUrl}/api/hlt/population-p2p-stop`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${group.host.authKey}`,
          'content-type': 'application/json',
        },
        body: serializeTaggedJson({ runtimeIds: group.runtimeIds }),
        signal: controller.signal,
      });
      const raw = await response.text();
      const decoded = requireBoundaryRecord(
        raw.trim() ? deserializeTaggedJson(raw) : {},
        'HLT_HOST_POPULATION_P2P_STOP_RESPONSE_INVALID',
      );
      if (!response.ok) {
        throw new Error(
          `HLT_HOST_POPULATION_P2P_STOP_REJECTED:host=${group.host.id}:status=${response.status}:` +
          `body=${safeStringify(decoded)}`,
        );
      }
      requireExactBoundaryKeys(
        decoded,
        ['ok', 'stopped'],
        [],
        'HLT_HOST_POPULATION_P2P_STOP_RESPONSE_FIELDS_INVALID',
      );
      const stopped = requireBoundaryInteger(
        decoded['stopped'],
        'HLT_HOST_POPULATION_P2P_STOP_RESPONSE_COUNT_INVALID',
      );
      if (decoded['ok'] !== true || stopped !== group.runtimeIds.length) {
        throw new Error(
          `HLT_HOST_POPULATION_P2P_STOP_RESPONSE_MISMATCH:host=${group.host.id}:` +
          `expected=${group.runtimeIds.length}:actual=${safeStringify(decoded)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }));
};

export const readLaneRouteReadiness = async (
  lanes: readonly LaneRuntime[],
  hubEntityId: string,
  receiverIdsByLane: readonly (readonly string[])[],
): Promise<string[]> => {
  if (lanes.length !== receiverIdsByLane.length || lanes.length < 1) {
    throw new Error('HLT_LANE_ROUTE_READINESS_CARDINALITY_INVALID');
  }
  const groups = new Map<string, {
    host: LaneRuntimeHostIngress;
    targets: Array<Readonly<{ runtimeId: string; receiverEntityIds: readonly string[] }>>;
  }>();
  lanes.forEach((lane, index) => {
    const group = groups.get(lane.hostIngress.id) ?? { host: lane.hostIngress, targets: [] };
    group.targets.push({ runtimeId: lane.runtimeId, receiverEntityIds: receiverIdsByLane[index]! });
    groups.set(lane.hostIngress.id, group);
  });
  const entityIdByRuntimeId = new Map(lanes.map(lane => [lane.runtimeId, lane.identity.entityId]));
  const profileRows = await Promise.all([...groups.values()].map(async group => {
    const response = await fetch(`${group.host.baseUrl}/api/hlt/local-profiles`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${group.host.authKey}`,
        'content-type': 'application/json',
      },
      body: serializeTaggedJson({
        targets: group.targets.map(target => ({
          runtimeId: target.runtimeId,
          entityId: entityIdByRuntimeId.get(target.runtimeId),
        })),
      }),
    });
    const decoded = requireBoundaryRecord(
      deserializeTaggedJson(await response.text()),
      'HLT_HOST_LOCAL_PROFILES_RESPONSE_INVALID',
    );
    requireExactBoundaryKeys(decoded, ['ok', 'profiles'], [], 'HLT_HOST_LOCAL_PROFILES_RESPONSE_FIELDS_INVALID');
    if (!response.ok || decoded['ok'] !== true || !Array.isArray(decoded['profiles'])) {
      throw new Error(`HLT_HOST_LOCAL_PROFILES_REJECTED:${group.host.id}:${safeStringify(decoded)}`);
    }
    return decoded['profiles'].map(parseProfile);
  }));
  const profiles = new Map(profileRows.flat().map(profile => [profile.entityId, profile]));
  if (profiles.size !== lanes.length) {
    throw new Error(`HLT_LOCAL_PROFILE_CARDINALITY_INVALID:${profiles.size}:${lanes.length}`);
  }
  const rows = await Promise.all([...groups.values()].map(async group => {
    const requiredProfiles = [...new Set(group.targets.flatMap(target => target.receiverEntityIds).map(toEntityId))]
      .map(entityId => profiles.get(entityId) ?? (() => {
        throw new Error(`HLT_LOCAL_PROFILE_MISSING:${entityId}`);
      })());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(`HLT route readiness timed out: ${group.host.id}`), 20_000);
    try {
      const response = await fetch(`${group.host.baseUrl}/api/hlt/route-readiness`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${group.host.authKey}`,
          'content-type': 'application/json',
        },
        body: serializeTaggedJson({ hubEntityId, targets: group.targets, profiles: requiredProfiles }),
        signal: controller.signal,
      });
      const raw = await response.text();
      const decoded = requireBoundaryRecord(
        raw.trim() ? deserializeTaggedJson(raw) : {},
        'HLT_HOST_ROUTE_READINESS_RESPONSE_INVALID',
      );
      if (!response.ok) {
        throw new Error(`HLT_HOST_ROUTE_READINESS_REJECTED:${group.host.id}:${safeStringify(decoded)}`);
      }
      requireExactBoundaryKeys(decoded, ['ok', 'ready', 'missing'], [], 'HLT_HOST_ROUTE_READINESS_RESPONSE_FIELDS_INVALID');
      if (decoded['ok'] !== true || typeof decoded['ready'] !== 'boolean' || !Array.isArray(decoded['missing'])) {
        throw new Error(`HLT_HOST_ROUTE_READINESS_RESPONSE_INVALID:${group.host.id}`);
      }
      return decoded['missing'].map(value => String(value));
    } finally {
      clearTimeout(timer);
    }
  }));
  return rows.flat();
};

/** Reset optional process counters after setup so reports cover economic work only. */
export const resetLaneHostOpCounters = async (lanes: readonly LaneRuntime[]): Promise<void> => {
  const hosts = new Map(lanes.map(lane => [lane.hostIngress.id, lane.hostIngress]));
  await Promise.all([...hosts.values()].map(async host => {
    const response = await fetch(`${host.baseUrl}/api/hlt/op-counters/reset`, {
      method: 'POST',
      headers: { authorization: `Bearer ${host.authKey}` },
    });
    const raw = await response.text();
    const decoded = requireBoundaryRecord(
      raw.trim() ? deserializeTaggedJson(raw) : {},
      'HLT_HOST_OP_COUNTER_RESET_RESPONSE_INVALID',
    );
    requireExactBoundaryKeys(decoded, ['ok'], [], 'HLT_HOST_OP_COUNTER_RESET_RESPONSE_FIELDS_INVALID');
    if (!response.ok || decoded['ok'] !== true) {
      throw new Error(`HLT_HOST_OP_COUNTER_RESET_FAILED:host=${host.id}:body=${safeStringify(decoded)}`);
    }
  }));
};

export const assertLaneHostSocketCounterCoverage = async (
  lanes: readonly LaneRuntime[],
): Promise<Readonly<Record<string, Readonly<Record<string, HltOpCounter>>>>> => {
  const hosts = new Map(lanes.map(lane => [lane.hostIngress.id, lane.hostIngress]));
  const snapshots = await Promise.all([...hosts.values()].map(async host => {
    const response = await fetch(`${host.baseUrl}/api/hlt/op-counters`, {
      headers: { authorization: `Bearer ${host.authKey}` },
    });
    const raw = await response.text();
    const decoded = raw.trim() ? deserializeTaggedJson(raw) : {};
    if (!response.ok) throw new Error(`HLT_HOST_OP_COUNTER_SNAPSHOT_FAILED:host=${host.id}:status=${response.status}`);
    const counters = decodeHltOpCounterSnapshot(decoded, host.id);
    assertSocketCounterCoverage(counters, host.id);
    return [host.id, { counters, io: summarizeHltIoCounters(counters) }] as const;
  }));
  if (process.env['XLN_RUNTIME_OP_COUNTERS'] === '1') {
    const aggregate = new Map<string, HltOpCounter>();
    for (const [, snapshot] of snapshots) {
      for (const [name, counter] of snapshot.counters) {
        if (![
          'runtime.phase.',
          'entity.phase.',
          'entity.proposal.',
          'entity.accountLeaf.',
          'entity.accountProjection.',
          'entity.collection.',
          'htlc.onion.',
          'runtime.ioYield.',
          'socket.directServer.',
        ].some(prefix => name.startsWith(prefix))) continue;
        const current = aggregate.get(name) ?? { calls: 0, bytes: 0, durationUs: 0 };
        aggregate.set(name, {
          calls: current.calls + counter.calls,
          bytes: current.bytes + counter.bytes,
          durationUs: current.durationUs + counter.durationUs,
        });
      }
    }
    const top = [...aggregate]
      .filter(([, counter]) => counter.calls > 0)
      .sort((left, right) =>
        right[1].durationUs - left[1].durationUs ||
        right[1].calls - left[1].calls ||
        left[0].localeCompare(right[0]))
      .slice(0, 30);
    console.log(`[load] lane-runtime-profile ${safeStringify(Object.fromEntries(top))}`);
  }
  return Object.fromEntries(snapshots.map(([host, snapshot]) => [host, snapshot.io]));
};

const PAYMENT_LEDGER_HOPS = new Set<AccountDeliveryHop>([
  'committed-output', 'p2p-route', 'ws-send-start', 'ws-send-flushed',
  'direct-decoded', 'direct-admitted', 'runtime-mempool',
  'account-apply-start', 'account-apply-done',
]);

const paymentLedgerStrings = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length < 1)) {
    throw new Error(code);
  }
  return value as string[];
};

const decodePaymentLedgerStage = (value: unknown, code: string): HltPaymentOperationLedgerStage => {
  const stage = requireBoundaryRecord(value, code);
  const countFields = [
    'firstAtUnixMs', 'lastAtUnixMs',
    'frameAppearances', 'uniqueFrames', 'repeatedFrames', 'operationAppearances',
    'uniqueOperationEvents', 'repeatedOperationEvents',
  ] as const;
  const arrayFields = ['lockIds', 'lockLegs', 'resolveIds', 'resolveLegs', 'hashlocks'] as const;
  requireExactBoundaryKeys(stage, [...countFields, ...arrayFields, 'outcomes'], [], `${code}:FIELDS`);
  const outcomes = requireBoundaryRecord(stage['outcomes'], `${code}:OUTCOMES`);
  const count = (field: typeof countFields[number]): number =>
    requireBoundaryInteger(stage[field], `${code}:${field}`);
  const strings = (field: typeof arrayFields[number]): string[] =>
    paymentLedgerStrings(stage[field], `${code}:${field}`);
  return {
    firstAtUnixMs: count('firstAtUnixMs'),
    lastAtUnixMs: count('lastAtUnixMs'),
    frameAppearances: count('frameAppearances'),
    uniqueFrames: count('uniqueFrames'),
    repeatedFrames: count('repeatedFrames'),
    operationAppearances: count('operationAppearances'),
    uniqueOperationEvents: count('uniqueOperationEvents'),
    repeatedOperationEvents: count('repeatedOperationEvents'),
    lockIds: strings('lockIds'),
    lockLegs: strings('lockLegs'),
    resolveIds: strings('resolveIds'),
    resolveLegs: strings('resolveLegs'),
    hashlocks: strings('hashlocks'),
    outcomes: Object.fromEntries(Object.entries(outcomes).map(([outcome, count]) => [
      outcome,
      requireBoundaryInteger(count, `${code}:OUTCOME:${outcome}`),
    ])),
  };
};

const decodePaymentLedgerSnapshot = (
  value: unknown,
  label: string,
): HltPaymentOperationLedgerSnapshot => {
  const root = requireBoundaryRecord(value, `HLT_PAYMENT_LEDGER_INVALID:${label}`);
  requireExactBoundaryKeys(root, ['stages', 'swapProposals'], [], `HLT_PAYMENT_LEDGER_FIELDS_INVALID:${label}`);
  const stages = requireBoundaryRecord(root['stages'], `HLT_PAYMENT_LEDGER_STAGES_INVALID:${label}`);
  const swapProposals = requireBoundaryRecord(
    root['swapProposals'],
    `HLT_SWAP_PROPOSAL_LEDGER_INVALID:${label}`,
  );
  requireExactBoundaryKeys(
    swapProposals,
    ['acceptedOfferIds', 'rejectedOfferIds', 'deferredOfferIds', 'rejectionCodes', 'repeatedObservations'],
    [],
    `HLT_SWAP_PROPOSAL_LEDGER_FIELDS_INVALID:${label}`,
  );
  const rejectionCodes = requireBoundaryRecord(
    swapProposals['rejectionCodes'],
    `HLT_SWAP_PROPOSAL_REJECTION_CODES_INVALID:${label}`,
  );
  return {
    stages: Object.fromEntries(Object.entries(stages).map(([hop, stage]) => {
      if (!PAYMENT_LEDGER_HOPS.has(hop as AccountDeliveryHop)) {
        throw new Error(`HLT_PAYMENT_LEDGER_HOP_INVALID:${label}:${hop}`);
      }
      return [hop, decodePaymentLedgerStage(stage, `HLT_PAYMENT_LEDGER_STAGE_INVALID:${label}:${hop}`)];
    })) as Partial<Record<AccountDeliveryHop, HltPaymentOperationLedgerStage>>,
    swapProposals: {
      acceptedOfferIds: paymentLedgerStrings(
        swapProposals['acceptedOfferIds'], `HLT_SWAP_PROPOSAL_ACCEPTED_INVALID:${label}`,
      ),
      rejectedOfferIds: paymentLedgerStrings(
        swapProposals['rejectedOfferIds'], `HLT_SWAP_PROPOSAL_REJECTED_INVALID:${label}`,
      ),
      deferredOfferIds: paymentLedgerStrings(
        swapProposals['deferredOfferIds'], `HLT_SWAP_PROPOSAL_DEFERRED_INVALID:${label}`,
      ),
      rejectionCodes: Object.fromEntries(Object.entries(rejectionCodes).map(([code, count]) => [
        code,
        requireBoundaryInteger(count, `HLT_SWAP_PROPOSAL_REJECTION_CODE_INVALID:${label}:${code}`),
      ])),
      repeatedObservations: requireBoundaryInteger(
        swapProposals['repeatedObservations'], `HLT_SWAP_PROPOSAL_REPEATED_INVALID:${label}`,
      ),
    },
  };
};

export const readLaneHostPaymentOperationLedgers = async (
  lanes: readonly LaneRuntime[],
): Promise<Readonly<Record<string, HltPaymentOperationLedgerSnapshot>>> => {
  const hosts = new Map(lanes.map(lane => [lane.hostIngress.id, lane.hostIngress]));
  const rows = await Promise.all([...hosts.values()].map(async host => {
    const response = await fetch(`${host.baseUrl}/api/hlt/payment-ledger`, {
      headers: { authorization: `Bearer ${host.authKey}` },
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`HLT_PAYMENT_LEDGER_READ_FAILED:${host.id}:${response.status}`);
    return [host.id, decodePaymentLedgerSnapshot(
      raw.trim() ? deserializeTaggedJson(raw) : {},
      host.id,
    )] as const;
  }));
  return Object.fromEntries(rows);
};

const readHostReadiness = async (
  host: LaneRuntimeHostIngress,
  runtimeIds: readonly string[],
  hubEntityId: string,
  hubRuntimeId: string,
  signal?: AbortSignal,
  hubProfile?: Profile,
): Promise<string[]> => {
  const response = await fetch(`${host.baseUrl}/api/hlt/readiness`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.authKey}`,
      'content-type': 'application/json',
    },
    body: serializeTaggedJson({
      hubEntityId,
      hubRuntimeId,
      runtimeIds,
      ...(hubProfile ? { hubProfile } : {}),
    }),
    ...(signal ? { signal } : {}),
  });
  const raw = await response.text();
  const decoded = requireBoundaryRecord(
    raw.trim() ? deserializeTaggedJson(raw) : {},
    'HLT_HOST_READINESS_RESPONSE_INVALID',
  );
  if (!response.ok) {
    throw new Error(`HLT_HOST_READINESS_REJECTED:host=${host.id}:status=${response.status}:body=${safeStringify(decoded)}`);
  }
  requireExactBoundaryKeys(decoded, ['ok', 'ready', 'missing'], [], 'HLT_HOST_READINESS_RESPONSE_FIELDS_INVALID');
  if (decoded['ok'] !== true || typeof decoded['ready'] !== 'boolean' || !Array.isArray(decoded['missing'])) {
    throw new Error(`HLT_HOST_READINESS_RESPONSE_INVALID:host=${host.id}`);
  }
  const missing = decoded['missing'].map(value => String(value).trim().toLowerCase());
  if (missing.some(runtimeId => !/^0x[0-9a-f]{40}$/.test(runtimeId))) {
    throw new Error(`HLT_HOST_READINESS_MISSING_INVALID:host=${host.id}`);
  }
  return missing;
};

/** Five host-wide polls for 1,000 users; no per-port HTTP readiness storm. */
export const waitForLaneHostReadiness = async (
  lanes: readonly LaneRuntime[],
  hubEntityId: string,
  hubRuntimeId: string,
  timeoutMs: number,
  hubProfile?: Profile,
): Promise<void> => {
  const groups = new Map<string, { host: LaneRuntimeHostIngress; runtimeIds: string[] }>();
  for (const lane of lanes) {
    const group = groups.get(lane.hostIngress.id) ?? { host: lane.hostIngress, runtimeIds: [] };
    group.runtimeIds.push(lane.runtimeId);
    groups.set(lane.hostIngress.id, group);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('HLT_HOST_READINESS_TIMEOUT'), timeoutMs);
  try {
    const deadline = Date.now() + timeoutMs;
    let pending = [...groups.values()];
    while (pending.length > 0 && Date.now() < deadline) {
      const results = await Promise.all(pending.map(async group => ({
        host: group.host,
        runtimeIds: await readHostReadiness(
          group.host,
          group.runtimeIds,
          hubEntityId,
          hubRuntimeId,
          controller.signal,
          hubProfile,
        ),
      })));
      pending = results.filter(group => group.runtimeIds.length > 0);
      if (pending.length > 0) await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (pending.length > 0) {
      const missing = pending.flatMap(group => group.runtimeIds);
      throw new Error(`HLT_HOST_READINESS_INCOMPLETE:missing=${missing.length}:runtimeIds=${missing.join(',')}`);
    }
  } finally {
    clearTimeout(timer);
  }
};

export type LaneFinancialReadinessTarget = Readonly<{
  lane: LaneRuntime;
  hubEntityId: string;
  windows: readonly Readonly<{ tokenId: number; minimum: bigint }>[];
}>;

export const waitForLaneFinancialReadiness = async (
  targets: readonly LaneFinancialReadinessTarget[],
  perspective: 'user' | 'hub',
  requireProfile: boolean,
): Promise<void> => {
  const groups = new Map<string, { host: LaneRuntimeHostIngress; targets: LaneFinancialReadinessTarget[] }>();
  for (const target of targets) {
    const group = groups.get(target.lane.hostIngress.id) ?? { host: target.lane.hostIngress, targets: [] };
    group.targets.push(target);
    groups.set(target.lane.hostIngress.id, group);
  }
  const deadline = Date.now() + 20_000;
  let previousProgress = '';
  for (;;) {
    const results = await Promise.all([...groups.values()].map(async group => {
      const response = await fetch(`${group.host.baseUrl}/api/hlt/financial-readiness`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${group.host.authKey}`,
          'content-type': 'application/json',
        },
        body: serializeTaggedJson({
          perspective,
          requireProfile,
          targets: group.targets.map(target => ({
            runtimeId: target.lane.runtimeId,
            entityId: target.lane.identity.entityId,
            hubEntityId: target.hubEntityId,
            windows: target.windows,
          })),
        }),
      });
      const raw = await response.text();
      const decoded = requireBoundaryRecord(raw.trim() ? deserializeTaggedJson(raw) : {}, 'HLT_HOST_FINANCIAL_READINESS_RESPONSE_INVALID');
      if (!response.ok) throw new Error(`HLT_HOST_FINANCIAL_READINESS_REJECTED:${group.host.id}:${safeStringify(decoded)}`);
      requireExactBoundaryKeys(decoded, ['ok', 'ready', 'missing', 'details'], [], 'HLT_HOST_FINANCIAL_READINESS_RESPONSE_FIELDS_INVALID');
      if (decoded['ok'] !== true || typeof decoded['ready'] !== 'boolean' || !Array.isArray(decoded['missing']) || !Array.isArray(decoded['details'])) {
        throw new Error('HLT_HOST_FINANCIAL_READINESS_RESPONSE_INVALID');
      }
      return { missing: decoded['missing'].map(value => String(value)), details: decoded['details'] };
    }));
    const missing = results.flatMap(result => result.missing);
    if (missing.length === 0) return;
    const progress = results.flatMap(result => result.details).reduce((total, value, index) => {
      const detail = requireBoundaryRecord(value, `HLT_HOST_FINANCIAL_READINESS_DETAIL_INVALID:${index}`);
      total.accounts += typeof detail['accountHeight'] === 'number' ? 1 : 0;
      total.pendingFrames += typeof detail['pendingFrameHeight'] === 'number' ? 1 : 0;
      total.pendingInputs += typeof detail['pendingInputKind'] === 'string' ? 1 : 0;
      total.outboundAcks += typeof detail['lastOutboundAckHeight'] === 'number' ? 1 : 0;
      total.profiles += detail['profileKnown'] === true ? 1 : 0;
      const mempool = detail['mempoolTxTypes'];
      total.mempoolTxs += Array.isArray(mempool) ? mempool.length : 0;
      return total;
    }, {
      accounts: 0,
      pendingFrames: 0,
      pendingInputs: 0,
      outboundAcks: 0,
      profiles: 0,
      mempoolTxs: 0,
    });
    const fingerprint = safeStringify({ missing: missing.length, ...progress });
    if (fingerprint !== previousProgress) {
      previousProgress = fingerprint;
      console.log(`[load] financial-readiness perspective=${perspective} ${fingerprint}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`HLT_HOST_FINANCIAL_READINESS_INCOMPLETE:missing=${missing.length}:details=${safeStringify(results.flatMap(result => result.details))}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

export type LaneQuiescence = Readonly<{
  runtimes: number;
  openHubPeers: number;
  pendingRuntimeWork: number;
  pendingAccountFrames: number;
  accountMempoolTxs: number;
}>;

const laneDrainDetailFingerprints = new Map<string, string>();

const readHostQuiescence = async (
  host: LaneRuntimeHostIngress,
  runtimeIds: readonly string[],
  hubRuntimeId: string,
): Promise<LaneQuiescence> => {
  const response = await fetch(`${host.baseUrl}/api/hlt/quiescence`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.authKey}`,
      'content-type': 'application/json',
    },
    body: serializeTaggedJson({ hubRuntimeId, runtimeIds }),
  });
  const raw = await response.text();
  const decoded = requireBoundaryRecord(
    raw.trim() ? deserializeTaggedJson(raw) : {},
    'HLT_HOST_QUIESCENCE_RESPONSE_INVALID',
  );
  if (!response.ok) throw new Error(`HLT_HOST_QUIESCENCE_REJECTED:host=${host.id}:body=${safeStringify(decoded)}`);
  requireExactBoundaryKeys(
    decoded,
    ['ok', 'runtimes', 'openHubPeers', 'pendingRuntimeWork', 'pendingAccountFrames', 'accountMempoolTxs'],
    ['details'],
    'HLT_HOST_QUIESCENCE_RESPONSE_FIELDS_INVALID',
  );
  if (decoded['ok'] !== true) throw new Error(`HLT_HOST_QUIESCENCE_NOT_OK:${host.id}`);
  if (decoded['details'] !== undefined) {
    const fingerprint = safeStringify(decoded['details']);
    if (laneDrainDetailFingerprints.get(host.id) !== fingerprint) {
      laneDrainDetailFingerprints.set(host.id, fingerprint);
      console.log(`[load] lane-drain-details host=${host.id} ${fingerprint}`);
    }
  }
  const integer = (field: keyof LaneQuiescence): number =>
    requireBoundaryInteger(decoded[field], `HLT_HOST_QUIESCENCE_${field.toUpperCase()}_INVALID`);
  return {
    runtimes: integer('runtimes'),
    openHubPeers: integer('openHubPeers'),
    pendingRuntimeWork: integer('pendingRuntimeWork'),
    pendingAccountFrames: integer('pendingAccountFrames'),
    accountMempoolTxs: integer('accountMempoolTxs'),
  };
};

export const readLaneQuiescence = async (
  lanes: readonly LaneRuntime[],
  hubRuntimeId: string,
): Promise<LaneQuiescence> => {
  const groups = new Map<string, { host: LaneRuntimeHostIngress; runtimeIds: string[] }>();
  for (const lane of lanes) {
    const group = groups.get(lane.hostIngress.id) ?? { host: lane.hostIngress, runtimeIds: [] };
    group.runtimeIds.push(lane.runtimeId);
    groups.set(lane.hostIngress.id, group);
  }
  const rows = await Promise.all([...groups.values()].map(group =>
    readHostQuiescence(group.host, group.runtimeIds, hubRuntimeId)));
  return rows.reduce<LaneQuiescence>((total, row) => ({
    runtimes: total.runtimes + row.runtimes,
    openHubPeers: total.openHubPeers + row.openHubPeers,
    pendingRuntimeWork: total.pendingRuntimeWork + row.pendingRuntimeWork,
    pendingAccountFrames: total.pendingAccountFrames + row.pendingAccountFrames,
    accountMempoolTxs: total.accountMempoolTxs + row.accountMempoolTxs,
  }), { runtimes: 0, openHubPeers: 0, pendingRuntimeWork: 0, pendingAccountFrames: 0, accountMempoolTxs: 0 });
};

/** Five-second HLT drain gate required by the live TPS authority. */
export const waitForLaneQuiescence = async (
  lanes: readonly LaneRuntime[],
  hubRuntimeId: string,
  timeoutMs = 5_000,
): Promise<LaneQuiescence> => {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  let latest: LaneQuiescence | null = null;
  let fingerprint = '';
  while (Date.now() <= deadline) {
    latest = await readLaneQuiescence(lanes, hubRuntimeId);
    const nextFingerprint = safeStringify(latest);
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint;
      console.log(`[load] lane-drain elapsedMs=${Date.now() - startedAt} ${nextFingerprint}`);
    }
    if (
      latest.runtimes === lanes.length &&
      latest.openHubPeers === lanes.length &&
      latest.pendingRuntimeWork === 0 &&
      latest.pendingAccountFrames === 0 &&
      latest.accountMempoolTxs === 0
    ) return latest;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`HLT_LANE_QUIESCENCE_TIMEOUT:${safeStringify(latest)}`);
};

const RUNTIMES_PER_PROCESS = (() => {
  const raw = process.env['XLN_HLT_RUNTIMES_PER_PROCESS'];
  if (!raw) return 200;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error(`HLT_RUNTIMES_PER_PROCESS_INVALID:${raw}`);
  }
  return value;
})();

export const LANE_PORTS_PER_SLOT = (() => {
  const raw = process.env['XLN_HLT_LANE_PORTS_PER_SLOT'] ?? '4096';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 4_096 || value > 32_768 || (value & (value - 1)) !== 0) {
    throw new Error(`HLT_LANE_PORTS_PER_SLOT_INVALID:${raw}`);
  }
  return value;
})();
const LANE_PORT_FLOOR = 21_000;
const MAX_TCP_PORT = 65_535;

export const laneRuntimePortBase = (portBase: number): number =>
  LANE_PORT_FLOOR + Math.floor((portBase - 20_000) / 20) * LANE_PORTS_PER_SLOT;

export const laneRuntimePort = (portBase: number, laneIndex: number): number => {
  if (!Number.isSafeInteger(laneIndex) || laneIndex < 0) {
    throw new Error(`HLT_LANE_INDEX_INVALID:${laneIndex}`);
  }
  if (laneIndex >= LANE_PORTS_PER_SLOT) {
    throw new Error(`HLT_LANE_INDEX_EXCEEDS_SLOT:${laneIndex}:${LANE_PORTS_PER_SLOT}`);
  }
  const port = laneRuntimePortBase(portBase) + laneIndex;
  if (port > MAX_TCP_PORT) throw new Error(`HLT_LANE_PORT_OUT_OF_RANGE:${port}`);
  return port;
};

const READY_TIMEOUT_MS = 20_000;

export const resolveHltLaneJurisdictionsPath = (workDir: string): string => {
  const jurisdictionsPath = join(workDir, 'prod-mesh', 'jurisdictions.json');
  if (!existsSync(jurisdictionsPath)) {
    throw new Error(`HLT_LANE_JURISDICTIONS_MISSING:${jurisdictionsPath}`);
  }
  return jurisdictionsPath;
};

const connectSovereignRuntimeAdapters = async <T>(
  values: readonly T[],
  connect: (value: T, index: number) => Promise<LaneRuntime>,
): Promise<LaneRuntime[]> => Promise.all(values.map(connect));

const spawnSovereignRuntimeHost = async (options: {
  workDir: string;
  portBase: number;
  identities: readonly ManagedEntityIdentity[];
  laneSeeds: readonly string[];
  laneIndex: number;
  connectRuntimeAdapters: boolean;
}): Promise<LaneRuntime[]> => {
  const firstPort = laneRuntimePort(options.portBase, options.laneIndex);
  const relayUrl = `ws://127.0.0.1:${options.portBase + 4}/relay`;
  const authSeed = randomBytes(32).toString('hex');
  const dbRoot = join(
    options.workDir,
    'prod-mesh',
    'load-lanes',
    `host-${String(options.laneIndex).padStart(4, '0')}`,
  );
  const jurisdictionsPath = resolveHltLaneJurisdictionsPath(options.workDir);
  mkdirSync(dbRoot, { recursive: true });
  const child = spawnBunChild(
    `load-host-${options.laneIndex}`,
    ['core/scripts/operations/hlt/lanes/sovereign-runtime-host.ts', '--first-port', String(firstPort)],
    {
      XLN_RADAPTER_REQUIRE_STRONG_AUTH_SEED: '1',
      XLN_PORT_BASE: String(options.portBase),
      XLN_DB_PATH: join(dbRoot, 'db'),
      XLN_RDB_ROOT: dbRoot,
      // Load users are ephemeral traffic generators. Only the Hub under test
      // owns production WAL/state; a failed HLT can never restore a user DB.
      XLN_DISABLE_RUNTIME_RESTORE: '1',
      XLN_STORAGE_HISTORY_PATH: join(dbRoot, 'storage-health-history.json'),
      XLN_JURISDICTIONS_PATH: jurisdictionsPath,
      XLN_LOG_LEVEL: process.env['XLN_LOAD_LANE_LOG_LEVEL'] || 'warn',
      XLN_HLT_DIRECT_ONLY: '1',
      XLN_HLT_OPERATION_LEDGER: '1',
      // Diagnostic-only, one OS host (two 100-Runtime workers). Keeping the
      // other 4,800 users silent avoids turning telemetry into the workload.
      XLN_HLT_TRACE_LANE_PROGRESS:
        process.env['XLN_HLT_TRACE_LANE_PROGRESS'] === '1' && options.laneIndex === 0 ? '1' : '0',
      XLN_HLT_LANE_PERSISTENCE: '0',
      // The process already shards sovereign Runtime instances across fixed
      // OS workers. A second 8-thread Account pool per Runtime would create up
      // to 8,000 workers at 1,000 users and stalls bootstrap before live load.
      XLN_TS_ACCOUNT_WORKERS: '0',
      XLN_HLT_PER_RUNTIME_CONTROL: options.connectRuntimeAdapters ? '1' : '0',
      XLN_STORAGE_WAL_SYNC: '0',
      ...(process.env['XLN_P2P_DELIVERY_TRACE'] === '1' ? { XLN_P2P_DELIVERY_TRACE: '1' } : {}),
      ...(process.env['XLN_HEAVY_LOGS'] ? { XLN_HEAVY_LOGS: '1' } : {}),
      ...(process.env['XLN_RUNTIME_FRAME_LOG'] ? { XLN_RUNTIME_FRAME_LOG: '1' } : {}),
      ...(process.env['XLN_RUNTIME_APPLY_PROFILE'] ? { XLN_RUNTIME_APPLY_PROFILE: '1' } : {}),
      ...(process.env['XLN_HLT_LANE_NICE'] ? { XLN_CHILD_NICE: process.env['XLN_HLT_LANE_NICE'] } : {}),
      ...(process.env['XLN_RUNTIME_OP_COUNTERS'] ? { XLN_RUNTIME_OP_COUNTERS: '1' } : {}),
      ...(process.env['XLN_RUNTIME_SAMPLING_PROFILE'] === '1'
        ? {
            XLN_RUNTIME_SAMPLING_PROFILE: '1',
            XLN_RUNTIME_SAMPLING_PROFILE_DIR: process.env['XLN_RUNTIME_SAMPLING_PROFILE_DIR'] || '/tmp/xln-sampling-profile',
          }
        : {}),
      ...(process.env['XLN_RUNTIME_OP_COUNTERS_DIR']
        ? { XLN_RUNTIME_OP_COUNTERS_DIR: process.env['XLN_RUNTIME_OP_COUNTERS_DIR'] }
        : {}),
      ...(process.env['XLN_HLT_LANE_MAX_ENTITY_INPUTS_PER_FRAME']
        ? { XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME: process.env['XLN_HLT_LANE_MAX_ENTITY_INPUTS_PER_FRAME'] }
        : {}),
      XLN_RADAPTER_SEND_BURST: '200',
      XLN_RADAPTER_SEND_PER_SEC: '100',
      XLN_RADAPTER_READ_BURST: '200',
      XLN_RADAPTER_READ_PER_SEC: '100',
      XLN_RADAPTER_CONTROL_BURST: '200',
      XLN_RADAPTER_CONTROL_PER_SEC: '100',
      XLN_GOSSIP_PROFILE_LOOKUP_PER_CLIENT_LIMIT: String(
        Math.max(64, Number(process.env['XLN_HLT_USERS'] || '0') || 64),
      ),
      XLN_GOSSIP_PROFILE_LOOKUP_GLOBAL_LIMIT: String(
        Math.max(1_000, (Number(process.env['XLN_HLT_USERS'] || '0') || 64) * 4),
      ),
    },
    { authSeed, laneSeedsBase64: encodeSovereignRuntimeSeeds(options.laneSeeds) },
  );
  const daemonLog = createWriteStream(join(dbRoot, 'daemon.log'), { flags: 'a' });
  child.proc.stdout.on('data', (chunk: Buffer) => daemonLog.write(chunk));
  child.proc.stderr.on('data', (chunk: Buffer) => daemonLog.write(chunk));
  await waitForHttpReady(
    `http://127.0.0.1:${firstPort}/health`,
    child,
    READY_TIMEOUT_MS,
    (_response, bodyText) => {
      try {
        const body = JSON.parse(bodyText) as { ready?: unknown; runtimes?: unknown; expected?: unknown };
        return body.ready === true && body.runtimes === options.identities.length && body.expected === options.identities.length;
      } catch {
        return false;
      }
    },
  );
  const workerStarts = Array.from(
    { length: Math.ceil(options.identities.length / SOVEREIGN_RUNTIMES_PER_WORKER) },
    (_unused, index) => index * SOVEREIGN_RUNTIMES_PER_WORKER,
  );
  const runtimeIds = (await Promise.all(workerStarts.map(async workerStart => {
    const response = await fetch(`http://127.0.0.1:${firstPort + workerStart}/health`);
    if (!response.ok) {
      throw new Error(`HLT_SOVEREIGN_RUNTIME_IDS_HTTP:${response.status}:${workerStart}`);
    }
    const body = await response.json() as { runtimeIds?: unknown };
    if (!Array.isArray(body.runtimeIds)) {
      throw new Error(`HLT_SOVEREIGN_RUNTIME_IDS_MISSING:${workerStart}`);
    }
    const expected = Math.min(
      SOVEREIGN_RUNTIMES_PER_WORKER,
      options.identities.length - workerStart,
    );
    const values = body.runtimeIds.map(value => String(value).trim().toLowerCase());
    if (values.length !== expected || values.some(value => !/^0x[0-9a-f]{40}$/.test(value))) {
      throw new Error(`HLT_SOVEREIGN_RUNTIME_IDS_INVALID:${workerStart}:${values.length}:${expected}`);
    }
    return values;
  }))).flat();
  if (runtimeIds.length !== options.identities.length || new Set(runtimeIds).size !== runtimeIds.length) {
    throw new Error(`HLT_SOVEREIGN_RUNTIME_IDS_CARDINALITY_INVALID:${runtimeIds.length}:${options.identities.length}`);
  }
  const workerIngress = new Map<number, LaneRuntimeHostIngress>();
  const ingressForRuntime = (index: number): LaneRuntimeHostIngress => {
    const workerStart = sovereignRuntimeWorkerStart(index);
    const existing = workerIngress.get(workerStart);
    if (existing) return existing;
    const workerRuntimeId = runtimeIds[workerStart];
    if (!workerRuntimeId) {
      throw new Error(`HLT_SOVEREIGN_WORKER_RUNTIME_ID_MISSING:${workerStart}`);
    }
    const ingress: LaneRuntimeHostIngress = {
      id: `${child.name}:worker-${workerStart}:${workerRuntimeId}`,
      baseUrl: `http://127.0.0.1:${firstPort + workerStart}`,
      sequence: { nextWave: 0 },
      authKey: deriveRuntimeAdapterCapabilityToken(authSeed, 'full', Date.now() + 60 * 60_000, {
        audience: workerRuntimeId,
        keyId: 'load-host-worker-batch',
        tokenId: randomBytes(16).toString('hex'),
      }),
    };
    workerIngress.set(workerStart, ingress);
    return ingress;
  };
  return connectSovereignRuntimeAdapters(options.identities, async (identity, index) => {
    const port = firstPort + index;
    const runtimeId = runtimeIds[index];
    if (!runtimeId) throw new Error(`HLT_SOVEREIGN_RUNTIME_ID_MISSING:${index}`);
    const runtime = options.connectRuntimeAdapters
      ? await connectRuntime({
          label: `load-runtime-${options.laneIndex}-${index}`,
          wsUrl: `ws://127.0.0.1:${port}/rpc`,
          token: deriveRuntimeAdapterCapabilityToken(authSeed, 'full', Date.now() + 60 * 60_000, {
            audience: runtimeId,
            keyId: 'load-lane',
            tokenId: randomBytes(16).toString('hex'),
          }),
        })
      : null;
    return {
      identity,
      laneKey: `${runtimeId}-${identity.entityId.slice(-8)}`,
      port,
      child,
      runtime,
      runtimeId,
      relayUrl,
      hostIngress: ingressForRuntime(index),
      hostedEntityIds: [identity.entityId],
    };
  });
};

export const spawnLaneRuntimes = async (options: {
  workDir: string;
  portBase: number;
  identities: readonly ManagedEntityIdentity[];
  laneSeeds: readonly string[];
  laneIndexOffset: number;
  connectRuntimeAdapters?: boolean;
}): Promise<LaneRuntime[]> => {
  if (options.laneSeeds.length !== options.identities.length) {
    throw new Error('HLT_LANE_SEED_CARDINALITY_INVALID');
  }
  const groups: Array<{ start: number; identities: ManagedEntityIdentity[]; seeds: string[] }> = [];
  for (let start = 0; start < options.identities.length; start += RUNTIMES_PER_PROCESS) {
    groups.push({
      start,
      identities: [...options.identities.slice(start, start + RUNTIMES_PER_PROCESS)],
      seeds: [...options.laneSeeds.slice(start, start + RUNTIMES_PER_PROCESS)],
    });
  }
  const lanes: LaneRuntime[] = [];
  try {
    const spawned = await Promise.all(groups.map(group => spawnSovereignRuntimeHost({
      workDir: options.workDir,
      portBase: options.portBase,
      identities: group.identities,
      laneSeeds: group.seeds,
      laneIndex: options.laneIndexOffset + group.start,
      connectRuntimeAdapters: options.connectRuntimeAdapters !== false,
    })));
    lanes.push(...spawned.flat());
    return lanes;
  } catch (error) {
    await stopLaneRuntimes(lanes);
    throw error;
  }
};

/** Distinct OS processes behind a sovereign Runtime list. */
export const laneDaemons = (lanes: readonly LaneRuntime[]): LaneRuntime[] => {
  const seen = new Set<ManagedChild>();
  return lanes.filter(lane => {
    if (seen.has(lane.child)) return false;
    seen.add(lane.child);
    return true;
  });
};

export const stopLaneRuntimes = async (lanes: readonly LaneRuntime[]): Promise<void> => {
  for (const lane of lanes) lane.runtime?.adapter.disconnect();
  // The settlement gate has already proved every Account/Runtime queue empty,
  // and a fresh HLT never restores these ephemeral load-user databases. Waiting
  // for one host to close hundreds of independent LevelDB handles added ~30 s
  // after the measured run without producing stronger financial evidence.
  await Promise.all(laneDaemons(lanes).map(lane => stopManagedChild(lane.child, {
    terminateTimeoutMs: 250,
    killTimeoutMs: 2_000,
  })));
};
