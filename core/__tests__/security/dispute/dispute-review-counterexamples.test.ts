import { readEntityFrameEventMessages } from '../../../entity/frame-events';
import { safeStringify } from '../../../protocol/serialization';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { expect, test } from 'bun:test';
import { Wallet, ZeroHash } from 'ethers';
import { createEmptyEnv } from '../../../runtime';
import { buildAccountProofBodyFromJurisdictions } from '../../../account/consensus/helpers';
import { encodeSignedHanko } from '../../../hanko/codec';
import { resolveHankoBoardDelays } from '../../../hanko/claims';
import { createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { generateLazyEntityId } from '../../../entity/factory';
import { handleDisputeFinalize, handleDisputeStart, handlePrepareDispute } from '../../../entity/tx/handlers/dispute';
import { handleJBroadcast } from '../../../entity/tx/handlers/j-batch/j-broadcast';
import { applyHankoBatchProcessedEvent } from '../../../entity/tx/j-events-batch';
import { createEmptyBatch, encodeJBatch, initJBatch } from '../../../jurisdiction/machine/batch';
import { addReplica, registerTestSigner, addr, entity, installJurisdictions, makeJurisdiction, makeState, openWritableEntityAccounts, putTestAccountPull } from '../../helpers/cross-j';

const peerSigner = new Wallet(`0x${'12'.repeat(32)}`);
const peer = generateLazyEntityId([peerSigner.address.toLowerCase()], 1n);
const owner = entity('01');
const jurisdiction = makeJurisdiction('test', 31337, '21', '22');
function setup() {
  const env = createEmptyEnv('dispute-review');
  installJurisdictions(env, jurisdiction);
  env.quietRuntimeLogs = true;
  const state = makeState(owner, addr('31'), jurisdiction, peer);
  state.timestamp = 120_000;
  const account = openWritableEntityAccounts(state).getForWrite(peer)!;
  putTestAccountPull(account, 'pull', {
    pullId: 'pull', tokenId: 1, amount: 1n, claimedRatio: 0,
    deadline: 99, claimedAmount: 0n,
    fullHash: entity('41'), partialRoot: entity('42'), createdHeight: 1, createdTimestamp: 1000,
    crossJurisdiction: { orderId: 'order', routeHash: entity('43'), leg: 'target' },
  });
  const proof = buildAccountProofBodyFromJurisdictions(env.state, account);
  account.counterpartyDisputeProofBodyHash = proof.proofBodyHash;
  account.counterpartyDisputeProofNonce = 8;
  account.counterpartyDisputeProofProposerIsLeft = false;
  const hash = createDisputeProofHashWithNonce(account.state, proof.proofBodyHash, {
    chainId: 31337, depositoryAddress: addr('21'),
  }, 8, false);
  account.counterpartyDisputeHash = hash;
  account.counterpartyDisputeProofHanko = encodeSignedHanko({ digest: hash, privateKeys: [new Uint8Array(Buffer.from(peerSigner.privateKey.slice(2), 'hex'))], placeholders: [], claims: [{ entityId: peer as `0x${string}`, entityIndexes: [0n], weights: [1n], threshold: 1n, ...resolveHankoBoardDelays() }], memberSignatures: [] });
  return { env, state, account, proof };
}

test('review 1: unregistered Pull counter-proof cannot queue finalization after timeout', async () => {
  const { env, state, account, proof } = setup();
  account.status = 'disputed';
  account.activeDispute = {
    startedByLeft: false, initialNonce: 7, initialProposerIsLeft: true,
    initialProofbodyHash: proof.proofBodyHash, disputeTimeout: 100, jNonce: 0,
    observedOnChain: true, finalizeQueued: false, starterInitialArguments: '0x',
    starterCounterArguments: '0x', starterCounterProofCommitment: ZeroHash,
  };
  const result = await handleDisputeFinalize(state, {
    type: 'disputeFinalize', data: { counterpartyEntityId: peer },
  }, env);
  expect(result.newState.jBatchState?.batch.disputeFinalizations ?? []).toHaveLength(0);
  expect(result.newState.accounts.get(peer)!.activeDispute!.finalizeQueued).toBe(false);
  expect(readEntityFrameEventMessages(result.newState)).toContain('⏳ Pull counter-proof must be locked on-chain before finalization');
  const registered = openWritableEntityAccounts(result.newState).getForWrite(peer)!;
  registered.activeDispute!.selectedCounterNonce = 8;
  registered.activeDispute!.selectedCounterProposerIsLeft = false;
  registered.activeDispute!.selectedCounterProofbodyHash = proof.proofBodyHash;
  const ready = await handleDisputeFinalize(result.newState, {
    type: 'disputeFinalize', data: { counterpartyEntityId: peer },
  }, env);
  expect(ready.newState.jBatchState!.batch.disputeFinalizations).toHaveLength(1);
});

test.each([addr('31'), addr('32')])('review 3: Pull start broadcasts to active leader %s and retries without losing preparation', async (leader) => {
  const { env, state, account } = setup();
  state.config.validators = [addr('31'), addr('32')];
  state.config.shares = { [addr('31')]: 1n, [addr('32')]: 1n };
  state.leaderState = { view: 1, activeValidatorId: leader, changedAtHeight: 0 };
  account.status = 'dispute_preparing';
  account.disputePrepare = { startedAt: 1000, readyAfter: 1000, reason: 'test' };
  state.jBatchState = initJBatch();
  state.jBatchState.batch.reserveToReserve.push({ receivingEntity: entity('55'), tokenId: 1, amount: 1n });
  const tx = { type: 'disputeStart' as const, data: { counterpartyEntityId: peer } };
  const result = await handleDisputeStart(state, tx, env);
  expect(result.newState.accounts.get(peer)!.status).toBe('dispute_preparing');
  expect(result.newState.accounts.get(peer)!.disputePrepare).toEqual(account.disputePrepare);
  expect(result.newState.jBatchState!.batch.disputeStarts).toHaveLength(0);
  expect(result.newState.jBatchState!.batch.reserveToReserve).toHaveLength(1);
  expect(result.newState.jBatchState!.autoBroadcastDraft).toBe(true);
  expect(result.outputs).toEqual([{
    entityId: owner, signerId: leader, entityTxs: [{ type: 'j_broadcast', data: {} }],
  }]);
  // The flag alone cannot drain an idle entity. Execute the emitted broadcast
  // and its exact finalized receipt; never replace the draft to simulate progress.
  const broadcastTx = result.outputs[0]!.entityTxs![0]!;
  if (broadcastTx.type !== 'j_broadcast') throw new Error('expected j_broadcast');
  const broadcast = await handleJBroadcast(result.newState, broadcastTx, env);
  expect(broadcast.jOutputs).toHaveLength(1);
  expect(broadcast.newState.jBatchState!.batch.reserveToReserve).toHaveLength(0);
  const sent = broadcast.newState.jBatchState!.sentBatch!;
  expect(sent.batch.reserveToReserve).toHaveLength(1);
  await applyHankoBatchProcessedEvent({
    newState: broadcast.newState, blockNumber: 1,
    event: { type: 'HankoBatchProcessed', data: { entityId: owner, batchHash: sent.batchHash, nonce: sent.entityNonce } },
  });
  expect(broadcast.newState.jBatchState!.sentBatch).toBeUndefined();
  const hook = [...broadcast.newState.crontabState!.hooks.values()][0]!;
  expect(hook).toMatchObject({ type: 'dispute_deadline', triggerAt: 121_000, data: { accountId: peer } });
  const { handleScheduledWakeEntityTx } = await import('../../../entity/tx/handlers/system/scheduled-wake');
  broadcast.newState.timestamp = 121_000;
  const wake = await handleScheduledWakeEntityTx(env, broadcast.newState, {
    type: 'scheduledWake', data: { version: 1, proposerSignerId: leader, dueAt: 121_000,
      jobs: [{ kind: 'hook', id: hook.id, dueAt: 121_000 }] },
  }, false);
  const retryTx = wake.approvedEntityTxs?.find(tx => tx.type === 'prepareDispute');
  expect(retryTx).toBeDefined();
  if (!retryTx || retryTx.type !== 'prepareDispute') throw new Error('expected prepareDispute');
  const retried = await handlePrepareDispute(wake.newState, retryTx, env);
  expect(retried.newState.jBatchState!.batch.disputeStarts).toHaveLength(1);
  expect(retried.newState.accounts.get(peer)!.status).toBe('disputed');
});

test('review 3: dirty Pull drafts require a signer and wait behind an immutable sent batch', async () => {
  const { env, state, account } = setup();
  account.status = 'dispute_preparing';
  account.disputePrepare = { startedAt: 1000, readyAfter: 1000, reason: 'test' };
  state.jBatchState = initJBatch();
  const op = { receivingEntity: entity('55'), tokenId: 1, amount: 1n };
  state.jBatchState.batch.reserveToReserve.push(op);
  const tx = { type: 'disputeStart' as const, data: { counterpartyEntityId: peer } };
  state.config.validators = [];
  await expect(handleDisputeStart(state, tx, env)).rejects.toThrow('DISPUTE_START_CROSS_J_BROADCAST_SIGNER_MISSING');
  state.config.validators = [addr('31')];
  state.leaderState = { view: 0, activeValidatorId: addr('31'), changedAtHeight: 0 };
  const broadcast = await handleJBroadcast(state, { type: 'j_broadcast', data: {} }, env);
  broadcast.newState.jBatchState!.batch.reserveToReserve.push(op);
  const sent = broadcast.newState.jBatchState!.sentBatch;
  const result = await handleDisputeStart(broadcast.newState, tx, env);
  expect(result.outputs).toEqual([]);
  expect(result.newState.jBatchState!.sentBatch).toEqual(sent);
  expect(result.newState.jBatchState!.autoBroadcastDraft).toBe(true);
  expect(result.newState.accounts.get(peer)!.disputePrepare).toEqual(account.disputePrepare);
});

test('review 4: TRON appointments are refused by builder and tower admission', async () => {
  const { buildDelayedLastResortAppointments } = await import('../../../watchtower/last-resort-appointment');
  const { deriveRuntimeSignerPrivateKey } = await import('../../../storage/recovery/bundle/seed-identity');
  const { buildTowerAppointmentOwnerMessage } = await import('../../../storage/recovery/bundle/crypto');
  const { handleTowerAppointment } = await import('../../../watchtower/http');
  const { createWatchtowerStore } = await import('../../../watchtower/store');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { env, state } = setup();
  const seed = 'test test test test test test test test test test test junk';
  const ownerWallet = new Wallet(deriveRuntimeSignerPrivateKey(seed, 0));
  const runtimeId = ownerWallet.address.toLowerCase();
  const encryptedBundle = {
    version: 1 as const, runtimeId, lookupKey: entity('61'), height: 1, createdAt: Date.now(),
    bundleHash: entity('62'), iv: '0x1234', ciphertext: '0xabcd',
  };
  const context = { runtimeId, seed, jReplicas: env.state.jReplicas, tower: { url: 'https://tower.example' },
    towerSignerAddress: addr('63'), encryptedBundle };
  const watched = { entityId: owner, signerDerivationIndex: 0, chainId: 31337,
    depositoryAddress: addr('21'), rpcUrl: 'https://rpc.example', entityState: state };
  const evm = await buildDelayedLastResortAppointments(context, [watched]);
  expect(evm.failures).toEqual([]);
  expect(evm.uploads).toHaveLength(1);
  const appointment = evm.uploads[0]!.appointment;
  appointment.lastResortPayload!.watch!.chainId = 728126428;
  appointment.ownerProof.signature = await ownerWallet.signMessage(buildTowerAppointmentOwnerMessage(
    runtimeId, 'delayed_last_resort', appointment.lookupKey, appointment.slot, appointment.bundle,
    appointment.ownerProof.signedAt, appointment.lastResortPayload,
  ));
  const path = await mkdtemp('/tmp/fixdispute-tower-');
  const store = createWatchtowerStore({ dbPath: path });
  try {
    const response = await handleTowerAppointment(new Request('http://tower/api/tower/appointment', {
      method: 'PUT', body: safeStringify(appointment),
    }), store);
    expect(await response.json()).toMatchObject({ ok: false, error: 'WATCHTOWER_TRON_SUBMISSION_UNSUPPORTED: Native TRON watchtower submission is unavailable.' });
  } finally {
    await store.close();
    await rm(path, { recursive: true, force: true });
  }
  const tron = await buildDelayedLastResortAppointments(context, [{ ...watched, chainId: 728126428 }]);
  expect(tron.uploads).toHaveLength(0);
  expect(tron.failures[0]?.error).toContain('WATCHTOWER_TRON_SUBMISSION_UNSUPPORTED');
});

test.each(['exact', 'nonce', 'role', 'body', 'hash'] as const)(
  'review 2: certified N8 queues only the exact pending identity (%s)', async mismatch => {
  const { proposeAccountFrame } = await import('../../../account/consensus');
  const { createAccountConsensusContext } = await import('../../../entity/account/account-consensus-context');
  const { applyJEventRange } = await import('../../helpers/j-history');
  const { encodeInt512, decodeInt512 } = await import('../../../protocol/crypto/abi-money');
  const { env, state, account } = setup();
  // N7 is still the committed head; N8 transfers one unit and has no peer ACK.
  account.state.pulls = PersistentAccountStateMap.empty('pulls');
  const committed = buildAccountProofBodyFromJurisdictions(env.state, account);
  account.counterpartyDisputeProofNonce = 7;
  account.counterpartyDisputeProofBodyHash = committed.proofBodyHash;
  delete account.counterpartyDisputeHash;
  account.proofHeader.nextProofNonce = 8;
  account.mempool = [{ type: 'direct_payment', data: {
    tokenId: 1, amount: 1n, route: [peer], fromEntityId: owner, toEntityId: peer, deliveryMode: 'direct',
  } }];
  await proposeAccountFrame(createAccountConsensusContext(env), account, state.timestamp);
  expect(account.pendingFrame).toBeDefined();
  const pending = { ...account.pendingAccountInput!.proposal.disputeHanko! };
  expect(pending.proofNonce).toBe(8);
  expect(pending.proofBodyHash).not.toBe(committed.proofBodyHash);
  const signer = registerTestSigner(env, 'review-2');
  state.config.validators = [signer];
  state.config.shares = { [signer]: 1n };
  addReplica(env, state, signer);
  const body = { ...committed.proofBodyStruct,
    offdeltas: committed.proofBodyStruct.offdeltas.map(value => encodeInt512(decodeInt512(value) - 1n)),
  };
  const { hashProofBodyStruct } = await import('../../../protocol/dispute/proof-builder');
  expect(hashProofBodyStruct(body)).toBe(pending.proofBodyHash);
  const event = { type: 'DisputeStarted' as const, data: {
    sender: peer, counterentity: owner, nonce: '8', proposerIsLeft: true,
    proofbodyHash: pending.proofBodyHash, initialProofbody: body,
    watchSeed: body.watchSeed, starterInitialArguments: '0x', starterCounterArguments: '0x',
    starterCounterProofCommitment: ZeroHash, disputeStartTimestamp: 100,
    disputeTimeout: 100 + Number(body.leftResponseSeconds) + Number(body.rightResponseSeconds),
    leftResponseSeconds: Number(body.leftResponseSeconds), rightResponseSeconds: Number(body.rightResponseSeconds),
  } };
  const candidate = account.pendingAccountInput!.proposal.disputeHanko!;
  if (mismatch === 'nonce') candidate.proofNonce = 9;
  if (mismatch === 'role') candidate.proposerIsLeft = false;
  if (mismatch === 'body') candidate.proofBodyHash = committed.proofBodyHash;
  if (mismatch === 'hash') candidate.hash = ZeroHash;
  const result = await applyJEventRange(state, {
    from: signer, jurisdictionRef: jurisdiction.name, event,
    observedAt: 1, blockNumber: 1, blockHash: entity('ab'),
  }, env);
  const frozen = result.newState.accounts.get(peer)!;
  expect(frozen.pendingFrame).toBeUndefined();
  expect(frozen.pendingAccountInput).toBeUndefined();
  expect(buildAccountProofBodyFromJurisdictions(env.state, frozen).proofBodyHash).toBe(committed.proofBodyHash);
  if (mismatch !== 'exact') {
    expect(result.newState.jBatchState?.batch.disputeFinalizations ?? []).toHaveLength(0);
    return;
  }
  const replayed = await applyJEventRange(state, {
    from: signer, jurisdictionRef: jurisdiction.name, event,
    observedAt: 1, blockNumber: 1, blockHash: entity('ab'),
  }, env);
  expect(encodeJBatch(replayed.newState.jBatchState!.batch)).toBe(encodeJBatch(result.newState.jBatchState!.batch));
  const expected = createEmptyBatch();
  expected.disputeFinalizations.push({
    counterentity: peer, initialNonce: 8, finalNonce: 8, proposerIsLeft: true,
    initialProofbodyHash: pending.proofBodyHash, finalProofbody: body,
    starterArguments: '0x', otherArguments: '0x', sig: '0x', startedByLeft: false, cooperative: false,
  });
  expect(encodeJBatch(result.newState.jBatchState!.batch)).toBe(encodeJBatch(expected));
});
