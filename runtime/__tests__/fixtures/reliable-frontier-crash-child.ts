import { keccak256, toUtf8Bytes } from 'ethers';

import {
  createEmptyEnv,
  saveEnvToDB,
} from '../../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../account/crypto';
import {
  receiverFrontierKey,
  senderFrontierKey,
} from '../../machine/reliable-frontier';
import { applyRuntimeStorageChanges } from '../../machine/env-events';
import { serializeTaggedJson } from '../../protocol/serialization';
import {
  createCatchupFixtureState,
  prepareCatchupFixtureReplica,
  registerCatchupFixtureSigners,
} from './reliable-local-catchup-fixture';
import type {
  DeliverableEntityInput,
  Env,
  ReliableDeliveryIdentity,
  ReliableDeliveryReceipt,
} from '../../types';

const [seed] = Bun.argv.slice(2);
if (!seed) throw new Error('reliable frontier crash seed is required');

const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
const peerRuntimeId = deriveSignerAddressSync(seed, '2').toLowerCase();
const relayRuntimeId = deriveSignerAddressSync(seed, '3').toLowerCase();

const env = createEmptyEnv(seed);
registerSignerKey(env, runtimeId, deriveSignerKeySync(seed, '1'));
registerSignerKey(env, peerRuntimeId, deriveSignerKeySync(seed, '2'));
env.runtimeId = runtimeId;
env.dbNamespace = runtimeId;
env.quietRuntimeLogs = true;
env.runtimeConfig = {
  ...env.runtimeConfig,
  storage: {
    enabled: true,
    snapshotPeriodFrames: 1,
    retainSnapshots: 1,
    epochMaxBytes: 1_000_000_000,
    frameDbMaxBytes: 1,
    frameDbRetainFrames: 1,
    materializePeriodFrames: 1_000,
    canonicalHashPeriodFrames: 1,
    accountMerkleRadix: 16,
  },
};
// Storage restore requires an authoritative Entity root. Use the same real
// two-validator profile certificate as the catch-up crash fixture; the Entity
// itself is intentionally inert because this test targets reliable frontiers.
const authority = registerCatchupFixtureSigners(env, `${seed}:frontier-authority`);
const authorityState = createCatchupFixtureState(
  authority.leaderSignerId,
  authority.targetSignerId,
);
await prepareCatchupFixtureReplica(
  env,
  authorityState,
  authority.leaderSignerId,
  authority.targetSignerId,
);
applyRuntimeStorageChanges(env, [{ family: 'entity', entityId: authorityState.entityId }]);
env.height = 1;
env.timestamp = 1;
await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, []);
env.height = 2;
env.timestamp = 2;

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const signerId = (byte: string): string => `0x${byte.repeat(20)}`;
const digest = (byte: string): string => `0x${byte.repeat(32)}`;

const identity = (
  lane: string,
  height: number,
  evidenceKind: ReliableDeliveryIdentity['evidenceKind'],
): ReliableDeliveryIdentity => ({
  kind: 'entity-frame',
  entityId: entityId(lane),
  signerId: signerId(lane),
  laneKey: `entity-frame:${entityId(lane)}:${signerId(lane)}`,
  height,
  frameHash: digest(height.toString(16).padStart(2, '0')),
  logicalKey: `entity-frame:${height}`,
  evidenceVersion: 1,
  evidenceKind,
  evidenceDigest: digest(evidenceKind === 'entity-certificate' ? 'ce' : 'ac'),
  bodyDigest: digest(lane),
});

const receipt = (
  signerEnv: Env,
  receiverRuntimeId: string,
  value: ReliableDeliveryIdentity,
  coverage: ReliableDeliveryReceipt['body']['coverage'],
): ReliableDeliveryReceipt => {
  const body: ReliableDeliveryReceipt['body'] = {
    version: 2,
    coverage,
    receiverRuntimeId,
    identity: value,
    appliedRuntimeHeight: env.height,
  };
  const bodyDigest = keccak256(toUtf8Bytes(serializeTaggedJson(body))).toLowerCase();
  return {
    body,
    signature: signAccountFrame(signerEnv, receiverRuntimeId, bodyDigest),
  };
};

const ingressTerminalIdentity = identity('a1', 10, 'entity-certificate');
const ingressActiveIdentity = identity('a1', 11, 'entity-proposal');
const senderTerminalIdentity = identity('b1', 20, 'entity-certificate');
const senderActiveIdentity = identity('b1', 21, 'entity-proposal');

const ingressTerminal = receipt(env, runtimeId, ingressTerminalIdentity, 'terminal');
const ingressActive = receipt(env, runtimeId, ingressActiveIdentity, 'exact');
const senderTerminal = receipt(env, peerRuntimeId, senderTerminalIdentity, 'terminal');
const senderActive = receipt(env, peerRuntimeId, senderActiveIdentity, 'exact');

env.runtimeState ??= {};
env.runtimeState.reliableIngressTerminalWatermarks = new Map([
  [receiverFrontierKey(peerRuntimeId, ingressTerminalIdentity), ingressTerminal],
  [receiverFrontierKey(relayRuntimeId, ingressTerminalIdentity), ingressTerminal],
]);
env.runtimeState.reliableIngressReceiptLedger = new Map([
  [receiverFrontierKey(peerRuntimeId, ingressActiveIdentity), ingressActive],
]);
env.runtimeState.receivedReliableTerminalWatermarks = new Map([
  [senderFrontierKey(senderTerminal), senderTerminal],
]);
env.runtimeState.receivedReliableReceiptLedger = new Map([
  [senderFrontierKey(senderActive), senderActive],
]);

const pendingHeight = 22;
env.pendingNetworkOutputs = [{
  runtimeId: peerRuntimeId,
  entityId: senderActiveIdentity.entityId,
  signerId: senderActiveIdentity.signerId,
  proposedFrame: {
    height: pendingHeight,
    parentFrameHash: digest('21'),
    stateRoot: digest('23'),
    authorityRoot: digest('24'),
    timestamp: pendingHeight,
    hash: digest('22'),
    txs: [],
    leader: { proposerSignerId: senderActiveIdentity.signerId, view: 0 },
    collectedSigs: new Map(),
  },
} satisfies DeliverableEntityInput];

await saveEnvToDB(env, { runtimeTxs: [], entityInputs: [] }, env.pendingNetworkOutputs);
process.kill(process.pid, 'SIGKILL');
throw new Error('SIGKILL did not stop reliable frontier crash child');
