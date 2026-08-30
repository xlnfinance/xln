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
  configureLanePopulationP2P,
  HLT_SETUP_RUNTIME_INPUT_CHUNK_ENTRIES,
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
import type { LoadIdentity } from '../boundary/worker-boundary';
import { sendObserved, type ConnectedRuntime } from '../worker-runtime';

const VISIBILITY_TIMEOUT_MS = 20_000;
export const HLT_FAUCET_TOKEN_ID = 1;
export const HLT_FAUCET_AMOUNT = 5_000n * 10n ** BigInt(getTokenInfo(HLT_FAUCET_TOKEN_ID).decimals);
export const HLT_USER_RECEIVE_WINDOW = HLT_FAUCET_AMOUNT * 2n;

export type LoadLaneRole = 'maker' | 'taker' | 'trader';
export type LoadReceiveWindow = Readonly<{
  tokenId: number;
  amount: bigint;
  initialAmount?: bigint;
}>;

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
  additionalReceiveWindows: readonly LoadReceiveWindow[] = [],
  faucetAmount = HLT_FAUCET_AMOUNT,
): RuntimeInput['entityInputs'] => identities.map(identity => {
  // Put every user at the midpoint of its bilateral window. Using a window
  // equal to the derived faucet would place every Account at its endpoint, so
  // H1 would correctly reject the first forwarded HTLC.
  const receiveWindows = new Map<number, bigint>([[HLT_FAUCET_TOKEN_ID, faucetAmount * 2n]]);
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
        r2cRequestSoftLimit: faucetAmount,
        hardLimit: faucetAmount,
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

type ParallelLoadLaneSetup = Readonly<{
  identities: LoadIdentity[];
  runtimes: LaneRuntime[];
}>;

export const spawnParallelLoadLanes = async (options: {
  workDir: string;
  portBase: number;
  hubIdentity: LoadIdentity;
  lanes: number;
  laneOffset: number;
  role: 'maker' | 'taker';
}): Promise<ParallelLoadLaneSetup> => {
  const rootSeed = readFileSync(join(options.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  if (!rootSeed) throw new Error('PRODUCTION_SWAP_LOAD_MESH_ROOT_SEED_MISSING');
  const seeds = deriveLoadLaneSeeds(rootSeed, options.lanes, options.role, options.laneOffset);
  const identities = deriveLoadLaneIdentities(rootSeed, options.lanes, options.role, options.laneOffset);
  // Every lane is a sovereign Runtime. Hosts only share an OS process in
  // bounded groups (200 by default, operator-selectable up to 1000).
  const spawnStartedAt = performance.now();
  const runtimes = await spawnLaneRuntimes({
    workDir: options.workDir,
    portBase: options.portBase,
    identities,
    laneSeeds: seeds,
    // `laneOffset` already gives every population a disjoint port interval.
    // Reserving a second, nonexistent maker interval for payment takers doubled
    // the required port space and rejected a valid 5k population at index 8200.
    laneIndexOffset: options.laneOffset,
    // Payment HLT uses authenticated host-wide admission/readiness endpoints;
    // its financial traffic still crosses each Runtime's own P2P socket.
    connectRuntimeAdapters: false,
  });
  console.log(
    `[load] population-phase=runtimes-connected users=${runtimes.length} ` +
    `elapsedMs=${Math.ceil(performance.now() - spawnStartedAt)}`,
  );
  await queueLaneRuntimeInputWave(0, runtimes.map(lane => ({
    lane,
    input: {
      runtimeTxs: buildLaneImports([lane.identity]),
      entityInputs: buildLaneProfileInputs([lane.identity]),
    },
  })), { maxEntriesPerHostRequest: HLT_SETUP_RUNTIME_INPUT_CHUNK_ENTRIES });
  console.log(
    `[load] population-phase=bootstrap-input-acked users=${runtimes.length} ` +
    `elapsedMs=${Math.ceil(performance.now() - spawnStartedAt)}`,
  );
  return {
    identities: identities.map(identity => ({ entityId: identity.entityId, signerId: identity.signerId })),
    runtimes,
  };
};

export const prepareParallelLoadLanes = async (options: {
  workDir: string;
  portBase: number;
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  lanes: number;
  laneOffset: number;
  role: 'maker' | 'taker';
}): Promise<ParallelLoadLaneSetup> => {
  const setup = await spawnParallelLoadLanes(options);
  try {
    await connectLoadPopulationNetwork({
      hub: options.hub,
      hubIdentity: options.hubIdentity,
      population: setup.runtimes.map(lane => ({ lane, receiveWindows: [] })),
    });
    return setup;
  } catch (error) {
    // A failed provisioning step must not leave daemons listening on the lane
    // ports: the next run would connect to a halted stranger on :21000.
    await stopLaneRuntimes(setup.runtimes);
    throw error;
  }
};

export const provisionParallelLoadLaneAccounts = async (options: Readonly<{
  hubIdentity: LoadIdentity;
  runtimes: readonly LaneRuntime[];
  commitHubInput: (commandId: string, input: RuntimeInput) => Promise<unknown>;
}>): Promise<void> => provisionLoadPopulationFinancial({
  hubIdentity: options.hubIdentity,
  population: options.runtimes.map(lane => ({ lane, receiveWindows: [] })),
  commitHubInput: options.commitHubInput,
});

export const setupParallelLoadLanes = async (options: {
  workDir: string;
  portBase: number;
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  lanes: number;
  laneOffset: number;
  role: 'maker' | 'taker';
}): Promise<ParallelLoadLaneSetup> => {
  const setup = await prepareParallelLoadLanes(options);
  try {
    await provisionParallelLoadLaneAccounts({
      hubIdentity: options.hubIdentity,
      runtimes: setup.runtimes,
      commitHubInput: async (commandId, input) => {
        await sendObserved(options.hub, commandId, input);
      },
    });
    return setup;
  } catch (error) {
    await stopLaneRuntimes(setup.runtimes);
    throw error;
  }
};

/** One role-free population: every user is funded to trade both token sides. */
export const setupParallelLoadTraderPopulation = async (options: {
  workDir: string;
  portBase: number;
  hub?: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  traders: number;
  laneOffset: number;
  receiveWindows: readonly (readonly LoadReceiveWindow[])[];
  faucetAmounts?: readonly bigint[];
  connectRuntimeAdapters?: boolean;
  provisionPopulation?: (
    runtimes: readonly LaneRuntime[],
    receiveWindows: readonly (readonly LoadReceiveWindow[])[],
    faucetAmounts?: readonly bigint[],
  ) => Promise<void>;
}): Promise<{ identities: LoadIdentity[]; runtimes: LaneRuntime[] }> => {
  if (
    options.receiveWindows.length !== options.traders ||
    (options.faucetAmounts !== undefined && options.faucetAmounts.length !== options.traders)
  ) {
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
    ...(options.connectRuntimeAdapters === undefined
      ? {}
      : { connectRuntimeAdapters: options.connectRuntimeAdapters }),
  });
  try {
    await queueLaneRuntimeInputWave(0, runtimes.map(lane => ({
      lane,
      input: {
        runtimeTxs: buildLaneImports([lane.identity]),
        entityInputs: buildLaneProfileInputs([lane.identity]),
      },
    })), { maxEntriesPerHostRequest: HLT_SETUP_RUNTIME_INPUT_CHUNK_ENTRIES });
    if (options.provisionPopulation) {
      await options.provisionPopulation(runtimes, options.receiveWindows, options.faucetAmounts);
    } else {
      if (!options.hub) throw new Error('HLT_TS_HUB_REQUIRED');
      await provisionLoadPopulation({
        hub: options.hub,
        hubIdentity: options.hubIdentity,
        population: runtimes.map((lane, index) => ({
          lane,
          receiveWindows: options.receiveWindows[index] ?? [],
          ...(options.faucetAmounts?.[index] === undefined
            ? {}
            : { faucetAmount: options.faucetAmounts[index] }),
        })),
      });
    }
    return {
      identities: identities.map(identity => ({ entityId: identity.entityId, signerId: identity.signerId })),
      runtimes,
    };
  } catch (error) {
    await stopLaneRuntimes(runtimes);
    throw error;
  }
};

export const provisionParallelLoadTraderAccounts = async (options: Readonly<{
  hubIdentity: LoadIdentity;
  runtimes: readonly LaneRuntime[];
  receiveWindows: readonly (readonly LoadReceiveWindow[])[];
  faucetAmounts?: readonly bigint[];
  commitHubInput: (commandId: string, input: RuntimeInput) => Promise<unknown>;
}>): Promise<void> => {
  if (
    options.receiveWindows.length !== options.runtimes.length ||
    (options.faucetAmounts !== undefined && options.faucetAmounts.length !== options.runtimes.length)
  ) {
    throw new Error(`HLT_TRADER_RECEIVE_WINDOWS_INVALID:${options.receiveWindows.length}:${options.runtimes.length}`);
  }
  await provisionLoadPopulationFinancial({
    hubIdentity: options.hubIdentity,
    population: options.runtimes.map((lane, index) => ({
      lane,
      receiveWindows: options.receiveWindows[index] ?? [],
      ...(options.faucetAmounts?.[index] === undefined
        ? {}
        : { faucetAmount: options.faucetAmounts[index] }),
    })),
    commitHubInput: options.commitHubInput,
  });
};

export type ParallelLoadLaneCohort = Readonly<{
  role: 'maker' | 'taker';
  receiveWindows?: readonly (readonly LoadReceiveWindow[])[];
}>;

type PopulationLane = Readonly<{
  lane: LaneRuntime;
  receiveWindows: readonly LoadReceiveWindow[];
  faucetAmount?: bigint;
}>;

/**
 * Spawn all load users as one population before provisioning role-specific
 * Accounts. Host packing is deliberately role-blind: maker/taker are workload
 * roles, not Runtime trust boundaries. With 1,000 users and the canonical
 * 200-per-process density this creates exactly five host processes while every
 * user still owns a distinct RuntimeReplica, signer and direct H1 socket. Load
 * user state is RAM-only; only the Hub under test owns a production WAL.
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
  await prepareLoadPopulationNetwork(options);
  await provisionLoadPopulationFinancial({
    hubIdentity: options.hubIdentity,
    population: options.population,
    commitHubInput: async (commandId, input) => {
      await sendObserved(options.hub, commandId, input);
    },
  });
};

const prepareLoadPopulationNetwork = async (options: {
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  population: readonly PopulationLane[];
}): Promise<void> => {
  const { population } = options;
  if (population.length < 1) throw new Error('PRODUCTION_SWAP_LOAD_POPULATION_EMPTY');
  const setupStartedAt = performance.now();
  const phase = (name: string): void => console.log(
    `[load] population-phase=${name} users=${population.length} elapsedMs=${Math.ceil(performance.now() - setupStartedAt)}`,
  );

  // Runtime admission projects imports before applying EntityInputs, so each
  // user needs one canonical bootstrap input, not the retired import/genesis pair.
  await queueLaneRuntimeInputWave(0, population.map(({ lane }) => ({
    lane,
    input: {
      runtimeTxs: buildLaneImports([lane.identity]),
      entityInputs: buildLaneProfileInputs([lane.identity]),
    },
  })), { maxEntriesPerHostRequest: HLT_SETUP_RUNTIME_INPUT_CHUNK_ENTRIES });
  phase('bootstrap-input-acked');
  await connectLoadPopulationNetwork(options, setupStartedAt);
};

const connectLoadPopulationNetwork = async (options: {
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  population: readonly PopulationLane[];
}, setupStartedAt = performance.now()): Promise<void> => {
  const { population } = options;
  const runtimes = population.map(entry => entry.lane);
  const phase = (name: string): void => console.log(
    `[load] population-phase=${name} users=${population.length} elapsedMs=${Math.ceil(performance.now() - setupStartedAt)}`,
  );
  await configureLanePopulationP2P(runtimes);
  phase('p2p-configured');
  // Fetch one already-signed canonical H1 profile from H1 itself. Every user
  // still verifies those exact bytes and performs its own direct handshake;
  // repeating the same relay lookup once per worker only creates setup load.
  const hubProfile = await options.hub.control.gossipProfile(options.hubIdentity.entityId);
  if (!hubProfile || hubProfile.runtimeId?.toLowerCase() !== options.hub.adapter.runtimeId.toLowerCase()) {
    throw new Error(`PRODUCTION_SWAP_LOAD_HUB_PROFILE_NOT_SEND_READY:${options.hubIdentity.entityId}`);
  }
  await waitForLaneHostReadiness(
    runtimes,
    options.hubIdentity.entityId,
    options.hub.adapter.runtimeId,
    VISIBILITY_TIMEOUT_MS,
    hubProfile,
  );
  phase('user-to-hub-ready');
  await options.hub.control.waitForDirectRuntimeSessions(
    runtimes.map(lane => lane.runtimeId),
    VISIBILITY_TIMEOUT_MS,
  );
  phase('hub-sessions-ready');
  await waitForHubProfilesSendReady(options.hub, runtimes);
  phase('hub-profiles-ready');
};

const provisionLoadPopulationFinancial = async (options: Readonly<{
  hubIdentity: LoadIdentity;
  population: readonly PopulationLane[];
  commitHubInput: (commandId: string, input: RuntimeInput) => Promise<unknown>;
}>): Promise<void> => {
  const { population } = options;
  if (population.length < 1) throw new Error('PRODUCTION_SWAP_LOAD_POPULATION_EMPTY');
  const setupStartedAt = performance.now();
  const phase = (name: string): void => console.log(
    `[load] population-phase=${name} users=${population.length} elapsedMs=${Math.ceil(performance.now() - setupStartedAt)}`,
  );
  // Account output signing requires the H1 profile learned above. Moving this
  // before gossip correctly fails closed with SIGNER_RESOLUTION_FAILED.
  await queueLaneRuntimeInputWave(1, population.map(entry => ({
    lane: entry.lane,
    input: {
      runtimeTxs: [],
      entityInputs: buildLaneAccountInputs(
        [entry.lane.identity],
        options.hubIdentity.entityId,
        entry.receiveWindows,
        entry.faucetAmount ?? HLT_FAUCET_AMOUNT,
      ),
    },
  })), { maxEntriesPerHostRequest: HLT_SETUP_RUNTIME_INPUT_CHUNK_ENTRIES });
  phase('account-open-input-acked');

  await waitForLaneFinancialReadiness(population.map(entry => ({
    lane: entry.lane,
    hubEntityId: options.hubIdentity.entityId,
    windows: [
      { tokenId: HLT_FAUCET_TOKEN_ID, minimum: entry.faucetAmount ?? HLT_FAUCET_AMOUNT },
      ...entry.receiveWindows.map(window => ({ tokenId: window.tokenId, minimum: window.amount })),
    ],
  })), 'hub', false);
  phase('hub-accounts-ready');

  // Every user receives the real token-1 faucet. Ask-side token-2 capacity is
  // ordinary bilateral credit granted by H1, not a hidden user swap or a
  // second payment delivery. Both are setup Account transactions.
  const setupTxs = population.flatMap(entry => [{
      type: 'directPayment' as const,
      data: {
        targetEntityId: entry.lane.identity.entityId,
        tokenId: HLT_FAUCET_TOKEN_ID,
        amount: entry.faucetAmount ?? HLT_FAUCET_AMOUNT,
        route: [options.hubIdentity.entityId, entry.lane.identity.entityId],
        deliveryMode: 'direct' as const,
        description: 'HLT token-1 faucet',
      },
    }, ...entry.receiveWindows.flatMap(window => {
      const amount = window.initialAmount ?? 0n;
      return amount > 0n ? [{
        type: 'extendCredit' as const,
        data: {
          counterpartyEntityId: entry.lane.identity.entityId,
          tokenId: window.tokenId,
          amount,
        },
      }] : [];
    })]);
  await options.commitHubInput(`prod-load-faucet-population-${population.length}`, {
    runtimeTxs: [],
    entityInputs: [{
      entityId: options.hubIdentity.entityId,
      signerId: options.hubIdentity.signerId,
      entityTxs: setupTxs,
    }],
  });
  phase('faucet-input-committed');

  // Final readiness is population-wide and financial: both credit directions
  // must be committed and every self profile must advertise the H1 Account.
  // Promise.all rejects with the exact first lane; no timeout is swallowed.
  await waitForLaneFinancialReadiness(population.map(entry => ({
    lane: entry.lane,
    hubEntityId: options.hubIdentity.entityId,
    windows: [
      { tokenId: HLT_FAUCET_TOKEN_ID, minimum: entry.faucetAmount ?? HLT_FAUCET_AMOUNT },
      ...entry.receiveWindows.flatMap(window => {
        const initialAmount = window.initialAmount ?? 0n;
        return initialAmount > 0n ? [{ tokenId: window.tokenId, minimum: initialAmount }] : [];
      }),
    ],
  })), 'user', true);
  phase('user-financial-ready');
};
