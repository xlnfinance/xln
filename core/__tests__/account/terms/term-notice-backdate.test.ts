import { expect, test } from 'bun:test';
import { makeAccount, entity, registerTestSigner } from '../../helpers/cross-j';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { getIncomingAccountDeadlineViolation } from '../../../account/consensus/dispute/deadline-policy';
import { buildProposalFrame } from '../../../account/consensus/proposal/frame';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { createEmptyEnv } from '../../../runtime';
import { encodeBuffer, decodeBuffer } from '../../../storage/codec/codec';
import { hydrateAccountDocFromStorage, projectPortableAccountDoc } from '../../../storage/read/projections';
import { validateStorageAccountDocValue } from '../../../storage/schema/schema-state-docs';
import type { AccountInput, AccountReplica, AccountTx } from '../../../types/account';
import { generateLazyEntityId } from '../../../entity/factory';
import { signEntityHashes } from '../../../hanko/signing';
import { preflightIncomingAccountFrame } from '../../../account/consensus/incoming/preflight';
import { commitAccountFrameTransition } from '../../../account/consensus/frame/commit-transition';
import { createAccountJClaimSession } from '../../../account/j-claims/j-claim-session';
import { applyAccountInput } from '../../../account/consensus';
import { ACCOUNT_NETWORK_ALLOWANCE_MS } from '../../../account/consensus/constants';
import { getAccountFrameStructuralError } from '../../../account/consensus/frame/hash';

const policy = (version: number, baseFee: bigint, noticePeriodSeconds = 2): AccountTx => ({
  type: 'rebalance_policy',
  data: { tokenId: 1, policyVersion: version, baseFee, gasFee: 1n, liquidityFeeBps: 10n, noticePeriodSeconds },
});
const apply = (account: AccountReplica, tx: AccountTx, timestamp: number, byLeft = true) =>
  applyAccountTxToMutableReplica(account, tx, byLeft, timestamp, 0);
const restore = (account: AccountReplica) => hydrateAccountDocFromStorage(
  validateStorageAccountDocValue(decodeBuffer(encodeBuffer(projectPortableAccountDoc(account)))),
);
const context = createAccountConsensusContext(createEmptyEnv('notice-backdate'));
const receiverClock = (entityTimestamp: number) => ({
  entityTimestamp, finalizedJHeight: 0, owningEntityIsHub: false, verifyHanko: context.verifyHanko,
});
const makeFrame = async (account: AccountReplica, txs: AccountTx[], timestamp: number, byLeft = true) => {
  const candidate = forkAccountReplicaShell(account);
  for (const tx of txs) expect((await apply(candidate, tx, timestamp, byLeft)).ok).toBe(true);
  const built = await buildProposalFrame(account, candidate, txs, timestamp, 0, [], () => {});
  if (!built.ok) throw new Error('notice frame rejected');
  return built.frame;
};

test.each([10_000, 70_000])('delayed adverse announcement at %s preserves the full receiver notice', async announcedAt => {
  const account = makeAccount(entity('11'), entity('22'));
  await apply(account, policy(1, 10n), 1000);
  const frame = await makeFrame(account, [policy(2, 30n)], announcedAt);
  const receivedAt = announcedAt + ACCOUNT_NETWORK_ALLOWANCE_MS;
  expect(getIncomingAccountDeadlineViolation(account.state, frame, true, receiverClock(receivedAt))).toBeUndefined();
  expect(getIncomingAccountDeadlineViolation(account.state, frame, true, receiverClock(receivedAt + 1))?.reason)
    .toContain('REBALANCE_POLICY_NOTICE_TOO_SHORT');
  await apply(account, policy(2, 30n), announcedAt);
  expect(account.state.rebalanceFeePolicies!.get(1)!.left!.effectiveAt).toBe(receivedAt + 2000);
  // Signed at 10,000/70,000, first delivered at 40,000/100,000: v2 must
  // not charge the customer one millisecond after the first announcement.
  for (const [time, version, fee] of [[receivedAt + 1, 1, 21n], [receivedAt + 1999, 1, 21n],
    [receivedAt + 2000, 2, 41n]] as const) {
    const copy = forkAccountReplicaShell(account);
    expect((await apply(copy, { type: 'request_collateral', data: {
      tokenId: 1, amount: 10_000n, policyVersion: version, feeAmount: fee,
    } }, time, false)).ok).toBe(true);
  }
});

test.each([10n, 30n, 5n])('newer policy with fee %s cannot regress updatedAt; rejection survives restart', async fee => {
  const account = makeAccount(entity('11'), entity('22'));
  expect((await apply(account, policy(1, 10n), 10_000)).ok).toBe(true);
  const root = computeAccountStateRoot(account.state);
  // The announcing side owns its version/terms, not permission to backdate
  // v2 before v1 and activate a 2s adverse notice immediately at receiver time.
  const rejected = await apply(account, policy(2, fee), 1000);
  expect(rejected.ok).toBe(false);
  if (rejected.ok) throw new Error('backdated policy accepted');
  expect(rejected.rejection.message).toContain('REBALANCE_POLICY_TIMESTAMP_REGRESSION');
  expect(computeAccountStateRoot(account.state)).toBe(root);
  const replay = restore(account);
  expect((await apply(replay, policy(2, fee), 1000)).ok).toBe(false);
  expect(computeAccountStateRoot(replay.state)).toBe(root);
  for (const target of [account, replay]) {
    expect((await apply(target, policy(2, fee), 10_000)).ok).toBe(true);
  }
  expect(computeAccountStateRoot(replay.state)).toBe(computeAccountStateRoot(account.state));
  expect(computeAccountStateRoot(restore(replay).state)).toBe(computeAccountStateRoot(account.state));
});

test.each([true, false])('idle receiver rejects stale adverse notice for announcing side %s', async byLeft => {
  const account = makeAccount(entity('11'), entity('22'));
  expect((await apply(account, policy(1, 10n), 1000, byLeft)).ok).toBe(true);
  const frame = await makeFrame(account, [policy(2, 30n)], 2000, byLeft);
  const root = computeAccountStateRoot(account.state);
  const violation = getIncomingAccountDeadlineViolation(account.state, frame, byLeft, receiverClock(40_001));
  expect(violation?.disposition).toBe('reject');
  expect(violation?.reason).toContain('REBALANCE_POLICY_NOTICE_TOO_SHORT');
  expect(computeAccountStateRoot(account.state)).toBe(root);
  const replay = restore(account);
  expect(getIncomingAccountDeadlineViolation(replay.state, frame, byLeft, receiverClock(40_001))).toEqual(violation);
  const fresh = await makeFrame(account, [policy(2, 30n)], 10_000, byLeft);
  expect(getIncomingAccountDeadlineViolation(account.state, fresh, byLeft, receiverClock(10_000))).toBeUndefined();
  for (const ahead of [1, ACCOUNT_NETWORK_ALLOWANCE_MS]) {
    expect(getIncomingAccountDeadlineViolation(account.state, fresh, byLeft, receiverClock(10_000 + ahead))).toBeUndefined();
  }
  expect(getIncomingAccountDeadlineViolation(account.state, fresh, byLeft,
    receiverClock(10_001 + ACCOUNT_NETWORK_ALLOWANCE_MS))?.disposition).toBe('reject');
});

test('receiver notice admission follows ordered policies, including a shortened notice', async () => {
  const account = makeAccount(entity('11'), entity('22'));
  await apply(account, policy(1, 10n, 30), 1000);
  const frame = await makeFrame(account, [policy(2, 5n, 30), policy(3, 5n, 1)], 2000);
  const violation = getIncomingAccountDeadlineViolation(account.state, frame, true, receiverClock(40_001));
  expect(violation?.reason).toContain('REBALANCE_POLICY_NOTICE_TOO_SHORT');
  expect(violation?.reason).toContain('version=3');
  const initial = makeAccount(entity('11'), entity('22'));
  const bundled = await makeFrame(initial, [policy(1, 10n), policy(2, 30n)], 2000);
  expect(getIncomingAccountDeadlineViolation(initial.state, bundled, true, receiverClock(40_001))?.disposition).toBe('reject');
});

test('exact policy retries, stale versions, initial terms and improvements stay idempotent', async () => {
  const account = makeAccount(entity('11'), entity('22'));
  await apply(account, policy(1, 10n), 10_000);
  await apply(account, policy(2, 30n), 11_000);
  const root = computeAccountStateRoot(account.state);
  // Version equality is checked before the new-version timestamp constraint.
  expect((await apply(account, policy(2, 30n), 1000)).ok).toBe(true);
  expect((await apply(account, policy(1, 99n), 1000)).ok).toBe(true);
  expect(computeAccountStateRoot(account.state)).toBe(root);
  for (const tx of [policy(2, 30n), policy(1, 99n), policy(3, 5n)]) {
    const frame = await makeFrame(account, [tx], 11_000);
    expect(getIncomingAccountDeadlineViolation(account.state, frame, true, receiverClock(99_000))).toBeUndefined();
  }
  const fresh = makeAccount(entity('11'), entity('22'));
  const first = await makeFrame(fresh, [policy(1, 30n)], 1000);
  expect(getIncomingAccountDeadlineViolation(fresh.state, first, true, receiverClock(99_000))).toBeUndefined();
});

test('authenticated receiver rejects, restarts, accepts re-proposal and retries the certified frame', async () => {
  const env = createEmptyEnv('notice-signed-receiver');
  const seed = `0x${'7a'.repeat(32)}`;
  const parties = ['1', '2'].map(slot => {
    const signerId = registerTestSigner(env, seed, slot);
    return { signerId, entityId: generateLazyEntityId([signerId], 1n).toLowerCase() };
  }).sort((a, b) => a.entityId.localeCompare(b.entityId));
  const [left, right] = parties;
  if (!left || !right) throw new Error('notice signers missing');
  let account = makeAccount(right.entityId, left.entityId);
  const signedContext = createAccountConsensusContext(env);
  const clock = { ...receiverClock(40_001), verifyHanko: signedContext.verifyHanko };
  const inputFor = async (frame: AccountReplica['currentFrame']): Promise<AccountInput> => ({
    kind: 'ack_frame', fromEntityId: left.entityId, toEntityId: right.entityId,
    domain: account.state.domain, disputeConfig: account.state.disputeConfig, watchSeed: account.state.watchSeed,
    proposal: { frame, frameHanko: (await signEntityHashes(env, left.entityId, left.signerId, [frame.stateHash]))[0]! },
  });
  const certify = async (frame: AccountReplica['currentFrame']) => {
    await commitAccountFrameTransition({
      context: signedContext, account, frame, proposerIsLeft: true,
      jClaimSession: createAccountJClaimSession(new Map()), role: 'receiver/collision-commit',
    });
    account.currentFrame = frame;
    account.currentHeight = frame.height;
    account.currentFrameHanko = (await signEntityHashes(env, right.entityId, right.signerId, [frame.stateHash]))[0]!;
    account.counterpartyFrameHanko = (await signEntityHashes(env, left.entityId, left.signerId, [frame.stateHash]))[0]!;
  };
  await certify(await makeFrame(account, [policy(1, 10n)], 1000));
  const stale = await inputFor(await makeFrame(account, [policy(2, 30n)], 2000));
  const root = computeAccountStateRoot(account.state);
  const preflight = (input: AccountInput, entityTimestamp = 40_001) => preflightIncomingAccountFrame(
    account, input, undefined, [], [], { ...clock, entityTimestamp },
  );
  for (const restart of [false, true]) {
    if (restart) account = restore(account);
    const result = await preflight(stale);
    expect(result.kind).toBe('return');
    if (result.kind !== 'return') throw new Error('stale notice accepted');
    expect(result.result).toMatchObject({ ok: false, disposition: 'rejected', rejection: {
      code: 'ACCOUNT_INPUT_FRAME_DEADLINE_INVALID',
    } });
    expect(computeAccountStateRoot(account.state)).toBe(root);
  }
  const fresh = await makeFrame(account, [policy(2, 30n)], 10_000);
  const input = await inputFor(fresh);
  expect((await preflight(input, 10_001)).kind).toBe('continue');
  await certify(fresh);
  account = restore(account);
  const certifiedRoot = computeAccountStateRoot(account.state);
  const duplicate = await applyAccountInput(signedContext, account, input, { ...clock, entityTimestamp: 99_000 });
  expect(duplicate).toMatchObject({ ok: true, response: {
    kind: 'ack', ack: { height: fresh.height, frameHash: fresh.stateHash, frameHanko: account.currentFrameHanko },
  } });
  expect(duplicate.ok && duplicate.hashesToSign).toBeUndefined();
  expect(computeAccountStateRoot(account.state)).toBe(certifiedRoot);
  expect(account.currentHeight).toBe(fresh.height);
  // An unrelated certified frame can cross activation. Retrying its exact
  // certificate with an earlier receiver clock must still reuse the ACK.
  const crossing = await makeFrame(account, [{ type: 'add_delta', data: { tokenId: 2 } }], 42_000);
  const crossingInput = await inputFor(crossing);
  for (const early of [crossingInput, await inputFor(await makeFrame(account, [policy(3, 20n)], 42_000))]) {
    const result = await preflight(early, 40_001);
    expect(result.kind).toBe('return');
    if (result.kind !== 'return') throw new Error('early activation accepted');
    expect(result.result).toMatchObject({ ok: false, disposition: 'rejected', rejection: {
      code: 'ACCOUNT_INPUT_FRAME_DEADLINE_INVALID',
    } });
    expect(computeAccountStateRoot(account.state)).toBe(certifiedRoot);
  }
  expect((await preflight(crossingInput, 42_000)).kind).toBe('continue');
  await certify(crossing);
  account = restore(account);
  const crossedRoot = computeAccountStateRoot(account.state);
  const retry = await applyAccountInput(signedContext, account, crossingInput, { ...clock, entityTimestamp: 40_001 });
  expect(retry).toMatchObject({ ok: true, response: { kind: 'ack', ack: { frameHash: crossing.stateHash } } });
  expect(computeAccountStateRoot(account.state)).toBe(crossedRoot);
  expect(account.currentHeight).toBe(crossing.height);
});

test.each([true, false])('receiver clock prevents early activation on either policy side %s', async policyIsLeft => {
  const account = makeAccount(entity('11'), entity('22'));
  await apply(account, policy(1, 10n), 1000, policyIsLeft);
  await apply(account, policy(2, 30n), 10_000, policyIsLeft);
  const root = computeAccountStateRoot(account.state);
  for (const [proposerIsLeft, txs] of [
    [policyIsLeft, [policy(3, 20n)]],
    [true, [{ type: 'add_delta', data: { tokenId: 2 } }]],
    [false, [{ type: 'add_delta', data: { tokenId: 2 } }]],
  ] satisfies Array<[boolean, AccountTx[]]>) {
    const frame = await makeFrame(account, txs, 42_000, proposerIsLeft);
    expect(getAccountFrameStructuralError(frame, 40_001)).toBe('');
    for (const target of [account, restore(account)]) {
      const violation = getIncomingAccountDeadlineViolation(target.state, frame, proposerIsLeft, receiverClock(40_001));
      expect(violation?.reason).toContain('REBALANCE_POLICY_ACTIVATION_BEFORE_RECEIVER');
      expect(violation?.disposition).toBe('reject');
      expect(computeAccountStateRoot(target.state)).toBe(root);
    }
    expect(getIncomingAccountDeadlineViolation(account.state, frame, proposerIsLeft, receiverClock(42_000))).toBeUndefined();
    const before = await makeFrame(account, txs, 41_999, proposerIsLeft);
    expect(getIncomingAccountDeadlineViolation(account.state, before, proposerIsLeft, receiverClock(40_001))).toBeUndefined();
  }
  // The rejected replacement would erase v1 and admit a v3-priced request 1999ms early.
  const attack = forkAccountReplicaShell(account);
  await apply(attack, policy(3, 20n), 42_000, policyIsLeft);
  expect(attack.state.rebalanceFeePolicies!.get(1)![policyIsLeft ? 'left' : 'right']!.previous).toBeUndefined();
  expect((await apply(attack, { type: 'request_collateral', data: {
    tokenId: 1, amount: 10_000n, feeAmount: 31n, policyVersion: 3,
  } }, 40_001, !policyIsLeft)).ok).toBe(true);
});
