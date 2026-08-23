import { describe, expect, test } from 'bun:test';

import { applyAccountInput } from '../../../../account/consensus';
import type { AccountConsensusContext } from '../../../../account/consensus/context';
import { computeAccountStateRoot } from '../../../../account/commitment/state-root';
import { createEmptyAccountJClaimAccumulator } from '../../../../account/j-claims/j-claim-accumulator';
import { PersistentAccountStateMap } from '../../../../account/state/persistent-state-map';
import type { AccountInput, AccountReplica, AccountTx } from '../../../../types/account';
import { createEmptyEnv } from '../../../../runtime';
import { createAccountConsensusContext } from '../../../../entity/account/account-consensus-context';
import { resetPerfPhases, snapshotPerfPhases } from '../../../../support/performance/profile';
import { createDefaultDelta } from '../../../../account/state/delta';
import { applyAccountTxToMutableReplica } from '../../../../account/tx/apply';
import { safeStringify } from '../../../../protocol/serialization';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const WATCH_SEED = `0x${'33'.repeat(32)}`;
const DOMAIN = {
  chainId: 31_337,
  depositoryAddress: `0x${'44'.repeat(20)}`,
};

const TOKEN_ID = 1;

const createAccount = (): AccountReplica => {
  const account: AccountReplica = {
    state: {
      leftEntity: LEFT,
      rightEntity: RIGHT,
      domain: { ...DOMAIN },
      watchSeed: WATCH_SEED,
      deltas: PersistentAccountStateMap.fromEntries('deltas', [
        [TOKEN_ID, { ...createDefaultDelta(TOKEN_ID), offdelta: 1_000_000n }],
      ]),
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
      byLeft: true,
    },
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: {
      fromEntity: LEFT,
      toEntity: RIGHT,
      nextProofNonce: 1,
    },
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

const directPaymentTx = (amount: bigint): AccountTx =>
  ({
    type: 'direct_payment',
    data: {
      tokenId: TOKEN_ID,
      amount,
      route: [RIGHT],
      deliveryMode: 'direct',
      fromEntityId: LEFT,
      toEntityId: RIGHT,
    },
  }) as never;

const installPendingFrame = async (account: AccountReplica, txs: readonly AccountTx[]): Promise<void> => {
  // Pre-compute the post-tx state root by applying txs to a SEPARATE account
  // with the same initial state. The pending frame's accountStateRoot must
  // match the committed root after the ACK commit.
  let postTxRoot = computeAccountStateRoot(account.state);
  if (txs.length > 0) {
    const probe = createAccount();
    for (const tx of txs) {
      const result = await applyAccountTxToMutableReplica(probe, tx, true, 1, 0, false);
      if (!result.ok) {
        const msg = 'rejection' in result ? result.rejection.message : `keys: ${Object.keys(result).join(',')}`;
        throw new Error(`pre-compute failed: ${msg}`);
      }
    }
    postTxRoot = computeAccountStateRoot(probe.state);
  }
  account.pendingFrame = {
    height: 1,
    timestamp: 1,
    jHeight: 0,
    accountTxs: txs as never,
    prevFrameHash: 'genesis',
    accountStateRoot: postTxRoot,
    deltas: [],
    stateHash: `0x${'55'.repeat(32)}`,
    byLeft: true,
  };
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

const validContext = (env: ReturnType<typeof createEmptyEnv>): AccountConsensusContext => {
  const ctx = createAccountConsensusContext(env);
  return {
    ...ctx,
    verifyHanko: async (_hanko, _hash, expectedEntityId) => ({
      valid: true,
      entityId: expectedEntityId,
    }),
  };
};

/**
 * Micro-benchmark: profile one ACK commit end-to-end with the timePerfPhase
 * marks added to handlePendingFrameAck and commitAccountFrameTransition.
 *
 * This confirms whether commitAccountFrameTransition (re-apply of pending
 * frame txs) is the dominant cost in the ACK path, which is the hypothesis
 * for the ACK fast path optimization.
 */
describe('ACK commit profile', () => {
  test('empty pending frame: baseline ACK cost', async () => {
    const env = createEmptyEnv('ack-profile-empty');
    env.quietRuntimeLogs = true;
    const account = createAccount();
    await installPendingFrame(account, []);
    const input = ackInput(account);

    process.env['XLN_ENTITY_FRAME_PROFILE'] = '1';
    resetPerfPhases();

    const result = await applyAccountInput(validContext(env), account, input);
    expect(result.ok).toBe(true);

    const snapshot = snapshotPerfPhases();
    const phases = snapshot.phases;
    console.log('ACK profile (empty frame):', safeStringify(phases, null, 2));
    resetPerfPhases();
    process.env['XLN_ENTITY_FRAME_PROFILE'] = undefined;
  });

  test('1 direct_payment tx: ACK cost with re-apply', async () => {
    const env = createEmptyEnv('ack-profile-1tx');
    env.quietRuntimeLogs = true;
    const account = createAccount();
    await installPendingFrame(account, [directPaymentTx(100n)]);
    const input = ackInput(account);

    process.env['XLN_ENTITY_FRAME_PROFILE'] = '1';
    resetPerfPhases();

    const result = await applyAccountInput(validContext(env), account, input);
    expect(result.ok).toBe(true);

    const snapshot = snapshotPerfPhases();
    console.log('ACK profile (1 tx):', safeStringify(snapshot.phases, null, 2));
    resetPerfPhases();
    process.env['XLN_ENTITY_FRAME_PROFILE'] = undefined;
  });

  test('10 direct_payment txs: ACK cost with re-apply', async () => {
    const env = createEmptyEnv('ack-profile-10tx');
    env.quietRuntimeLogs = true;
    const account = createAccount();
    const txs = Array.from({ length: 10 }, (_, i) => directPaymentTx(BigInt(i + 1) * 10n));
    await installPendingFrame(account, txs);
    const input = ackInput(account);

    process.env['XLN_ENTITY_FRAME_PROFILE'] = '1';
    resetPerfPhases();

    const result = await applyAccountInput(validContext(env), account, input);
    expect(result.ok).toBe(true);

    const snapshot = snapshotPerfPhases();
    console.log('ACK profile (10 txs):', safeStringify(snapshot.phases, null, 2));
    resetPerfPhases();
    process.env['XLN_ENTITY_FRAME_PROFILE'] = undefined;
  });

  test('repeated ACKs: amortized cost over 50 ACK commits', async () => {
    const env = createEmptyEnv('ack-profile-repeat');
    env.quietRuntimeLogs = true;

    process.env['XLN_ENTITY_FRAME_PROFILE'] = '1';
    resetPerfPhases();

    for (let i = 0; i < 50; i++) {
      const account = createAccount();
      await installPendingFrame(account, [directPaymentTx(100n)]);
      const input = ackInput(account);
      const result = await applyAccountInput(validContext(env), account, input);
      expect(result.ok).toBe(true);
    }

    const snapshot = snapshotPerfPhases();
    console.log('ACK profile (50x 1-tx):', safeStringify(snapshot.phases, null, 2));
    resetPerfPhases();
    process.env['XLN_ENTITY_FRAME_PROFILE'] = undefined;
  });
});
