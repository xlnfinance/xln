import { describe, expect, test } from 'bun:test';

import { applyAccountInput } from '../../../account/consensus';
import type { AccountConsensusContext } from '../../../account/consensus/context';
import { createFrameHash } from '../../../account/consensus/frame/hash';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import type { AccountInput, AccountReplica } from '../../../types/account';
import { safeStringify } from '../../../protocol/serialization';
import { createEmptyEnv } from '../../../runtime';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';
import { applyMergedEntityInputs } from '../../../runtime/input-pipeline/entity-inputs';
import { buildSignedEntityCommand } from '../../../entity/command';
import { signedEntityCommandTx } from '../../../entity/command/command-codec';
import { createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { LIMITS, TOKENS } from '../../../config/constants';
import { createDefaultDelta } from '../../../account/state/delta';
import {
  accountInputFailureMessage,
  accountInputPeerRejectionCode,
} from '../../../account/consensus/result';
import { fintsPositiveAccountConsensusResult } from '../../types/fints/results/account-consensus-result.positive';
import { openWritableEntityAccounts } from '../../helpers/cross-j';

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
      deltas: PersistentAccountStateMap.empty('deltas'),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      pulls: PersistentAccountStateMap.empty('pulls'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      jNonce: 0,
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
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
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
  account.currentFrame.accountStateRoot = computeAccountStateRoot(account.state);
  return account;
};

const ackInput = (account: AccountReplica): Extract<AccountInput, { kind: 'ack' }> => ({
  kind: 'ack',
  fromEntityId: account.proofHeader.toEntity,
  toEntityId: account.proofHeader.fromEntity,
  domain: { ...account.state.domain },
  disputeConfig: { ...account.state.disputeConfig },
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
  test('closed unions structurally separate rejection from success payloads', () => {
    const covered = fintsPositiveAccountConsensusResult();
    expect(covered.applied.ok).toBe(true);
    expect('rejection' in covered.applied).toBe(false);
    expect(covered.rejected.ok).toBe(false);
    expect('response' in covered.rejected).toBe(false);
    expect('committedFrames' in covered.rejected).toBe(false);
    expect(covered.dispute.ok).toBe(false);
    expect('rejection' in covered.dispute).toBe(false);
    expect(covered.idle.ok).toBe(true);
    expect('accountInput' in covered.idle).toBe(false);
    expect(covered.proposeRejected.ok).toBe(false);
    expect('accountInput' in covered.proposeRejected).toBe(false);
    expect(covered.covered.every(Boolean)).toBe(true);
  });

  test('bad domain, party, watch seed, and height are typed no-mutation rejections', async () => {
    const env = createEmptyEnv('account-peer-boundary-rejection');
    env.quietRuntimeLogs = true;
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
      const account = createAccount();
      const input = ackInput(account);
      candidate.mutate(input);
      const before = safeStringify(account);
      const rootBefore = computeAccountStateRoot(account.state);
      const result = await applyAccountInput(createAccountConsensusContext(env), account, input);
      expect(accountInputPeerRejectionCode(result)).toBe(candidate.code);
      expect(result.ok).toBe(false);
      expect(result.disposition).toBe('rejected');
      expect('response' in result).toBe(false);
      expect('committedFrames' in result).toBe(false);
      expect(Object.keys(result).sort()).toEqual(['disposition', 'events', 'ok', 'rejection']);
      expect(safeStringify(account)).toBe(before);
      expect(computeAccountStateRoot(account.state)).toBe(rootBefore);
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
    expect(accountInputPeerRejectionCode(rejected)).toBe('ACCOUNT_PEER_ACK_CERTIFICATE_INVALID');
    expect(rejected.ok).toBe(false);
    expect('response' in rejected).toBe(false);
    expect(safeStringify(account)).toBe(before);

    const observedAuthorities: unknown[] = [];
    const honestContext = withVerifier(
      createAccountConsensusContext(env),
      async (_hanko, _hash, expectedEntityId, authority) => {
        observedAuthorities.push(authority);
        return { valid: true, entityId: expectedEntityId };
      },
    );
    const accepted = await applyAccountInput(honestContext, account, input);
    expect(accepted.ok).toBe(true);
    expect('rejection' in accepted).toBe(false);
    expect('disposition' in accepted).toBe(false);
    expect(observedAuthorities).toEqual([{ allowPreviousBoard: false }]);
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
      disputeConfig: { ...account.state.disputeConfig },
      watchSeed: account.state.watchSeed,
      proposal: { frame, frameHanko: `0x${'66'.repeat(65)}` },
    };
    const context = withVerifier(createAccountConsensusContext(env), async () => ({ valid: false, entityId: null }));
    const before = safeStringify(account);

    const rejected = await applyAccountInput(context, account, input);

    expect(accountInputPeerRejectionCode(rejected)).toBe('ACCOUNT_PEER_FRAME_HANKO_INVALID');
    expect(rejected.ok).toBe(false);
    expect('committedFrames' in rejected).toBe(false);
    expect(safeStringify(account)).toBe(before);
  });

  test('fresh peer frames always reject previous-board authority', async () => {
    const env = createEmptyEnv('account-peer-current-board-only');
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
      disputeConfig: { ...account.state.disputeConfig },
      watchSeed: account.state.watchSeed,
      proposal: { frame, frameHanko: `0x${'66'.repeat(65)}` },
    };
    const observedAuthorities: unknown[] = [];
    const context = withVerifier(
      createAccountConsensusContext(env),
      async (_hanko, _hash, _expectedEntityId, authority) => {
        observedAuthorities.push(authority);
        return { valid: false, entityId: null };
      },
    );

    const result = await applyAccountInput(context, account, input);

    expect(accountInputPeerRejectionCode(result)).toBe('ACCOUNT_PEER_FRAME_HANKO_INVALID');
    expect(observedAuthorities).toEqual([{ allowPreviousBoard: false }]);
  });

  test('signed zero-row add_delta poison is rejected without throw or mutation', async () => {
    const cases = [
      {
        name: 'token domain',
        account: createAccount(),
        tokenId: TOKENS.MAX_TOKEN_ID + 1,
      },
      {
        name: 'row capacity',
        account: createAccount(),
        tokenId: LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1,
      },
    ];
    for (const candidate of cases) {
      if (candidate.name === 'row capacity') {
        candidate.account.state.deltas = PersistentAccountStateMap.fromEntries(
          'deltas',
          Array.from({ length: LIMITS.MAX_ACCOUNT_TOKEN_ROWS }, (_, index) => {
            const tokenId = index + 1;
            return [tokenId, createDefaultDelta(tokenId)] as const;
          }),
        );
        candidate.account.currentFrame.accountStateRoot = computeAccountStateRoot(candidate.account.state);
      }
      const poisonedState = {
        ...candidate.account.state,
        deltas: candidate.account.state.deltas.updated(
          candidate.tokenId,
          createDefaultDelta(candidate.tokenId),
        ),
      };
      const frame = {
        height: 1,
        timestamp: 0,
        jHeight: 0,
        accountTxs: [{ type: 'add_delta' as const, data: { tokenId: candidate.tokenId } }],
        prevFrameHash: 'genesis',
        accountStateRoot: computeAccountStateRoot(poisonedState),
        // Zero rows are deliberately absent from this projection.
        deltas: [],
        stateHash: '',
        byLeft: false,
      };
      frame.stateHash = await createFrameHash(frame);
      const input: Extract<AccountInput, { kind: 'frame' }> = {
        kind: 'frame',
        fromEntityId: candidate.account.proofHeader.toEntity,
        toEntityId: candidate.account.proofHeader.fromEntity,
        domain: { ...candidate.account.state.domain },
        disputeConfig: { ...candidate.account.state.disputeConfig },
        watchSeed: candidate.account.state.watchSeed,
        proposal: { frame, frameHanko: `0x${'66'.repeat(65)}` },
      };
      const context = withVerifier(
        createAccountConsensusContext(createEmptyEnv(`account-peer-${candidate.name}`)),
        async (_hanko, _hash, expectedEntityId) => ({ valid: true, entityId: expectedEntityId }),
      );
      const before = safeStringify(candidate.account);
      const rootBefore = computeAccountStateRoot(candidate.account.state);

      const result = await applyAccountInput(context, candidate.account, input);

      expect(result.ok).toBe(false);
      expect('response' in result).toBe(false);
      expect('committedFrames' in result).toBe(false);
      expect(accountInputFailureMessage(result)).toContain('ACCOUNT_DELTA_');
      expect(safeStringify(candidate.account)).toBe(before);
      expect(computeAccountStateRoot(candidate.account.state)).toBe(rootBefore);
    }
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
      disputeConfig: { ...account.state.disputeConfig },
      watchSeed: account.state.watchSeed,
      proposal: {
        frame,
        frameHanko: `0x${'66'.repeat(65)}`,
        disputeSeal: {
          hanko: `0x${'77'.repeat(65)}`,
          hash: createDisputeProofHashWithNonce(account.state, proofBodyHash, account.state.domain, 0, true),
          proofBodyHash,
          proofNonce: 0,
          proposerIsLeft: true,
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
  openWritableEntityAccounts(target.replica.state).set(peerEntity, account);
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
