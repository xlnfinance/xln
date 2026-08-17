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

const CONTROL_CONCURRENCY = 4;
const CONTROL_BATCH_PAUSE_MS = 100;
// Non-reliable route identity retains the complete transaction fingerprints.
// Keep setup frames below the 10 KB durable Runtime-machine row limit: the
// observed 50-Account shape encoded to 21,598 bytes, while 16 leaves headroom.
const PROVISIONING_ACCOUNTS_PER_FRAME = 16;
const VISIBILITY_TIMEOUT_MS = 60_000;
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

export const deriveLoadLaneIdentities = (
  meshRootSeed: string,
  lanes: number,
  role: 'maker' | 'taker' = 'taker',
  laneOffset = 0,
): ManagedEntityIdentity[] => Array.from({ length: lanes }, (_, index) => {
  const laneNumber = laneOffset + index + 1;
  return deriveManagedEntityIdentity({
  name: `Load ${role === 'maker' ? 'Maker' : 'Taker'} ${String(laneNumber).padStart(4, '0')}`,
  seed: deriveMeshChildSeed(
    meshRootSeed,
    role === 'taker'
      ? `production-swap-load:lane:${laneNumber}`
      : `production-swap-load:maker-lane:${laneNumber}`,
  ),
  signerLabel: 'owner',
  position: { x: index % 32, y: Math.floor(index / 32), z: 0 },
  });
});

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
  laneOffset: number;
  role: 'maker' | 'taker';
  laneGrantedCreditTokenId: number;
  laneGrantedCreditAmounts: readonly bigint[];
  hubGrantedCreditTokenId: number;
  hubGrantedCreditAmounts: readonly bigint[];
}): Promise<LoadIdentity[]> => {
  const rootSeed = readFileSync(join(options.workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  if (!rootSeed) throw new Error('PRODUCTION_SWAP_LOAD_MESH_ROOT_SEED_MISSING');
  const identities = deriveLoadLaneIdentities(rootSeed, options.lanes, options.role, options.laneOffset);
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
    await sendObserved(options.load, `prod-load-import-${options.role}-${options.laneOffset}-${options.lanes}`, {
      runtimeTxs: buildLaneImports(missing), entityInputs: [],
    });
  }
  await waitForVisibleEntities(options.load, identities.map(identity => identity.entityId), 'PRODUCTION_SWAP_LOAD_LANES_NOT_IMPORTED');
  const localEntityIds = (await control.listEntities()).map(entity => entity.entityId).sort();
  await control.configureP2P({ advertiseEntityIds: localEntityIds, gossipPollMs: 250 });
  await waitForVisibleEntities(options.hub, identities.map(identity => identity.entityId), 'PRODUCTION_SWAP_LOAD_LANE_PROFILES_NOT_VISIBLE');
  let laneOffset = 0;
  const accountBatches = partitionLoadProvisioningBatches(identities);
  for (let batchIndex = 0; batchIndex < accountBatches.length; batchIndex += 1) {
    const batch = accountBatches[batchIndex]!;
    const laneCredits = options.laneGrantedCreditAmounts.slice(laneOffset, laneOffset + batch.length);
    const hubCredits = options.hubGrantedCreditAmounts.slice(laneOffset, laneOffset + batch.length);
    await sendObserved(options.load, `prod-load-open-${options.role}-${options.laneOffset}-${options.lanes}-${batchIndex + 1}`, {
      runtimeTxs: [],
      entityInputs: buildLaneAccountInputs(
        batch,
        options.hubIdentity.entityId,
        options.laneGrantedCreditTokenId,
        laneCredits,
      ),
    });
    await runInBatches(batch, (identity, index) => waitForCredit(
      options.hub,
      options.hubIdentity.entityId,
      identity.entityId,
      options.laneGrantedCreditTokenId,
      laneCredits[index]!,
    ));
    await sendObserved(options.hub, `prod-load-credit-${options.role}-${options.laneOffset}-${options.lanes}-${batchIndex + 1}`, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: options.hubIdentity.entityId,
        signerId: options.hubIdentity.signerId,
        entityTxs: batch.map((identity, index) => ({
          type: 'extendCredit' as const,
          data: {
            counterpartyEntityId: identity.entityId,
            tokenId: options.hubGrantedCreditTokenId,
            amount: hubCredits[index]!,
          },
        })),
      }],
    });
    await runInBatches(batch, (identity, index) => waitForCredit(
      options.load,
      identity.entityId,
      options.hubIdentity.entityId,
      options.hubGrantedCreditTokenId,
      hubCredits[index]!,
    ));
    laneOffset += batch.length;
  }
  return identities.map(identity => ({ entityId: identity.entityId, signerId: identity.signerId }));
};
