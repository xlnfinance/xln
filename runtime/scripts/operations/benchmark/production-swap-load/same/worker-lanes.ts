/** Deterministic setup for many real user Entity/Account lanes on one load Runtime. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { defaultAccountDisputeConfigForRoleEvidence } from '../../../../../account/config/dispute-config';
import {
  DaemonControlClient,
  deriveManagedEntityIdentity,
  type ManagedEntityIdentity,
} from '../../../../../orchestrator/daemon-control';
import { deriveMeshChildSeed } from '../../../../../orchestrator/mesh/mesh-seeds';
import { importEntity } from '../../../../../runtime/registration/entity-creation';
import type { RuntimeInput } from '../../../../../runtime/types';
import { decodeEntitySummaries, type LoadIdentity } from '../boundary/worker-boundary';
import {
  sendObserved,
  waitForCredit,
  type ConnectedRuntime,
} from '../worker-runtime';

export const MAX_LOAD_ORDERS_PER_ACCOUNT_FRAME = 5;
const CONTROL_CONCURRENCY = 32;
const VISIBILITY_TIMEOUT_MS = 60_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const distributeLoadOrders = (swaps: number, lanes: number): number[] => {
  if (!Number.isSafeInteger(swaps) || swaps < 1 || !Number.isSafeInteger(lanes) || lanes < 1) {
    throw new Error('PRODUCTION_SWAP_LOAD_LANE_DISTRIBUTION_INVALID');
  }
  if (swaps > lanes * MAX_LOAD_ORDERS_PER_ACCOUNT_FRAME) {
    throw new Error('PRODUCTION_SWAP_LOAD_LANE_DISTRIBUTION_EXCEEDS_FRAME_CAP');
  }
  const ordersPerLane = Math.floor(swaps / lanes);
  const lanesWithOneMoreOrder = swaps % lanes;
  return Array.from(
    { length: lanes },
    (_, index) => ordersPerLane + (index < lanesWithOneMoreOrder ? 1 : 0),
  );
};

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

export const deriveLoadLaneIdentities = (
  meshRootSeed: string,
  lanes: number,
  role: 'maker' | 'taker' = 'taker',
): ManagedEntityIdentity[] => Array.from({ length: lanes }, (_, index) => deriveManagedEntityIdentity({
  name: `Load ${role === 'maker' ? 'Maker' : 'Taker'} ${String(index + 1).padStart(4, '0')}`,
  seed: deriveMeshChildSeed(
    meshRootSeed,
    role === 'taker'
      ? `production-swap-load:lane:${index + 1}`
      : `production-swap-load:maker-lane:${index + 1}`,
  ),
  signerLabel: 'owner',
  position: { x: index % 32, y: Math.floor(index / 32), z: 0 },
}));

const runInBatches = async <T>(
  values: readonly T[],
  effect: (value: T, index: number) => Promise<void>,
): Promise<void> => {
  for (let offset = 0; offset < values.length; offset += CONTROL_CONCURRENCY) {
    await Promise.all(
      values
        .slice(offset, offset + CONTROL_CONCURRENCY)
        .map((value, batchIndex) => effect(value, offset + batchIndex)),
    );
  }
};

const waitForVisibleEntities = async (
  runtime: ConnectedRuntime,
  entityIds: readonly string[],
  code: string,
): Promise<void> => {
  const required = new Set(entityIds);
  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const visible = new Set(
      decodeEntitySummaries(await runtime.adapter.read<unknown>('entities')).map(entity => entity.entityId),
    );
    if (Array.from(required).every(entityId => visible.has(entityId))) return;
    await sleep(100);
  }
  throw new Error(code);
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
  hub: ConnectedRuntime;
  load: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  lanes: number;
  role: 'maker' | 'taker';
  laneGrantedCreditTokenId: number;
  laneGrantedCreditAmounts: readonly bigint[];
  hubGrantedCreditTokenId: number;
  hubGrantedCreditAmounts: readonly bigint[];
}): Promise<LoadIdentity[]> => {
  const rootSeed = readFileSync(join(options.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  if (!rootSeed) throw new Error('PRODUCTION_SWAP_LOAD_MESH_ROOT_SEED_MISSING');
  const identities = deriveLoadLaneIdentities(rootSeed, options.lanes, options.role);
  if (
    options.laneGrantedCreditAmounts.length !== identities.length ||
    options.hubGrantedCreditAmounts.length !== identities.length
  ) {
    throw new Error('PRODUCTION_SWAP_LOAD_LANE_CREDIT_CARDINALITY_INVALID');
  }
  const control = new DaemonControlClient({
    // Custody's manifest entry may point at its user-facing service while the
    // load worker deliberately connects to the authenticated daemon endpoint.
    baseUrl: connectedRuntimeHttpBase(options.load),
    authKey: options.load.entry.token,
    timeoutMs: 30_000,
  });
  await runInBatches(identities, identity => control.registerSigner(identity.signerId, identity.privateKeyHex));
  const existing = new Set((await control.listEntities()).map(entity => entity.entityId));
  const missing = identities.filter(identity => !existing.has(identity.entityId));
  if (missing.length > 0) {
    await sendObserved(options.load, `prod-load-import-${options.role}-${options.lanes}`, {
      runtimeTxs: buildLaneImports(missing), entityInputs: [],
    });
  }
  await waitForVisibleEntities(options.load, identities.map(identity => identity.entityId), 'PRODUCTION_SWAP_LOAD_LANES_NOT_IMPORTED');
  const localEntityIds = (await control.listEntities()).map(entity => entity.entityId).sort();
  await control.configureP2P({ advertiseEntityIds: localEntityIds, gossipPollMs: 250 });
  await waitForVisibleEntities(options.hub, identities.map(identity => identity.entityId), 'PRODUCTION_SWAP_LOAD_LANE_PROFILES_NOT_VISIBLE');
  await sendObserved(options.load, `prod-load-open-${options.role}-${options.lanes}`, {
    runtimeTxs: [],
    entityInputs: buildLaneAccountInputs(
      identities,
      options.hubIdentity.entityId,
      options.laneGrantedCreditTokenId,
      options.laneGrantedCreditAmounts,
    ),
  });
  await runInBatches(identities, (identity, index) => {
    return waitForCredit(
      options.hub,
      options.hubIdentity.entityId,
      identity.entityId,
      options.laneGrantedCreditTokenId,
      options.laneGrantedCreditAmounts[index]!,
    );
  });
  await sendObserved(options.hub, `prod-load-credit-${options.role}-lanes-${options.lanes}`, {
    runtimeTxs: [],
    entityInputs: [{
      entityId: options.hubIdentity.entityId,
      signerId: options.hubIdentity.signerId,
      entityTxs: identities.map((identity, index) => ({
        type: 'extendCredit' as const,
        data: {
          counterpartyEntityId: identity.entityId,
          tokenId: options.hubGrantedCreditTokenId,
          amount: options.hubGrantedCreditAmounts[index]!,
        },
      })),
    }],
  });
  await runInBatches(identities, (identity, index) => {
    return waitForCredit(
      options.load,
      identity.entityId,
      options.hubIdentity.entityId,
      options.hubGrantedCreditTokenId,
      options.hubGrantedCreditAmounts[index]!,
    );
  });
  return identities.map(identity => ({ entityId: identity.entityId, signerId: identity.signerId }));
};
