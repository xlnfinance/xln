import { describe, expect, test } from 'bun:test';

import { applyAccountInput } from '../account/consensus';
import type { AccountConsensusContext } from '../account/consensus/context';
import { createFrameHash } from '../account/consensus/frame';
import { computeAccountStateRoot } from '../account/state-root';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import type { AccountInput, AccountReplica } from '../types/account';
import { safeStringify } from '../protocol/serialization';
import { createEmptyEnv } from '../runtime';
import { createAccountConsensusContext } from '../entity/account-consensus-context';
import { createEntityProposalFixture } from './helpers/entity-proposal-fixture';
import { applyMergedEntityInputs } from '../runtime/entity-inputs';
import { buildSignedEntityCommand } from '../entity/command';
import { signedEntityCommandTx } from '../entity/command-codec';
import { createDisputeProofHashWithNonce } from '../protocol/dispute/proof-builder';
import { LIMITS } from '../config/constants';

const leftEntity = `0x${'11'.repeat(32)}`;
const rightEntity = `0x${'22'.repeat(32)}`;
const watchSeed = `0x${'33'.repeat(32)}`;
const domain = {
  chainId: 31_337,
  depositoryAddress: `0x${'44'.repeat(20)}`,
};

const createAccount = (localEntity = leftEntity, peerEntity = rightEntity): AccountReplica => {
  const account: AccountReplica = {
    state: {
      leftEntity: localEntity < peerEntity ? localEntity : peerEntity,
      rightEntity: localEntity < peerEntity ? peerEntity : localEntity,
      domain: { ...domain },
      watchSeed,
      deltas: new Map(),
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map(),
      globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
      jNonce: 0,
      requestedRebalance: new Map(),
      requestedRebalanceFeeState: new Map(),
    },
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: '',
      deltas: [],
      stateHash: '',
      byLeft: localEntity < peerEntity,
    },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: {
      fromEntity: localEntity,
      toEntity: peerEntity,
      nextProofNonce: 1,
    },
    proofBody: { tokenIds: [], deltas: [] },
    pendingWithdrawals: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  };
  account.currentFrame.accountStateRoot = computeAccountStateRoot(account.state);
  return account;
};

const ackInput = (account: AccountReplica): Extract<AccountInput, { kind: 'ack' }> => ({
  kind: 'ack',
  fromEntityId: account.proofHeader.toEntity,
  toEntityId: account.proofHeader.fromEntity,
  domain: { ...account.state.domain },
  watchSeed: account.state.watchSeed,
  ack: {
    height: 1,
    frameHash: `0x${'55'.repeat(32)}`,
    frameHanko: `0x${'66'.repeat(65)}`,
  },
});

const withVerifier = (
  context: AccountConsensusContext,
  verifyHanko: AccountConsensusContext['verifyHanko'],
): AccountConsensusContext => ({ ...context, verifyHanko });

const installPendingFrame = (account: AccountReplica): void => {
  account.pendingFrame = {
    height: 1,
    timestamp: 1,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: computeAccountStateRoot(account.state),
    deltas: [],
    stateHash: `0x${'55'.repeat(32)}`,
    byLeft: account.proofHeader.fromEntity === account.state.leftEntity,
  };
};

describe('typed Account peer rejection', () => {
  test('bad domain, party, watch seed, and height are typed no-mutation rejections', async () => {
    const env = createEmptyEnv('account-peer-boundary-rejection');
    env.quietRuntimeLogs = true;
    const base = createAccount();
    const cases: Array<{
      code: string;
      mutate(input: Extract<AccountInput, { kind: 'ack' }>): void;
    }> = [
      {
        code: 'ACCOUNT_PEER_DOMAIN_MISMATCH',
        mutate: input => {
          input.domain.chainId += 1;
        },
      },
      {
        code: 'ACCOUNT_PEER_PARTY_MISMATCH',
        mutate: input => {
          input.toEntityId = input.fromEntityId;
        },
      },
      {
        code: 'ACCOUNT_PEER_WATCH_SEED_INVALID',
        mutate: input => {
          input.watchSeed = 'not-a-watch-seed';
        },
      },
      {
        code: 'ACCOUNT_PEER_HEIGHT_INVALID',
        mutate: input => {
          input.ack.height = Number.NaN;
        },
      },
    ];

    for (const candidate of cases) {
      const account = structuredClone(base);
      const input = ackInput(account);
      candidate.mutate(input);
      const before = safeStringify(account);
      const result = await applyAccountInput(createAccountConsensusContext(env), account, input);
      expect(result.rejected?.code).toBe(candidate.code);
      expect(result.success).toBe(false);
      expect(safeStringify(account)).toBe(before);
    }
  });

  test('bad ACK certificate is rejected, then the honest ACK commits', async () => {
    const env = createEmptyEnv('account-peer-ack-rejection');
    env.quietRuntimeLogs = true;
    const account = createAccount();
    installPendingFrame(account);
    const input = ackInput(account);
    const invalidContext = withVerifier(createAccountConsensusContext(env), async () => ({
      valid: false,
      entityId: null,
    }));
    const before = safeStringify(account);

    const rejected = await applyAccountInput(invalidContext, account, input);
    expect(rejected.rejected?.code).toBe('ACCOUNT_PEER_ACK_CERTIFICATE_INVALID');
    expect(safeStringify(account)).toBe(before);

    const honestContext = withVerifier(createAccountConsensusContext(env), async (_hanko, _hash, expectedEntityId) => ({
      valid: true,
      entityId: expectedEntityId,
    }));
    const accepted = await applyAccountInput(honestContext, account, input);
    expect(accepted.success).toBe(true);
    expect(account.currentHeight).toBe(1);
    expect(account.pendingFrame).toBeUndefined();
  });

  test('bad frame certificate is a typed no-mutation rejection', async () => {
    const env = createEmptyEnv('account-peer-frame-rejection');
    env.quietRuntimeLogs = true;
    const account = createAccount();
    const frame = {
      height: 1,
      timestamp: env.state.timestamp,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: 'genesis',
      accountStateRoot: computeAccountStateRoot(account.state),
      deltas: [],
      stateHash: '',
      byLeft: false,
    };
    frame.stateHash = await createFrameHash(frame);
    const input: Extract<AccountInput, { kind: 'frame' }> = {
      kind: 'frame',
      fromEntityId: account.proofHeader.toEntity,
      toEntityId: account.proofHeader.fromEntity,
      domain: { ...account.state.domain },
      watchSeed: account.state.watchSeed,
      proposal: { frame, frameHanko: `0x${'66'.repeat(65)}` },
    };
    const context = withVerifier(createAccountConsensusContext(env), async () => ({ valid: false, entityId: null }));
    const before = safeStringify(account);

    const rejected = await applyAccountInput(context, account, input);

    expect(rejected.rejected?.code).toBe('ACCOUNT_PEER_FRAME_HANKO_INVALID');
    expect(safeStringify(account)).toBe(before);
  });

  test('local verifier failure is never downgraded to a peer rejection', async () => {
    const env = createEmptyEnv('account-peer-local-verifier-fatal');
    env.quietRuntimeLogs = true;
    const account = createAccount();
    const frame = {
      height: 1,
      timestamp: env.state.timestamp,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: 'genesis',
      accountStateRoot: computeAccountStateRoot(account.state),
      deltas: [],
      stateHash: '',
      byLeft: false,
    };
    frame.stateHash = await createFrameHash(frame);
    const proofBodyHash = `0x${'aa'.repeat(32)}`;
    const input: Extract<AccountInput, { kind: 'frame' }> = {
      kind: 'frame',
      fromEntityId: account.proofHeader.toEntity,
      toEntityId: account.proofHeader.fromEntity,
      domain: { ...account.state.domain },
      watchSeed: account.state.watchSeed,
      proposal: {
        frame,
        frameHanko: `0x${'66'.repeat(65)}`,
        disputeSeal: {
          hanko: `0x${'77'.repeat(65)}`,
          hash: createDisputeProofHashWithNonce(account.state, proofBodyHash, account.state.domain, 0),
          proofBodyHash,
          proofNonce: 0,
        },
      },
    };
    const context = withVerifier(createAccountConsensusContext(env), async () => {
      throw new Error('LOCAL_VERIFIER_FAILURE');
    });

    await expect(applyAccountInput(context, account, input)).rejects.toThrow('LOCAL_VERIFIER_FAILURE');
  });
});

test('authenticated Runtime Account poison is consumed and the next honest Entity input commits', async () => {
  const fixture = createEntityProposalFixture('account-peer-runtime-continuation', 1n);
  const target = fixture.createValidator('1');
  const peerEntity = `0x${'77'.repeat(32)}`;
  const account = createAccount(fixture.entityId, peerEntity);
  installPendingFrame(account);
  target.replica.state.accounts.set(peerEntity, account);
  target.env.runtimeId = `0x${'88'.repeat(20)}`;
  target.env.infrastructure ??= {};
  target.env.infrastructure.entityRuntimeHints = new Map();
  target.env.state.eReplicas.set(`${fixture.entityId}:${target.signerId}`, target.replica);
  const poison = ackInput(account);
  poison.watchSeed = 'not-a-watch-seed';
  const routingDeps = {
    ensureRuntimeInfrastructure: () => target.env.infrastructure!,
    enqueueRuntimeInputs: () => {},
    extractEntityId: (replicaKey: string) => replicaKey.split(':')[0] ?? '',
    hasLocalSignerForEntity: () => true,
    hasLocalSignerForEntitySigner: () => true,
    resolveSoleLocalSignerForEntity: () => target.signerId,
    getP2P: () => null,
  };

  const poisoned = await applyMergedEntityInputs(
    target.env,
    [
      {
        from: `0x${'99'.repeat(20)}`,
        sourceRuntimeFrame: { height: 1, timestamp: 1 },
        entityId: fixture.entityId,
        signerId: target.signerId,
        entityTxs: [{ type: 'accountInput', data: poison }],
      },
    ],
    [],
    { isReplay: false, routingDeps },
  );
  expect(poisoned.inputOutcomes[0]?.outcome.kind).toBe('committed');
  expect(
    target.env.state.eReplicas.get(`${fixture.entityId}:${target.signerId}`)?.state.accounts.get(peerEntity)
      ?.currentHeight,
  ).toBe(0);
  const heightAfterPoison =
    target.env.state.eReplicas.get(`${fixture.entityId}:${target.signerId}`)?.state.height ?? -1;

  const committedReplica = target.env.state.eReplicas.get(`${fixture.entityId}:${target.signerId}`);
  if (!committedReplica) throw new Error('TEST_COMMITTED_ENTITY_REPLICA_MISSING');
  const command = buildSignedEntityCommand(target.env, committedReplica.state, target.signerId, [
    { type: 'chat', data: { from: target.signerId, message: 'runtime-still-progresses' } },
  ]);

  const honest = await applyMergedEntityInputs(
    target.env,
    [
      {
        entityId: fixture.entityId,
        signerId: target.signerId,
        entityTxs: [signedEntityCommandTx(command)],
      },
    ],
    [],
    { isReplay: false, routingDeps },
  );
  expect(honest.inputOutcomes[0]?.outcome.kind).toBe('committed');
  expect(honest.inputOutcomes[0]?.entityFrameCommitted).toBe(true);
  expect(target.env.state.eReplicas.get(`${fixture.entityId}:${target.signerId}`)?.state.height).toBe(
    heightAfterPoison + 1,
  );
});

test('full Account capacity consumes unknown peer genesis and Runtime continues', async () => {
  const fixture = createEntityProposalFixture('account-peer-full-capacity', 1n);
  const target = fixture.createValidator('1');
  target.replica.state.config.jurisdiction = {
    name: 'account-peer-full-capacity',
    address: 'http://localhost:8545',
    chainId: domain.chainId,
    depositoryAddress: domain.depositoryAddress,
    entityProviderAddress: `0x${'55'.repeat(20)}`,
  };
  const unknownPeer = `0x${'ee'.repeat(32)}`;
  target.replica.state.accounts.clear();
  for (let index = 1; index <= LIMITS.MAX_ACCOUNTS_PER_ENTITY; index += 1) {
    const peer = `0x${index.toString(16).padStart(64, '0')}`;
    target.replica.state.accounts.set(peer, createAccount(fixture.entityId, peer));
  }
  target.env.runtimeId = `0x${'88'.repeat(20)}`;
  target.env.infrastructure ??= {};
  target.env.infrastructure.entityRuntimeHints = new Map();
  target.env.state.eReplicas.set(`${fixture.entityId}:${target.signerId}`, target.replica);
  const poison: Extract<AccountInput, { kind: 'frame' }> = {
    kind: 'frame',
    fromEntityId: unknownPeer,
    toEntityId: fixture.entityId,
    domain: { ...domain },
    watchSeed: `0x${'dd'.repeat(32)}`,
    proposal: {
      frame: {
        height: 1,
        timestamp: 1,
        jHeight: 0,
        accountTxs: [],
        prevFrameHash: 'genesis',
        accountStateRoot: `0x${'aa'.repeat(32)}`,
        deltas: [],
        stateHash: `0x${'bb'.repeat(32)}`,
        byLeft: unknownPeer < fixture.entityId,
      },
      frameHanko: `0x${'cc'.repeat(65)}`,
    },
  };
  const routingDeps = {
    ensureRuntimeInfrastructure: () => target.env.infrastructure!,
    enqueueRuntimeInputs: () => {},
    extractEntityId: (replicaKey: string) => replicaKey.split(':')[0] ?? '',
    hasLocalSignerForEntity: () => true,
    hasLocalSignerForEntitySigner: () => true,
    resolveSoleLocalSignerForEntity: () => target.signerId,
    getP2P: () => null,
  };

  const poisoned = await applyMergedEntityInputs(
    target.env,
    [
      {
        from: `0x${'99'.repeat(20)}`,
        sourceRuntimeFrame: { height: 1, timestamp: 1 },
        entityId: fixture.entityId,
        signerId: target.signerId,
        entityTxs: [{ type: 'accountInput', data: poison }],
      },
    ],
    [],
    { isReplay: false, routingDeps },
  );
  expect(poisoned.inputOutcomes[0]?.outcome.kind).toBe('committed');
  const afterPoison = target.env.state.eReplicas.get(`${fixture.entityId}:${target.signerId}`);
  expect(afterPoison?.state.accounts.size).toBe(LIMITS.MAX_ACCOUNTS_PER_ENTITY);
  expect(afterPoison?.state.accounts.has(unknownPeer)).toBe(false);
  if (!afterPoison) throw new Error('TEST_COMMITTED_ENTITY_REPLICA_MISSING');
  const command = buildSignedEntityCommand(target.env, afterPoison.state, target.signerId, [
    { type: 'chat', data: { from: target.signerId, message: 'capacity-poison-consumed' } },
  ]);
  const honest = await applyMergedEntityInputs(
    target.env,
    [
      {
        entityId: fixture.entityId,
        signerId: target.signerId,
        entityTxs: [signedEntityCommandTx(command)],
      },
    ],
    [],
    { isReplay: false, routingDeps },
  );
  expect(honest.inputOutcomes[0]?.outcome.kind).toBe('committed');
  expect(honest.inputOutcomes[0]?.entityFrameCommitted).toBe(true);
});
