import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { initCrontab } from '../../../entity/scheduler';
import { handleScheduledWakeEntityTx } from '../../../entity/tx/handlers/system/scheduled-wake';
import { expect, test } from 'bun:test';
import { Wallet, ZeroHash, keccak256 } from 'ethers';
import { registerSignerKey } from '../../../account/crypto';
import { proposeAccountFrame } from '../../../account/consensus';
import { buildAccountProofBodyFromJurisdictions } from '../../../account/consensus/helpers';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { generateLazyEntityId } from '../../../entity/factory';
import { buildSingleSignerHanko, prepareSignedBatch } from '../../../hanko/batch';
import { createJAdapter } from '../../../jurisdiction/adapter';
import { rawEventToJEvents } from '../../../jurisdiction/adapter/events/j-event-payloads';
import { createEmptyBatch, encodeJBatch } from '../../../jurisdiction/machine/batch';
import { decodeInt512, encodeInt512 } from '../../../protocol/crypto/abi-money';
import { hashProofBodyStruct } from '../../../protocol/dispute/proof-builder';
import { createEmptyEnv } from '../../../runtime';
import { handleJBroadcast, takeBroadcastBatch } from '../../../entity/tx/handlers/j-batch/j-broadcast';
import { applyJEventRange } from '../../helpers/j-history';
import { addReplica, installJurisdictions, makeJurisdiction, makeState, openWritableEntityAccounts } from '../../helpers/cross-j';

// Real Depository bytecode, Alice's real Account proposal, Bob's signed start,
// certified event ingress, then only Alice's queued batch. Bob never finalizes.
test.each(['none', 'ingress', 'seal', 'recovery'] as const)('review 2: Alice exits certified N8 with unpublished HTLC secret learned at %s', async secretAt => {
  const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
  try {
    await adapter.deployStack();
    const parties = ['11', '22'].map(byte => {
      const wallet = new Wallet(`0x${byte.repeat(32)}`);
      return { wallet, id: generateLazyEntityId([wallet.address.toLowerCase()], 1n) };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const alice = parties[0]!, bob = parties[1]!;
    const env = createEmptyEnv('pending-exit');
    env.quietRuntimeLogs = true;
    const signer = alice.wallet.address.toLowerCase();
    registerSignerKey(env.runtimeSeed!, signer, new Uint8Array(Buffer.from(alice.wallet.privateKey.slice(2), 'hex')));
    const jurisdiction = { ...makeJurisdiction('pending-exit', 31337, '21', '22'),
      depositoryAddress: adapter.addresses.depository,
      entityProviderAddress: adapter.addresses.entityProvider,
    };
    installJurisdictions(env, jurisdiction);
    const state = makeState(alice.id, signer, jurisdiction, bob.id);
    state.timestamp = 120_000;
    state.crontabState = initCrontab();
    const account = openWritableEntityAccounts(state).getForWrite(bob.id)!;
    env.state.jReplicas.get(jurisdiction.name)!.contracts.deltaTransformer = adapter.addresses.deltaTransformer;
    const secret = `0x${'61'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const lockId = `0x${'71'.repeat(32)}`;
    if (secretAt !== 'none') account.state.locks = account.state.locks.updated(lockId, {
      lockId, hashlock, timelock: 10_000_000n, revealBeforeHeight: 10_000,
      amount: 10n, tokenId: 1, senderIsLeft: false, createdHeight: 1, createdTimestamp: 1000,
    });
    const learnSecret = (target: typeof state) => target.paybook.entries.set(hashlock, {
      hashlock, secret, tokenId: 1, amount: 10n, inboundEntity: bob.id, inboundLockId: lockId,
      createdTimestamp: target.timestamp,
    });
    if (secretAt === 'ingress') learnSecret(state);
    const committed = buildAccountProofBodyFromJurisdictions(env.state, account);
    account.counterpartyDisputeProofNonce = 7;
    account.counterpartyDisputeProofBodyHash = committed.proofBodyHash;
    account.proofHeader.nextProofNonce = 8;
    account.mempool = [{ type: 'direct_payment', data: {
      tokenId: 1, amount: 1n, route: [bob.id], fromEntityId: alice.id, toEntityId: bob.id, deliveryMode: 'direct',
    } }];
    await proposeAccountFrame(createAccountConsensusContext(env), account, state.timestamp);
    const pending = account.pendingAccountInput!.proposal.disputeHanko!;
    const body = { ...committed.proofBodyStruct,
      offdeltas: committed.proofBodyStruct.offdeltas.map(value => encodeInt512(decodeInt512(value) - 1n)),
    };
    expect(pending.proofNonce).toBe(8);
    expect(hashProofBodyStruct(body)).toBe(pending.proofBodyHash);
    addReplica(env, state, signer);

    await adapter.debugFundReserves(alice.id, 1, 100n);
    const fund = createEmptyBatch();
    fund.reserveToCollateral.push({ tokenId: 1, receivingEntity: alice.id, pairs: [{ entity: bob.id, amount: 100n }] });
    const funded = prepareSignedBatch(fund, alice.id, alice.wallet.privateKey, 31337n, adapter.addresses.depository, 0n);
    await adapter.processBatch(funded.encodedBatch, funded.hankoData, funded.nextNonce);
    expect(await adapter.getCollateral(alice.id, bob.id, 1)).toBe(100n);

    if (secretAt !== 'none') {
      await adapter.debugFundReserves(bob.id, 1, 100n);
      const bobFund = createEmptyBatch();
      bobFund.reserveToCollateral.push({ tokenId: 1, receivingEntity: bob.id, pairs: [{ entity: alice.id, amount: 100n }] });
      const signed = prepareSignedBatch(bobFund, bob.id, bob.wallet.privateKey, 31337n, adapter.addresses.depository, 0n);
      await adapter.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce);
    }
    const start = createEmptyBatch();
    start.disputeStarts.push({
      counterentity: alice.id, nonce: 8, proposerIsLeft: true,
      proofbodyHash: pending.proofBodyHash, initialProofbody: body, watchSeed: body.watchSeed.toString(),
      sig: buildSingleSignerHanko(alice.id, pending.hash, alice.wallet.privateKey),
      starterInitialArguments: '0x', starterCounterArguments: '0x', starterCounterProofCommitment: ZeroHash,
    });
    const signedStart = prepareSignedBatch(start, bob.id, bob.wallet.privateKey, 31337n, adapter.addresses.depository, secretAt === 'none' ? 0n : 1n);
    const vm = adapter.getBrowserVM()!;
    vm.beginJurisdictionBlock(100_000);
    const receipt = await adapter.processBatch(signedStart.encodedBatch, signedStart.hankoData, signedStart.nextNonce);
    vm.endJurisdictionBlock();
    const raw = receipt.events.find(event => event.name === 'DisputeStarted')!;
    const event = rawEventToJEvents(raw, alice.id)[0]!;
    const result = await applyJEventRange(state, {
      from: signer, jurisdictionRef: jurisdiction.name, event,
      observedAt: 1, blockNumber: 1, blockHash: `0x${'ab'.repeat(32)}`,
    }, env);
    expect(result.newState.accounts.get(bob.id)!.pendingFrame).toBeUndefined();
    const queued = result.newState.jBatchState!;
    const expected = createEmptyBatch();
    expected.disputeFinalizations.push({
      counterentity: bob.id, initialNonce: 8, finalNonce: 8, proposerIsLeft: true,
      initialProofbodyHash: pending.proofBodyHash, finalProofbody: body,
      starterArguments: '0x', otherArguments: '0x', sig: '0x', startedByLeft: false, cooperative: false,
    });
    if (secretAt === 'none') expect(encodeJBatch(queued.batch)).toBe(encodeJBatch(expected));
    if (secretAt === 'ingress') expect(queued.batch.disputeFinalizations[0]!.otherArguments).not.toBe('0x');
    else expect(queued.batch.disputeFinalizations[0]!.otherArguments).toBe('0x');
    if (secretAt === 'seal' || secretAt === 'recovery') learnSecret(result.newState);
    if (secretAt === 'recovery') {
      queued.recoveryBatches = [queued.batch];
      queued.batch = createEmptyBatch();
    }
    queued.entityNonce = Number(funded.nextNonce);
    const hook = result.newState.crontabState!.hooks.get(`dispute-deadline:${bob.id}`)!;
    result.newState.timestamp = hook.triggerAt;
    const wake = await handleScheduledWakeEntityTx(env, result.newState, {
      type: 'scheduledWake', data: { version: 1, proposerSignerId: signer, dueAt: hook.triggerAt,
        jobs: [{ kind: 'hook', id: hook.id, dueAt: hook.triggerAt }] },
    }, false);
    const broadcastTx = wake.approvedEntityTxs?.find(tx => tx.type === 'j_broadcast');
    if (!broadcastTx || broadcastTx.type !== 'j_broadcast') throw new Error('QUEUED_EXIT_WAKE_MISSING');
    const broadcast = await handleJBroadcast(wake.newState, broadcastTx, env);
    expect(broadcast.jOutputs).toHaveLength(1);
    const sent = broadcast.newState.jBatchState!.sentBatch!;
    expect(sent.batch.revealSecrets).toHaveLength(0);
    expect(sent.batch.disputeFinalizations[0]!.starterArguments).toBe('0x');
    const signedExit = prepareSignedBatch(sent.batch, alice.id, alice.wallet.privateKey, 31337n,
      adapter.addresses.depository, funded.nextNonce);
    if (secretAt === 'none') expect(signedExit.encodedBatch).toBe(encodeJBatch(expected));
    expect(hook.triggerAt).toBeLessThan(10_000_000);
    vm.beginJurisdictionBlock(hook.triggerAt);
    const exit = await adapter.processBatch(signedExit.encodedBatch, signedExit.hankoData, signedExit.nextNonce);
    vm.endJurisdictionBlock();
    expect(exit.events.some(event => event.name === 'DisputeFinalized')).toBe(true);
    expect(await adapter.getCollateral(alice.id, bob.id, 1)).toBe(0n);
    expect(await adapter.getReserves(alice.id, 1)).toBe(secretAt === 'none' ? 99n : 109n);
    expect(await adapter.getReserves(bob.id, 1)).toBe(secretAt === 'none' ? 1n : 91n);
  } finally { await adapter.close(); }
});

test('timed queued exit stays mutable before T while other work can broadcast', () => {
  const batch = createEmptyBatch();
  const exit = { counterentity: `0x${'22'.repeat(32)}`, initialNonce: 8, finalNonce: 8,
    proposerIsLeft: true, initialProofbodyHash: ZeroHash,
    finalProofbody: { watchSeed: `0x${'33'.repeat(32)}`, leftResponseSeconds: 10, rightResponseSeconds: 20,
      offdeltas: [encodeInt512(7n)], tokenIds: [1], transformers: [] },
    starterArguments: '0x', otherArguments: '0x', sig: '0x', startedByLeft: false,
    cooperative: false, submitNotBeforeTimestamp: 130 };
  exit.initialProofbodyHash = hashProofBodyStruct(exit.finalProofbody);
  batch.disputeFinalizations.push(exit);
  // Same exact ABI vector is pinned by the Rust Entity ingress regression.
  expect(keccak256(encodeJBatch(batch))).toBe('0xcfc1ff3f5dcbf3cdcb576ef1de18e32e18122c5e7cb19d997482dfc4b2b32fa1');
  batch.reserveToReserve.push({ receivingEntity: `0x${'44'.repeat(32)}`, tokenId: 1, amount: 1n });
  const early = takeBroadcastBatch(batch, 129);
  expect(early.selected.disputeFinalizations).toHaveLength(0);
  expect(early.selected.reserveToReserve).toHaveLength(1);
  expect(early.remainder.disputeFinalizations).toEqual([exit]);
  const ready = takeBroadcastBatch(early.remainder, 130);
  expect(ready.selected.disputeFinalizations).toEqual([exit]);
  expect(ready.remainder.disputeFinalizations).toHaveLength(0);
});
