/** Deterministic setup of real user Entity/Account lanes, one isolated Runtime process per lane. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { defaultAccountDisputeConfigForRoleEvidence } from '../../../../account/config/dispute-config';
import {
  deriveManagedEntityIdentity,
  type ManagedEntityIdentity,
} from '../../../../orchestrator/daemon-control';
import { deriveMeshChildSeed } from '../../../../orchestrator/mesh/mesh-seeds';
import { laneDaemons, spawnLaneRuntimes, stopLaneRuntimes, type LaneRuntime } from './lane-runtimes';
import { importEntity } from '../../../../runtime/registration/entity-creation';
import type { RuntimeInput } from '../../../../runtime/types';
import { decodeEntitySummaries, type LoadIdentity } from '../boundary/worker-boundary';
import {
  sendObserved,
  waitForCounterpartyCredit,
  waitForCredit,
  type ConnectedRuntime,
} from '../worker-runtime';

/**
 * Provisioning fan-out. Each lane is its own daemon with its own rate budget,
 * so this bounds the driver and the Hub-directed polls, not a per-lane quota.
 * A four-figure population would otherwise spend minutes in setup alone.
 */
export const CONTROL_CONCURRENCY = Math.max(
  4,
  Math.min(256, Number(process.env['XLN_HLT_CONTROL_CONCURRENCY'] || '') || 32),
);
const LOAD_LANE_GOSSIP_POLL_MS = 10_000;
const CONTROL_BATCH_PAUSE_MS = 100;
/** Gossip poll while provisioning; each poll re-verifies the peers it learns. */
const PROVISIONING_GOSSIP_POLL_MS = 1_000;
// Non-reliable route identity retains the complete transaction fingerprints.
// Keep setup frames below the 10 KB durable Runtime-machine row limit: the
// observed 50-Account shape encoded to 21,598 bytes, while 16 leaves headroom.
const PROVISIONING_ACCOUNTS_PER_FRAME = 16;
const VISIBILITY_TIMEOUT_MS = 60_000;
const PER_ENTITY_VISIBILITY_BUDGET_MS = 500;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const runtimeHttpBaseFromWsUrl = (raw: string): string => {
  const url = new URL(raw);
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username || url.password || url.search || url.hash) {
    throw new Error('PRODUCTION_SWAP_LOAD_CONTROL_URL_INVALID');
  }
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  return url.toString().replace(/\/$/, '');
};

export const connectedRuntimeHttpBase = (
  runtime: Pick<ConnectedRuntime, 'wsUrl'>,
): string => runtimeHttpBaseFromWsUrl(runtime.wsUrl);

export const deriveLoadLaneSeeds = (
  meshRootSeed: string,
  lanes: number,
  role: 'maker' | 'taker' = 'taker',
  laneOffset = 0,
): string[] => Array.from({ length: lanes }, (_, index) => {
  const laneNumber = laneOffset + index + 1;
  return deriveMeshChildSeed(
    meshRootSeed,
    role === 'taker'
      ? `production-swap-load:lane:${laneNumber}`
      : `production-swap-load:maker-lane:${laneNumber}`,
  );
});

export const deriveLoadLaneIdentities = (
  meshRootSeed: string,
  lanes: number,
  role: 'maker' | 'taker' = 'taker',
  laneOffset = 0,
): ManagedEntityIdentity[] => deriveLoadLaneSeeds(meshRootSeed, lanes, role, laneOffset).map((seed, index) =>
  deriveManagedEntityIdentity({
    name: `Load ${role === 'maker' ? 'Maker' : 'Taker'} ${String(laneOffset + index + 1).padStart(4, '0')}`,
    seed,
    signerLabel: 'owner',
    position: { x: index % 32, y: Math.floor(index / 32), z: 0 },
  }));

export const partitionLoadControlBatches = <T>(values: readonly T[]): readonly (readonly T[])[] => {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += CONTROL_CONCURRENCY) {
    batches.push(values.slice(offset, offset + CONTROL_CONCURRENCY));
  }
  return batches;
};

export const partitionLoadProvisioningBatches = <T>(
  values: readonly T[],
): readonly (readonly T[])[] => {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += PROVISIONING_ACCOUNTS_PER_FRAME) {
    batches.push(values.slice(offset, offset + PROVISIONING_ACCOUNTS_PER_FRAME));
  }
  return batches;
};

const runInBatches = async <T>(
  values: readonly T[],
  effect: (value: T, index: number) => Promise<void>,
): Promise<void> => {
  let offset = 0;
  const batches = partitionLoadControlBatches(values);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    await Promise.all(batch.map((value, batchIndex) => effect(value, offset + batchIndex)));
    offset += batch.length;
    // Provisioning is outside the measured workload. Pacing it below the
    // authenticated operator API budget avoids manufacturing a setup-only
    // rate-limit failure that says nothing about Hub settlement capacity.
    if (index + 1 < batches.length) await sleep(CONTROL_BATCH_PAUSE_MS);
  }
};

/**
 * Every new user must become discoverable before it can trade, and each
 * profile a peer learns costs that peer a full Hanko verification. Onboarding
 * therefore gets a budget proportional to the population instead of one flat
 * minute, and it reports how fast the directory is actually converging — that
 * rate is a result, not harness noise.
 */
const waitForVisibleEntities = async (
  runtime: ConnectedRuntime,
  entityIds: readonly string[],
  code: string,
): Promise<void> => {
  const required = new Set(entityIds);
  const startedAt = Date.now();
  const deadline = startedAt + VISIBILITY_TIMEOUT_MS + entityIds.length * PER_ENTITY_VISIBILITY_BUDGET_MS;
  let lastMissing = -1;
  while (Date.now() < deadline) {
    const visible = new Set(
      decodeEntitySummaries(await runtime.adapter.read<unknown>('entities')).map(entity => entity.entityId),
    );
    const missing = [...required].filter(entityId => !visible.has(entityId)).length;
    if (missing === 0) {
      console.log(`[load] gossip converged entities=${required.size} elapsedMs=${Date.now() - startedAt}`);
      return;
    }
    if (missing !== lastMissing) {
      console.log(`[load] gossip pending=${missing}/${required.size} elapsedMs=${Date.now() - startedAt}`);
      lastMissing = missing;
    }
    await sleep(250);
  }
  throw new Error(`${code}:missing=${lastMissing}:of=${required.size}`);
};

const waitForHubProfile = async (lane: LaneRuntime, hubEntityId: string): Promise<void> => {
  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await lane.control.hasGossipProfile(hubEntityId)) return;
    await sleep(100);
  }
  throw new Error(`PRODUCTION_SWAP_LOAD_HUB_PROFILE_NOT_VISIBLE:${lane.laneKey}`);
};

/** After register+credit the user must advertise the Hub lane, or peers cannot quote a payment. */
const waitForOwnReceiveReadyProfile = async (lane: LaneRuntime, hubEntityId: string): Promise<void> => {
  const selfId = lane.identity.entityId.toLowerCase();
  const hubId = hubEntityId.toLowerCase();
  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const counterparties = await lane.control.gossipProfileCounterparties(selfId);
    if (counterparties?.includes(hubId)) return;
    await sleep(100);
  }
  throw new Error(`HLT_OWN_PROFILE_NOT_RECEIVE_READY:${lane.laneKey}:${selfId.slice(0, 12)}`);
};

const buildLaneImports = (identities: readonly ManagedEntityIdentity[]): RuntimeInput['runtimeTxs'] =>
  identities.map(identity => importEntity({
    entityId: identity.entityId,
    signerId: identity.signerId,
    entitySeed: ethers.getBytes(identity.entitySeed),
    data: {
      config: identity.consensusConfig,
      isProposer: true,
      profileName: identity.name,
      position: identity.position,
    },
  }));

const buildLaneAccountInputs = (
  identities: readonly ManagedEntityIdentity[],
  hubEntityId: string,
  creditTokenId: number,
  creditAmounts: readonly bigint[],
): RuntimeInput['entityInputs'] => identities.map((identity, index) => ({
  entityId: identity.entityId,
  signerId: identity.signerId,
  entityTxs: [{
    type: 'openAccount',
    data: {
      targetEntityId: hubEntityId,
      disputeConfig: defaultAccountDisputeConfigForRoleEvidence(
        { entityId: identity.entityId, isHub: false, source: 'operator-config' },
        { entityId: hubEntityId, isHub: true, source: 'operator-config' },
      ),
    },
  }, {
    type: 'extendCredit',
    data: {
      counterpartyEntityId: hubEntityId,
      tokenId: creditTokenId,
      amount: creditAmounts[index]!,
    },
  }],
}));

export const setupParallelLoadLanes = async (options: {
  workDir: string;
  portBase: number;
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  lanes: number;
  laneOffset: number;
  role: 'maker' | 'taker';
  laneGrantedCreditTokenId: number;
  laneGrantedCreditAmounts: readonly bigint[];
  hubGrantedCreditTokenId: number;
  hubGrantedCreditAmounts: readonly bigint[];
}): Promise<{ identities: LoadIdentity[]; runtimes: LaneRuntime[] }> => {
  const rootSeed = readFileSync(join(options.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  if (!rootSeed) throw new Error('PRODUCTION_SWAP_LOAD_MESH_ROOT_SEED_MISSING');
  const seeds = deriveLoadLaneSeeds(rootSeed, options.lanes, options.role, options.laneOffset);
  const identities = deriveLoadLaneIdentities(rootSeed, options.lanes, options.role, options.laneOffset);
  if (
    options.laneGrantedCreditAmounts.length !== identities.length ||
    options.hubGrantedCreditAmounts.length !== identities.length
  ) {
    throw new Error('PRODUCTION_SWAP_LOAD_LANE_CREDIT_CARDINALITY_INVALID');
  }
  // Every lane is its own process: makers occupy [0, lanes), takers [lanes, 2*lanes).
  const runtimes = await spawnLaneRuntimes({
    workDir: options.workDir,
    portBase: options.portBase,
    identities,
    laneSeeds: seeds,
    laneIndexOffset: (options.role === 'maker' ? 0 : options.lanes) + options.laneOffset * 2,
  });
  try {
    return await provisionLoadLanes(options, identities, runtimes);
  } catch (error) {
    // A failed provisioning step must not leave daemons listening on the lane
    // ports: the next run would connect to a halted stranger on :21000.
    await stopLaneRuntimes(runtimes);
    throw error;
  }
};

const provisionLoadLanes = async (
  options: Parameters<typeof setupParallelLoadLanes>[0],
  identities: readonly ManagedEntityIdentity[],
  runtimes: LaneRuntime[],
): Promise<{ identities: LoadIdentity[]; runtimes: LaneRuntime[] }> => {
  await runInBatches(runtimes, async lane => {
    await lane.control.registerSigner(lane.identity.signerId, lane.identity.privateKeyHex);
    const existing = new Set((await lane.control.listEntities()).map(entity => entity.entityId));
    if (!existing.has(lane.identity.entityId)) {
      await sendObserved(lane.runtime, `prod-load-import-${options.role}-${lane.laneKey}`, {
        runtimeTxs: buildLaneImports([lane.identity]), entityInputs: [],
      });
    }
    await waitForVisibleEntities(lane.runtime, [lane.identity.entityId], 'PRODUCTION_SWAP_LOAD_LANES_NOT_IMPORTED');
  });
  // P2P config is per daemon and replaces the advertised set, so a daemon that
  // hosts several users advertises all of them at once, after every import.
  await runInBatches(laneDaemons(runtimes), lane => lane.control.configureP2P({
    relayUrls: [lane.relayUrl],
    advertiseEntityIds: [...lane.hostedEntityIds],
    gossipPollMs: PROVISIONING_GOSSIP_POLL_MS,
  }));
  // The Hub does not pin users. Each user must still publish a receive-ready
  // profile (Hub counterparty in accounts) before any peer can quote a route.
  await runInBatches(runtimes, async (lane, index) => {
    await waitForHubProfile(lane, options.hubIdentity.entityId);
    await sendObserved(lane.runtime, `prod-load-open-${options.role}-${lane.laneKey}`, {
      runtimeTxs: [],
      entityInputs: buildLaneAccountInputs(
        [lane.identity],
        options.hubIdentity.entityId,
        options.laneGrantedCreditTokenId,
        [options.laneGrantedCreditAmounts[index]!],
      ),
    });
  });
  // Each lane confirms its own grant from its own replica; the Hub is the
  // process under test and must not spend its client budget on provisioning.
  await runInBatches(runtimes, (lane, index) => waitForCounterpartyCredit(
    lane.runtime,
    lane.identity.entityId,
    options.hubIdentity.entityId,
    options.laneGrantedCreditTokenId,
    options.laneGrantedCreditAmounts[index]!,
  ));
  const hubBatches = partitionLoadProvisioningBatches(runtimes);
  let laneOffset = 0;
  for (let batchIndex = 0; batchIndex < hubBatches.length; batchIndex += 1) {
    const batch = hubBatches[batchIndex]!;
    const hubCredits = options.hubGrantedCreditAmounts.slice(laneOffset, laneOffset + batch.length);
    await sendObserved(options.hub, `prod-load-credit-${options.role}-${options.laneOffset}-${options.lanes}-${batchIndex + 1}`, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: options.hubIdentity.entityId,
        signerId: options.hubIdentity.signerId,
        entityTxs: batch.map((lane, index) => ({
          type: 'extendCredit' as const,
          data: {
            counterpartyEntityId: lane.identity.entityId,
            tokenId: options.hubGrantedCreditTokenId,
            amount: hubCredits[index]!,
          },
        })),
      }],
    });
    await runInBatches(batch, (lane, index) => waitForCredit(
      lane.runtime,
      lane.identity.entityId,
      options.hubIdentity.entityId,
      options.hubGrantedCreditTokenId,
      hubCredits[index]!,
    ));
    laneOffset += batch.length;
  }
  await runInBatches(runtimes, lane => waitForOwnReceiveReadyProfile(lane, options.hubIdentity.entityId));
  // Fast polling only served setup; a real user Runtime does not ask the Hub
  // for gossip four times a second while trading.
  await runInBatches(laneDaemons(runtimes), lane => lane.control.configureP2P({
    relayUrls: [lane.relayUrl],
    advertiseEntityIds: [...lane.hostedEntityIds],
    gossipPollMs: LOAD_LANE_GOSSIP_POLL_MS,
  }));
  return {
    identities: identities.map(identity => ({ entityId: identity.entityId, signerId: identity.signerId })),
    runtimes,
  };
};
