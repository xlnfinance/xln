/** Deterministic setup of real user Entity/Account lanes, one sovereign Runtime per user. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { defaultAccountDisputeConfigForRoleEvidence } from '../../../../account/config/dispute-config';
import {
  deriveManagedEntityIdentity,
  type ManagedEntityIdentity,
} from '../../../../orchestrator/daemon-control';
import { deriveMeshChildSeed } from '../../../../orchestrator/mesh/mesh-seeds';
import {
  queueLaneRuntimeInputWave,
  spawnLaneRuntimes,
  stopLaneRuntimes,
  waitForLaneFinancialReadiness,
  waitForLaneHostReadiness,
  type LaneRuntime,
} from './lane-runtimes';
import { getTokenInfo } from '../../../../account/utils';
import { importEntity } from '../../../../runtime/registration/entity-creation';
import type { RuntimeInput } from '../../../../runtime/types';
import { decodeEntitySummaries, type LoadIdentity } from '../boundary/worker-boundary';
import { sendObserved, type ConnectedRuntime } from '../worker-runtime';

const VISIBILITY_TIMEOUT_MS = 60_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export const HLT_FAUCET_TOKEN_ID = 1;
export const HLT_FAUCET_AMOUNT = 5_000n * 10n ** BigInt(getTokenInfo(HLT_FAUCET_TOKEN_ID).decimals);
export const HLT_USER_RECEIVE_WINDOW = HLT_FAUCET_AMOUNT * 2n;

export type LoadLaneRole = 'maker' | 'taker' | 'trader';

export const deriveLoadLaneSeeds = (
  meshRootSeed: string,
  lanes: number,
  role: LoadLaneRole = 'taker',
  laneOffset = 0,
): string[] => Array.from({ length: lanes }, (_, index) => {
  const laneNumber = laneOffset + index + 1;
  return deriveMeshChildSeed(
    meshRootSeed,
    role === 'trader'
      ? `production-swap-load:trader-lane:${laneNumber}`
      : role === 'taker'
        ? `production-swap-load:lane:${laneNumber}`
        : `production-swap-load:maker-lane:${laneNumber}`,
  );
});

export const deriveLoadLaneIdentities = (
  meshRootSeed: string,
  lanes: number,
  role: LoadLaneRole = 'taker',
  laneOffset = 0,
): ManagedEntityIdentity[] => deriveLoadLaneSeeds(meshRootSeed, lanes, role, laneOffset).map((seed, index) =>
  deriveManagedEntityIdentity({
    name: `Load ${role === 'trader' ? 'Trader' : role === 'maker' ? 'Maker' : 'Taker'} ${String(laneOffset + index + 1).padStart(4, '0')}`,
    seed,
    signerLabel: 'owner',
    position: { x: index % 32, y: Math.floor(index / 32), z: 0 },
  }));

/**
 * One population barrier, never one waiter per user. Every poll samples all
 * sovereign Runtimes concurrently and the failure names the exact missing
 * users; setup latency therefore cannot grow through harness serialization.
 */
const waitForPopulationEntities = async (
  runtimes: readonly LaneRuntime[],
): Promise<void> => {
  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS;
  let missing: string[] = runtimes.map(lane => lane.laneKey);
  while (Date.now() < deadline) {
    const ready = await Promise.all(runtimes.map(async lane => {
      const entities = decodeEntitySummaries(await lane.runtime.adapter.read<unknown>('entities'));
      return entities.some(entity => entity.entityId === lane.identity.entityId);
    }));
    missing = runtimes.filter((_lane, index) => !ready[index]).map(lane => lane.laneKey);
    if (missing.length === 0) return;
    await sleep(100);
  }
  throw new Error(
    `PRODUCTION_SWAP_LOAD_POPULATION_ENTITY_NOT_READY:missing=${missing.length}:` +
    `users=${missing.join(',')}`,
  );
};

const waitForHubProfilesSendReady = async (
  hub: ConnectedRuntime,
  lanes: readonly LaneRuntime[],
): Promise<void> => {
  const readiness = await hub.control.gossipProfilesSendReady(lanes.map(lane => ({
    entityId: lane.identity.entityId,
    runtimeId: lane.runtimeId,
  })));
  if (readiness.ready) return;
  throw new Error(`PRODUCTION_SWAP_LOAD_USER_PROFILES_NOT_SEND_READY:missing=${readiness.missing.length}:` +
    `entities=${readiness.missing.join(',')}`);
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

const buildLaneProfileInputs = (
  identities: readonly ManagedEntityIdentity[],
): RuntimeInput['entityInputs'] => identities.map(identity => ({
  entityId: identity.entityId,
  signerId: identity.signerId,
  entityTxs: [{
    type: 'profile-update',
    data: { profile: { entityId: identity.entityId, name: identity.name } },
  }],
}));

const buildLaneAccountInputs = (
  identities: readonly ManagedEntityIdentity[],
  hubEntityId: string,
  additionalReceiveWindows: readonly Readonly<{ tokenId: number; amount: bigint }>[] = [],
): RuntimeInput['entityInputs'] => identities.map(identity => {
  // Put every user at the midpoint of its bilateral window: after the real
  // $5000 faucet it can both send $5000 and receive $5000 through H1. Using a
  // window equal to the faucet placed every Account at its endpoint, so H1
  // correctly rejected the first forwarded HTLC as insufficient capacity.
  const receiveWindows = new Map<number, bigint>([[HLT_FAUCET_TOKEN_ID, HLT_USER_RECEIVE_WINDOW]]);
  for (const window of additionalReceiveWindows) {
    const current = receiveWindows.get(window.tokenId) ?? 0n;
    if (window.amount > current) receiveWindows.set(window.tokenId, window.amount);
  }
  return {
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
      // HLT measures payment/swap consensus, not collateral automation. Equal
      // soft/hard limits are the canonical manual-rebalance policy and prevent
      // every faucet payment from manufacturing a fee frame + J-side request.
      rebalancePolicy: {
        r2cRequestSoftLimit: HLT_FAUCET_AMOUNT,
        hardLimit: HLT_FAUCET_AMOUNT,
        maxAcceptableFee: 0n,
      },
    },
  }, ...Array.from(receiveWindows, ([tokenId, amount]) => ({
    type: 'extendCredit' as const,
    data: {
      counterpartyEntityId: hubEntityId,
      tokenId,
      amount,
    },
  }))],
  };
});

export const setupParallelLoadLanes = async (options: {
  workDir: string;
  portBase: number;
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  lanes: number;
  laneOffset: number;
  role: 'maker' | 'taker';
}): Promise<{ identities: LoadIdentity[]; runtimes: LaneRuntime[] }> => {
  const rootSeed = readFileSync(join(options.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  if (!rootSeed) throw new Error('PRODUCTION_SWAP_LOAD_MESH_ROOT_SEED_MISSING');
  const seeds = deriveLoadLaneSeeds(rootSeed, options.lanes, options.role, options.laneOffset);
  const identities = deriveLoadLaneIdentities(rootSeed, options.lanes, options.role, options.laneOffset);
  // Every lane is a sovereign Runtime. Hosts only share an OS process in
  // bounded groups (200 by default, operator-selectable up to 1000).
  const runtimes = await spawnLaneRuntimes({
    workDir: options.workDir,
    portBase: options.portBase,
    identities,
    laneSeeds: seeds,
    laneIndexOffset: (options.role === 'maker' ? 0 : options.lanes) + options.laneOffset * 2,
  });
  try {
    await provisionLoadPopulation({
      hub: options.hub,
      hubIdentity: options.hubIdentity,
      population: runtimes.map(lane => ({ lane, receiveWindows: [] })),
    });
    return {
      identities: identities.map(identity => ({ entityId: identity.entityId, signerId: identity.signerId })),
      runtimes,
    };
  } catch (error) {
    // A failed provisioning step must not leave daemons listening on the lane
    // ports: the next run would connect to a halted stranger on :21000.
    await stopLaneRuntimes(runtimes);
    throw error;
  }
};

/** One role-free population: every user is funded to trade both token sides. */
export const setupParallelLoadTraderPopulation = async (options: {
  workDir: string;
  portBase: number;
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  traders: number;
  laneOffset: number;
  receiveWindows: readonly (readonly Readonly<{ tokenId: number; amount: bigint }>[])[];
}): Promise<{ identities: LoadIdentity[]; runtimes: LaneRuntime[] }> => {
  if (options.receiveWindows.length !== options.traders) {
    throw new Error(`HLT_TRADER_RECEIVE_WINDOWS_INVALID:${options.receiveWindows.length}:${options.traders}`);
  }
  const rootSeed = readFileSync(join(options.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  if (!rootSeed) throw new Error('PRODUCTION_SWAP_LOAD_MESH_ROOT_SEED_MISSING');
  const seeds = deriveLoadLaneSeeds(rootSeed, options.traders, 'trader', options.laneOffset);
  const identities = deriveLoadLaneIdentities(rootSeed, options.traders, 'trader', options.laneOffset);
  const runtimes = await spawnLaneRuntimes({
    workDir: options.workDir,
    portBase: options.portBase,
    identities,
    laneSeeds: seeds,
    laneIndexOffset: options.laneOffset * 2,
  });
  try {
    await provisionLoadPopulation({
      hub: options.hub,
      hubIdentity: options.hubIdentity,
      population: runtimes.map((lane, index) => ({
        lane,
        receiveWindows: options.receiveWindows[index] ?? [],
      })),
    });
    return {
      identities: identities.map(identity => ({ entityId: identity.entityId, signerId: identity.signerId })),
      runtimes,
    };
  } catch (error) {
    await stopLaneRuntimes(runtimes);
    throw error;
  }
};

export type ParallelLoadLaneCohort = Readonly<{
  role: 'maker' | 'taker';
  receiveWindows?: readonly (readonly Readonly<{ tokenId: number; amount: bigint }>[])[];
}>;

type PopulationLane = Readonly<{
  lane: LaneRuntime;
  receiveWindows: readonly Readonly<{ tokenId: number; amount: bigint }>[];
}>;

/**
 * Spawn all load users as one population before provisioning role-specific
 * Accounts. Host packing is deliberately role-blind: maker/taker are workload
 * roles, not Runtime trust boundaries. With 1,000 users and the canonical
 * 200-per-process density this creates exactly five host processes while every
 * user still owns a distinct RuntimeReplica, WAL, signer and direct H1 socket.
 */
export const setupParallelLoadLaneCohorts = async (options: {
  workDir: string;
  portBase: number;
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  lanes: number;
  laneOffset: number;
  cohorts: readonly [ParallelLoadLaneCohort, ParallelLoadLaneCohort];
}): Promise<readonly [
  { identities: LoadIdentity[]; runtimes: LaneRuntime[] },
  { identities: LoadIdentity[]; runtimes: LaneRuntime[] },
]> => {
  const rootSeed = readFileSync(join(options.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  if (!rootSeed) throw new Error('PRODUCTION_SWAP_LOAD_MESH_ROOT_SEED_MISSING');
  const cohortMaterial = options.cohorts.map(cohort => ({
    cohort,
    identities: deriveLoadLaneIdentities(rootSeed, options.lanes, cohort.role, options.laneOffset),
    seeds: deriveLoadLaneSeeds(rootSeed, options.lanes, cohort.role, options.laneOffset),
  }));
  const identities = cohortMaterial.flatMap(material => material.identities);
  const seeds = cohortMaterial.flatMap(material => material.seeds);
  const runtimes = await spawnLaneRuntimes({
    workDir: options.workDir,
    portBase: options.portBase,
    identities,
    laneSeeds: seeds,
    laneIndexOffset: options.laneOffset * 2,
  });
  const firstRuntimes = runtimes.slice(0, options.lanes);
  const secondRuntimes = runtimes.slice(options.lanes);
  try {
    const firstMaterial = cohortMaterial[0];
    const secondMaterial = cohortMaterial[1];
    if (!firstMaterial || !secondMaterial) throw new Error('HLT_LOAD_COHORT_MATERIAL_MISSING');
    await provisionLoadPopulation({
      hub: options.hub,
      hubIdentity: options.hubIdentity,
      population: cohortMaterial.flatMap((material, cohortIndex) => {
        const cohortRuntimes = cohortIndex === 0 ? firstRuntimes : secondRuntimes;
        return cohortRuntimes.map((lane, laneIndex) => ({
          lane,
          receiveWindows: material.cohort.receiveWindows?.[laneIndex] ?? [],
        }));
      }),
    });
    return [{
      identities: firstMaterial.identities.map(identity => ({
        entityId: identity.entityId,
        signerId: identity.signerId,
      })),
      runtimes: firstRuntimes,
    }, {
      identities: secondMaterial.identities.map(identity => ({
        entityId: identity.entityId,
        signerId: identity.signerId,
      })),
      runtimes: secondRuntimes,
    }];
  } catch (error) {
    await stopLaneRuntimes(runtimes);
    throw error;
  }
};

const provisionLoadPopulation = async (options: {
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  population: readonly PopulationLane[];
}): Promise<void> => {
  const { population } = options;
  if (population.length < 1) throw new Error('PRODUCTION_SWAP_LOAD_POPULATION_EMPTY');
  const runtimes = population.map(entry => entry.lane);

  // Runtime admission projects imports before applying EntityInputs, so each
  // user needs one canonical bootstrap input, not the retired import/genesis pair.
  await queueLaneRuntimeInputWave(0, population.map(({ lane }) => ({
    lane,
    input: {
      runtimeTxs: buildLaneImports([lane.identity]),
      entityInputs: buildLaneProfileInputs([lane.identity]),
    },
  })));
  await waitForPopulationEntities(runtimes);

  await Promise.all(runtimes.map(lane => lane.runtime.control.configureP2P({
    relayUrls: [lane.relayUrl],
    advertiseEntityIds: [lane.identity.entityId],
  })));
  // First every user learns H1 and completes its direct handshake. Only then
  // may H1 fetch user profiles: the prior concurrent barrier repeatedly asked
  // for users whose later host processes had not announced yet, exhausting
  // H1's gossip budget and turning readiness into WS_RELAY_FATAL noise.
  await waitForLaneHostReadiness(
    runtimes,
    options.hubIdentity.entityId,
    options.hub.adapter.runtimeId,
    VISIBILITY_TIMEOUT_MS,
  );
  await options.hub.control.waitForDirectRuntimeSessions(
    runtimes.map(lane => lane.runtimeId),
    VISIBILITY_TIMEOUT_MS,
  );
  await waitForHubProfilesSendReady(options.hub, runtimes);

  // All sovereign users open and fund their H1 Account in one host-wide
  // Runtime-input batch. Each Runtime still commits its own independent frame.
  await queueLaneRuntimeInputWave(1, population.map(entry => ({
    lane: entry.lane,
    input: {
      runtimeTxs: [],
      entityInputs: buildLaneAccountInputs(
        [entry.lane.identity],
        options.hubIdentity.entityId,
        entry.receiveWindows,
      ),
    },
  })));
  await waitForLaneFinancialReadiness(population.map(entry => ({
    lane: entry.lane,
    hubEntityId: options.hubIdentity.entityId,
    windows: [
      { tokenId: HLT_FAUCET_TOKEN_ID, minimum: HLT_FAUCET_AMOUNT },
      ...entry.receiveWindows.map(window => ({ tokenId: window.tokenId, minimum: window.amount })),
    ],
  })), 'hub', false);

  // One real H1 Entity frame pays the token-1 faucet to every user. Users grant
  // exactly this receive window while opening the Account; no synthetic H1
  // credit or token-2 faucet can manufacture benchmark inventory.
  await sendObserved(options.hub, `prod-load-faucet-population-${population.length}`, {
    runtimeTxs: [],
    entityInputs: [{
      entityId: options.hubIdentity.entityId,
      signerId: options.hubIdentity.signerId,
      entityTxs: population.map(entry => ({
        type: 'directPayment' as const,
        data: {
          targetEntityId: entry.lane.identity.entityId,
          tokenId: HLT_FAUCET_TOKEN_ID,
          amount: HLT_FAUCET_AMOUNT,
          route: [options.hubIdentity.entityId, entry.lane.identity.entityId],
          deliveryMode: 'direct' as const,
          description: 'HLT $5000 token-1 faucet',
        },
      })),
    }],
  });

  // Final readiness is population-wide and financial: both credit directions
  // must be committed and every self profile must advertise the H1 Account.
  // Promise.all rejects with the exact first lane; no timeout is swallowed.
  await waitForLaneFinancialReadiness(population.map(entry => ({
    lane: entry.lane,
    hubEntityId: options.hubIdentity.entityId,
    windows: [{ tokenId: HLT_FAUCET_TOKEN_ID, minimum: HLT_FAUCET_AMOUNT }],
  })), 'user', true);
  console.log(`[load] population ready users=${population.length}`);
};
