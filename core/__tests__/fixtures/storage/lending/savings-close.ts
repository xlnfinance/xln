import { strict as assert } from 'node:assert';
import { bank, saver, command, fundedLoan, positionId, replica, seed, termMs } from '../lending-runtime';
import {
  closeInfraDb,
  closeRuntimeDb,
  processRuntime,
  readPersistedFrameJournal,
  restoreEnvFromCheckpointSnapshot,
  replayRecoveryFrameJournals,
} from '../../../../runtime';
import { computeAccountStateRootCold } from '../../../../account/commitment/state-root';
import { computeFrameHash } from '../../../../account/consensus/frame/hash';
import { signAccountFrame } from '../../../../account/crypto';
import { buildQuorumHanko, verifyHankoForHash } from '../../../../hanko/signing';
import { safeStringify } from '../../../../protocol/serialization';
import type { AccountFrame, AccountInput } from '../../../../types/account';
import {
  beginRuntimeParityEvidence,
  finishRuntimeParityEvidence,
} from '../../../../runtime/observability/parity-evidence';
import { computeEntityAccountFieldDigests } from '../../../../entity/consensus/state-root';
import { buildRuntimeRecoveryCheckpointSnapshot } from '../../../../storage/wal/snapshot';

const mode = process.argv[2];
assert(mode === 'missing-request' || mode === 'mature-underpayment');
assert(process.env['XLN_DB_PATH'], 'ISOLATED_LENDING_DB_REQUIRED');
const env = await fundedLoan();
let replay: typeof env | undefined;
const account = (party: typeof bank, peer: typeof bank) => {
  const value = replica(env, party).state.accounts.get(peer.entityId);
  assert(value);
  return value;
};
const pool = () => {
  const value = replica(env, bank).state.lending?.savings.get(positionId);
  assert(value);
  return value;
};
const financialState = () =>
  [bank, saver].map(party => {
    const value = account(party, party === bank ? saver : bank);
    return {
      entityId: party.entityId,
      root: computeAccountStateRootCold(value.state),
      height: value.currentHeight,
      frameHash: value.currentFrame.stateHash,
      deltas: [...value.state.deltas],
      claim: value.state.subcontracts?.get(positionId),
      closeIntent: value.state.lendingIntents?.get('close:' + positionId),
      payoutIntent: value.state.lendingIntents?.get('payout:' + positionId),
    };
  });

try {
  const maturity = pool().createdAt + termMs;
  if (mode === 'mature-underpayment') {
    // The bank can repay principal (ending at 10,000 IOUs), but the promised
    // 50 coupon exceeds this lowered limit. Honest servicing must stay queued.
    await command(env, saver, {
      type: 'extendCredit',
      data: {
        counterpartyEntityId: bank.entityId,
        tokenId: 1,
        amount: 10_000n,
      },
    });
  }
  env.state.timestamp = maturity;
  if (mode === 'mature-underpayment') {
    await command(env, saver, {
      type: 'lendingClosePosition',
      data: {
        hubEntityId: bank.entityId,
        positionId,
      },
    });
    assert.equal(pool().status, 'queued');
  } else assert.equal(pool().status, 'open');

  // Verify actual honest, committed Hanko certificates against each observer's
  // authority, rather than treating the fixture or test name as signature proof.
  for (const party of [bank, saver]) {
    const peer = party === bank ? saver : bank;
    const value = account(party, peer);
    assert(!value.pendingFrame);
    assert(value.currentFrameHanko && value.counterpartyFrameHanko);
    assert(
      (
        await verifyHankoForHash(value.currentFrameHanko, value.currentFrame.stateHash, party.entityId, env, {
          observerState: replica(env, party).state,
        })
      ).valid,
    );
    assert(
      (
        await verifyHankoForHash(value.counterpartyFrameHanko, value.currentFrame.stateHash, peer.entityId, env, {
          observerState: replica(env, party).state,
        })
      ).valid,
    );
    assert.equal(
      value.state.lendingIntents?.get('close:' + positionId),
      mode === 'mature-underpayment' ? 'close-mature' : undefined,
    );
  }
  const before = financialState();
  const receiver = account(saver, bank);
  const previousAck = safeStringify(receiver.lastOutboundAckFrame);
  const frame: AccountFrame = {
    height: receiver.currentHeight + 1,
    timestamp: env.state.timestamp,
    jHeight: receiver.currentFrame.jHeight,
    prevFrameHash: receiver.currentFrame.stateHash,
    // A malicious sender may sign any claimed root. The exact money/authority
    // rejection below must occur before root comparison, and cannot earn an ACK.
    accountStateRoot: computeAccountStateRootCold(receiver.state),
    stateHash: '',
    accountTxs: [
      {
        type: 'lending_close_payout',
        data: {
          positionId,
          hubEntityId: bank.entityId,
          lenderEntityId: saver.entityId,
          tokenId: 1,
          amount: pool().principalAmount,
        },
      },
    ],
  };
  frame.stateHash = computeFrameHash(frame);
  const bankState = replica(env, bank).state;
  const frameHanko = await buildQuorumHanko(
    env,
    bank.entityId,
    frame.stateHash,
    [{ signerId: bank.signerId, signature: signAccountFrame(env, bank.signerId, frame.stateHash) }],
    bankState.config,
    bankState,
  );
  assert(
    (
      await verifyHankoForHash(frameHanko, frame.stateHash, bank.entityId, env, {
        observerState: replica(env, saver).state,
      })
    ).valid,
  );
  const input: AccountInput = {
    kind: 'ack_frame',
    fromEntityId: bank.entityId,
    toEntityId: saver.entityId,
    domain: receiver.state.domain,
    disputeConfig: receiver.state.disputeConfig,
    watchSeed: receiver.state.watchSeed,
    proposal: { frame, frameHanko },
  };
  const priorFields = computeEntityAccountFieldDigests(replica(env, saver).state);
  const checkpoint = buildRuntimeRecoveryCheckpointSnapshot(env);
  beginRuntimeParityEvidence(env);
  await processRuntime(env, [{ ...saver, entityTxs: [{ type: 'accountInput', data: input }] }]);
  const committed = finishRuntimeParityEvidence(env);
  const receivingRuntimeHeight = env.state.height;
  const rejected = account(saver, bank);
  const expected =
    mode === 'missing-request'
      ? 'LENDING_SAVINGS_CLOSE_AUTHORIZATION_REQUIRED'
      : 'LENDING_SAVINGS_PAYOUT_AMOUNT_MISMATCH';
  const receiving = committed.entityFrames.find(
    candidate =>
      candidate.entityId === saver.entityId &&
      candidate.link.frame.events.some(event => event.message.includes(expected)),
  );
  assert(receiving, safeStringify(committed.entityFrames.map(candidate => candidate.link.frame.events)));
  const rejectionFrame = receiving.link.frame;
  // The bilateral root and currentFrameHash bind the honest signed
  // predecessor. Local dispute metadata is intentionally outside these fields.
  const moneyFields = (fields: typeof priorFields) =>
    fields.map(entry => ({
      counterpartyId: entry.counterpartyId,
      fields: entry.fields.filter(field =>
        ['accountStateRoot', 'currentFrameHash', 'currentHeight', 'lastOutboundAckFrame'].includes(field.field),
      ),
    }));
  assert(moneyFields(priorFields).every(entry => entry.fields.some(field => field.field === 'accountStateRoot')));
  assert.deepEqual(moneyFields(receiving.accountFieldDigests), moneyFields(priorFields));
  assert(
    rejectionFrame.txs.some(
      tx =>
        tx.type === 'accountInput' &&
        tx.data.kind === 'ack_frame' &&
        tx.data.proposal.frame.stateHash === frame.stateHash &&
        tx.data.proposal.frameHanko === frameHanko,
    ),
  );
  const rejectionHanko = rejectionFrame.hankos?.[0];
  assert(rejectionHanko);
  assert(
    (
      await verifyHankoForHash(rejectionHanko, rejectionFrame.hash, saver.entityId, env, {
        observerState: replica(env, saver).state,
      })
    ).valid,
  );
  const journal = await readPersistedFrameJournal(env, receivingRuntimeHeight);
  assert(journal);
  assert.equal(journal.height, receivingRuntimeHeight);
  replay = await restoreEnvFromCheckpointSnapshot(checkpoint, { runtimeSeed: seed, readOnly: true });
  beginRuntimeParityEvidence(replay);
  await replayRecoveryFrameJournals(replay, [journal], { verify: true });
  const replayed = finishRuntimeParityEvidence(replay);
  assert.deepEqual(replayed.entityFrames, committed.entityFrames);
  assert.deepEqual(financialState(), before);
  assert.equal(safeStringify(rejected.lastOutboundAckFrame), previousAck);
  assert.notEqual(env.infrastructure?.halted, true);
  // Signed semantic fraud follows the existing dispute path. It never commits
  // a payout, removes the savings obligation or obtains a saver countersignature.
  assert(rejected.status === 'dispute_preparing' || rejected.status === 'disputed');
  await command(env, saver, {
    type: 'profile-update',
    data: {
      profile: { entityId: saver.entityId, name: 'Live after rejected savings payout' },
    },
  });
  assert.equal(replica(env, saver).state.profile.name, 'Live after rejected savings payout');
  assert.notEqual(env.infrastructure?.halted, true);
  assert.deepEqual(financialState(), before);
  console.log(
    'SAVINGS_SIGNED_REJECTION_GREEN ' +
      safeStringify({
        mode,
        saverIsLeft: saver.entityId < bank.entityId,
        expectedRejection: expected,
        honestCommittedHankosVerified: 4,
        hubProposalHankoVerified: true,
        rejectedFrameHash: frame.stateHash,
        obligationAndBalancesUnchanged: true,
        receivingRuntimeHeight,
        receivingEntityFrameHash: rejectionFrame.hash,
        receivingEntityHankoVerified: true,
        rejectionEvents: rejectionFrame.events,
        checkpointAndOrderedWalVerified: true,
        runtimeContinued: true,
        saverCountersignatureOnRejectedProposal: false,
        accounts: financialState(),
      }),
  );
} finally {
  await closeRuntimeDb(env);
  await closeInfraDb(env);
  if (replay) {
    await closeRuntimeDb(replay);
    await closeInfraDb(replay);
  }
}
