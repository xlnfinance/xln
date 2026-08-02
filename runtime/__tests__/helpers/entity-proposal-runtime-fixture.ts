import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
  signDigest,
} from '../../account/crypto';
import { buildSignedEntityCommand } from '../../entity/command';
import { signedEntityCommandTx } from '../../entity/command-codec';
import { createEntityFrameHashFromStateRoot } from '../../entity/consensus/frame';
import { buildEntityHashesToSign } from '../../entity/consensus/hanko-witness';
import { getEntityLeaderState } from '../../entity/consensus/leader';
import type { EntityFrame } from '../../entity/types';
import { createDirectRuntimeWsRoute } from '../../network/p2p/direct-runtime-bun';
import {
  deserializeWsMessage,
  hashHelloMessage,
  hashRuntimeWsFrame,
  serializeWsMessage,
  type RuntimeWsMessage,
} from '../../network/p2p/ws-protocol';
import {
  deriveEncryptionKeyPair,
  encryptJSON,
  pubKeyToHex,
} from '../../protocol/p2p-crypto';
import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  handleInboundP2PEntityInputs,
  loadEnvFromDB,
  processRuntime,
} from '../../runtime';
import { dbRootPath } from '../../runtime/platform';
import type {
  RuntimeEntityInputsEnvelope,
  RuntimeReplica,
} from '../../runtime/types';
import { signRuntimeEntityInputsEnvelope } from '../../runtime/entity-input-envelope-auth';
import { createEntityProposalFixture } from './entity-proposal-fixture';
import { createTestJReplica } from './j-replica';

const fixtureSeed = 'entity-proposal-runtime-isolation';
export const proposalRuntimeFixture = createEntityProposalFixture(fixtureSeed);
const durableFixtureSeed = `${fixtureSeed}:durable`;
export const durableProposalFixture = createEntityProposalFixture(durableFixtureSeed, 3n);
export const durableProposalRuntimeSeed = `${durableFixtureSeed}:victim-runtime`;

const jurisdiction = {
  name: 'ProposalIsolation',
  address: 'browservm://proposal-isolation',
  chainId: 31_337,
  depositoryAddress: `0x${'41'.repeat(20)}`,
  entityProviderAddress: `0x${'42'.repeat(20)}`,
};
const runtimeIds: string[] = [];
const activeEnvs: RuntimeReplica[] = [];

const cleanupStorage = (runtimeId: string): void => {
  const namespace = join(dbRootPath, runtimeId);
  for (const suffix of [
    '',
    '-storage-current',
    '-storage-previous',
    '-wal',
    '-history-views',
    '-events',
    '-infra',
  ]) {
    rmSync(`${namespace}${suffix}`, { recursive: true, force: true });
  }
};

const createSocketHarness = () => {
  const sent: RuntimeWsMessage[] = [];
  return {
    sent,
    ws: {
      readyState: 1,
      send(raw: string | Uint8Array) {
        sent.push(deserializeWsMessage(raw));
        return true;
      },
      close() {
        this.readyState = 3;
      },
    },
  };
};

const buildAuthenticatedHello = (
  seed: string,
  runtimeId: string,
  challenge: string,
  audience: string,
): RuntimeWsMessage => {
  const timestamp = Date.now();
  const encryptionPubKey = pubKeyToHex(deriveEncryptionKeyPair(seed).publicKey);
  return {
    type: 'hello',
    from: runtimeId,
    fromEncryptionPubKey: encryptionPubKey,
    timestamp,
    audience,
    auth: {
      nonce: challenge,
      timestamp,
      signature: signDigest(
        seed,
        '1',
        hashHelloMessage(runtimeId, encryptionPubKey, timestamp, challenge, audience),
      ),
    },
  };
};

export const installPersistedProposalValidator = async (): Promise<{
  env: RuntimeReplica;
  signerId: string;
}> => {
  const env = createEmptyEnv(durableProposalRuntimeSeed);
  env.runtimeId = env.runtimeId!.toLowerCase();
  env.dbNamespace = env.runtimeId;
  env.scenarioMode = false;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { enabled: true } };
  runtimeIds.push(env.runtimeId);
  activeEnvs.push(env);
  cleanupStorage(env.runtimeId);
  registerSignerKey(
    env,
    env.runtimeId,
    deriveSignerKeySync(durableProposalRuntimeSeed, '1'),
  );
  for (const [index, signerId] of durableProposalFixture.validators.entries()) {
    registerSignerKey(
      env,
      signerId,
      deriveSignerKeySync(durableFixtureSeed, String(index + 1)),
    );
  }
  env.activeJurisdiction = jurisdiction.name;
  env.state.jReplicas.set(jurisdiction.name, createTestJReplica({
    name: jurisdiction.name,
    rpcs: [],
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: `0x${'43'.repeat(20)}`,
      deltaTransformer: `0x${'44'.repeat(20)}`,
    },
  }));
  const signerId = durableProposalFixture.validators[1]!;
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importReplica',
      entityId: durableProposalFixture.entityId,
      signerId,
      data: {
        config: {
          ...durableProposalFixture.createState().config,
          jurisdiction,
        },
        isProposer: false,
        profileName: 'proposal isolation validator',
      },
    }],
    entityInputs: [],
  });
  await processRuntime(env, []);
  return { env, signerId };
};

export const buildAuthenticatedInvalidProposal = (
  env: RuntimeReplica,
  signerId: string,
): EntityFrame => {
  const entityId = durableProposalFixture.entityId;
  const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
  if (!replica) throw new Error('TEST_PROPOSAL_REPLICA_MISSING');
  const proposer = durableProposalFixture.createValidator('1');
  const proposerId = durableProposalFixture.validators[0]!;
  const validCommand = buildSignedEntityCommand(
    proposer.env,
    replica.state,
    proposerId,
    [{ type: 'chat', data: { from: proposerId, message: 'invalid nested command' } }],
  );
  const txs = [signedEntityCommandTx({
    ...validCommand,
    signature: `0x${'00'.repeat(65)}`,
  })];
  const leader = getEntityLeaderState(replica.state);
  const stateRoot = `0x${'51'.repeat(32)}`;
  const authorityRoot = `0x${'52'.repeat(32)}`;
  const height = replica.state.height + 1;
  const timestamp = env.state.timestamp;
  const hash = createEntityFrameHashFromStateRoot(
    'genesis',
    height,
    timestamp,
    txs,
    [],
    entityId,
    stateRoot,
    authorityRoot,
  );
  return {
    height,
    parentFrameHash: 'genesis',
    stateRoot,
    authorityRoot,
    timestamp,
    txs,
    events: [],
    hash,
    leader: {
      proposerSignerId: leader.activeValidatorId,
      view: leader.view,
    },
    hashesToSign: buildEntityHashesToSign(entityId, height, hash),
    collectedSigs: new Map([[
      proposerId,
      [signAccountFrame(proposer.env, proposerId, hash)],
    ]]),
  };
};

export const deliverEncryptedProposal = async (
  env: RuntimeReplica,
  frame: EntityFrame,
): Promise<{
  inboundResults: unknown[];
  remoteRuntimeId: string;
  remoteEnv: RuntimeReplica;
}> => {
  const remoteSeed = `${durableProposalRuntimeSeed}:remote`;
  const remoteRuntimeId = deriveSignerAddressSync(remoteSeed, '1').toLowerCase();
  const inboundResults: unknown[] = [];
  const route = createDirectRuntimeWsRoute({
    runtimeId: env.runtimeId!,
    runtimeSeed: durableProposalRuntimeSeed,
    onEntityInputs: (from, envelope, timestamp) => {
      inboundResults.push(handleInboundP2PEntityInputs(env, from, envelope, timestamp));
    },
  });
  const socket = createSocketHarness();
  route.websocket.open(socket.ws);
  const challenge = socket.sent[0]?.challenge || '';
  const audience = socket.sent[0]?.audience || '';
  if (socket.sent[0]?.type !== 'hello_challenge' || !challenge || !audience) {
    throw new Error('TEST_DIRECT_CHALLENGE_MISSING');
  }
  const hello = buildAuthenticatedHello(remoteSeed, remoteRuntimeId, challenge, audience);
  await route.websocket.message(
    socket.ws,
    serializeWsMessage(hello),
  );
  if (socket.sent.at(-1)?.type !== 'hello_ack') throw new Error('TEST_DIRECT_HELLO_ACK_MISSING');
  const remoteEnv = createEmptyEnv(remoteSeed);
  const envelope: RuntimeEntityInputsEnvelope = signRuntimeEntityInputsEnvelope(remoteEnv, env.runtimeId!, {
    sourceRuntimeId: remoteRuntimeId,
    sourceRuntimeHeight: 1,
    sourceRuntimeTimestamp: 1_000,
    entityInputs: [{
      entityId: durableProposalFixture.entityId,
      signerId: durableProposalFixture.validators[1]!,
      runtimeId: env.runtimeId!,
      proposedFrame: frame,
    }],
  });
  const message: RuntimeWsMessage = {
    type: 'entity_inputs',
    id: 'byzantine-proposal',
    from: remoteRuntimeId,
    fromEncryptionPubKey: pubKeyToHex(deriveEncryptionKeyPair(remoteSeed).publicKey),
    to: env.runtimeId!,
    timestamp: 1_000,
    encrypted: true,
    payload: encryptJSON(envelope, deriveEncryptionKeyPair(durableProposalRuntimeSeed).publicKey),
  };
  const authTimestamp = hello.auth!.timestamp + 1;
  await route.websocket.message(socket.ws, serializeWsMessage({
    ...message,
    auth: {
      nonce: challenge,
      timestamp: authTimestamp,
      signature: signDigest(
        remoteSeed,
        '1',
        hashRuntimeWsFrame(message, audience, challenge, authTimestamp),
      ),
    },
  }));
  return { inboundResults, remoteRuntimeId, remoteEnv };
};

export const restartPersistedProposalValidator = async (
  env: RuntimeReplica,
): Promise<RuntimeReplica> => {
  const trackedIndex = activeEnvs.indexOf(env);
  if (trackedIndex >= 0) activeEnvs.splice(trackedIndex, 1);
  await closeRuntimeDb(env);
  await closeInfraDb(env);
  const restored = await loadEnvFromDB(env.runtimeId!, durableProposalRuntimeSeed);
  if (!restored) throw new Error('TEST_PROPOSAL_RESTART_MISSING');
  activeEnvs.push(restored);
  return restored;
};

export const cleanupPersistedProposalFixtures = async (): Promise<void> => {
  while (activeEnvs.length > 0) {
    const env = activeEnvs.pop()!;
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  }
  while (runtimeIds.length > 0) cleanupStorage(runtimeIds.pop()!);
};
