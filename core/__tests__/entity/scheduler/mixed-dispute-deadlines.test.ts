import { expect, test } from 'bun:test';
import { createEmptyEnv } from '../../../runtime';
import { initCrontab, scheduleHook } from '../../../entity/scheduler';
import { createBookIntentProgram } from '../../../entity/books/book-intents';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { handleScheduledWakeEntityTx } from '../../../entity/tx/handlers/system/scheduled-wake';
import { initJBatch } from '../../../jurisdiction/machine/batch';
import { buildAccountProofBodyFromJurisdictions } from '../../../account/consensus/helpers';
import { addr, entity, installJurisdictions, makeJurisdiction, makeState, openWritableEntityAccounts } from '../../helpers/cross-j';

// Mirrors scheduler_runtime::execute::tests::mixed_dispute_deadlines_*.
// The ids, rather than Account iteration order, decide same-timestamp prepares.
const owner = entity('01');
const pullPeer = entity('02');
const ackPeer = entity('03');
const hashlock = entity('04');
const signer = addr('31');
const jurisdiction = makeJurisdiction('mixed-deadlines', 31337, '21', '22');

async function runMixedWake(queuedStarts: number, hookAt = 1000, ackAt = 1000) {
  const env = createEmptyEnv('mixed-deadlines');
  installJurisdictions(env, jurisdiction);
  const state = makeState(owner, signer, jurisdiction, pullPeer);
  const accounts = openWritableEntityAccounts(state);
  const pullAccount = accounts.getForWrite(pullPeer)!;
  pullAccount.status = 'dispute_preparing';
  pullAccount.disputePrepare = { startedAt: 1, readyAfter: 1, reason: 'pull-retry' };
  const ackAccount = openWritableEntityAccounts(makeState(owner, signer, jurisdiction, ackPeer)).getForWrite(ackPeer)!;
  ackAccount.state.locks = PersistentAccountStateMap.fromEntries('locks', [[hashlock, {
    lockId: hashlock, hashlock, tokenId: 1, amount: 1n, timelock: 300_000n,
    revealBeforeHeight: 1, senderIsLeft: true, createdHeight: 1, createdTimestamp: 1,
  }]]);
  accounts.set(ackPeer, ackAccount);
  state.paybook.entries.set(hashlock, {
    hashlock, tokenId: 1, amount: 1n, inboundEntity: ackPeer, createdTimestamp: 1,
    secret: entity('05'), secretAckPending: true, secretAckStartedAt: 1, secretAckDeadlineAt: ackAt,
  });
  state.timestamp = 1000;
  state.leaderState = { view: 0, activeValidatorId: signer, changedAtHeight: 0 };
  state.crontabState = initCrontab();
  scheduleHook(state.crontabState, { id: `dispute-deadline:${pullPeer}`, triggerAt: hookAt,
    type: 'dispute_deadline', data: { accountId: pullPeer } });
  state.jBatchState = initJBatch();
  const proof = buildAccountProofBodyFromJurisdictions(env.state, pullAccount);
  for (let i = 0; i < queuedStarts; i++) state.jBatchState.batch.disputeStarts.push({
    counterentity: entity((0x10 + i).toString(16)), nonce: 1, proposerIsLeft: true,
    proofbodyHash: proof.proofBodyHash, initialProofbody: proof.proofBodyStruct,
    watchSeed: proof.proofBodyStruct.watchSeed, sig: '0x', starterInitialArguments: '0x',
    starterCounterArguments: '0x', starterCounterProofCommitment: entity('00'),
  });
  const book = createBookIntentProgram().openSlot();
  const result = await handleScheduledWakeEntityTx(env, state, {
    type: 'scheduledWake', data: { version: 1, proposerSignerId: signer,
      dueAt: Math.min(hookAt, ackAt), jobs: [{ kind: 'hook', id: ackAt < hookAt ? `htlc-secret-ack:${hashlock}` : `dispute-deadline:${pullPeer}`, dueAt: Math.min(hookAt, ackAt) }] },
  }, false, book);
  const peers = result.approvedEntityTxs?.flatMap(tx => tx.type === 'prepareDispute' ? [tx.data.counterpartyEntityId] : []) ?? [];
  return { peers, deadline: book.getPaybookEntry(state, hashlock)!.secretAckDeadlineAt };
}

test('mixed dispute deadlines use (triggerAt, id) for one wake', async () => {
  expect((await runMixedWake(0)).peers).toEqual([pullPeer, ackPeer]);
  expect((await runMixedWake(0, 1000, 999)).peers).toEqual([ackPeer, pullPeer]);
  expect((await runMixedWake(0, 999, 1000)).peers).toEqual([pullPeer, ackPeer]);
});

test('mixed dispute deadlines count the hook prepare before deferring a secret ACK', async () => {
  expect(await runMixedWake(7)).toEqual({ peers: [pullPeer], deadline: 1001 });
});
