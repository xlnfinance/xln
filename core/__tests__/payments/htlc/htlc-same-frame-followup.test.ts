import { describe, expect, test } from 'bun:test';
import { applyCommittedHtlcLockFollowup, applyHtlcSecretFollowups, applyHtlcTimeoutFollowups } from '../../../entity/tx/handlers/account/committed-htlc-followups';
import { hashOpaqueHtlcCiphertext } from '../../../protocol/htlc/multi-recipient';
import { quoteHtlcPaymentRoute } from '../../../pathfinding/htlc-quote';
import { collectDerivedDeadlines } from '../../../entity/scheduler/derived-deadlines';
import { failOriginatedPayment, HTLC_SECRET_ACK_TIMEOUT_MS } from '../../../paybook/lifecycle';
import { applyBookIntentProgram, createBookIntentProgram, type BookIntentProgram } from '../../../entity/books/book-intents';
import type { EntityState, PaybookEntry } from '../../../entity/types';
import { handleHtlcResolve } from '../../../account/tx/handlers/htlc/resolve';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { beginAccountCollectionOverlay } from '../../../account/state/account-overlay-map';
import { addr, makeJurisdiction, makeState } from '../../helpers/cross-j';

const id = (byte: string): string => `0x${byte.repeat(64)}`;
const domain = { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` };
const opaque = { version: 'xln:htlc-opaque:aes-gcm' as const, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
const secret = id('7');
const hashlock = hashHtlcSecret(secret);
const paymentState = (entries: Array<[string, PaybookEntry]> = []): EntityState => {
  const state = makeState(id('2'), addr('22'), makeJurisdiction('Ethereum', 31337, '11', '12'));
  state.timestamp = 1;
  for (const [key, entry] of entries) state.paybook.entries.set(key, entry);
  return state;
};

const setup = (kind: 'forward' | 'reject' | 'final', overrides: {
  from?: string; next?: string; frameHash?: string; state?: EntityState; program?: BookIntentProgram;
} = {}) => {
  const from = overrides.from ?? id('1');
  const to = id('2');
  const next = overrides.next ?? id('3');
  const frameHash = overrides.frameHash ?? id('6');
  const envelopeHash = hashOpaqueHtlcCiphertext(opaque);
  const lock = { lockId: hashlock, hashlock, tokenId: 1, amount: 10n, timelock: 100_000n, revealBeforeHeight: 100, envelopeHash };
  const tx = { type: 'htlc_lock' as const, data: { ...lock, envelope: opaque } };
  const frame = { stateHash: frameHash, height: 2, timestamp: 1, accountTxs: [tx] };
  const binding = { fromEntityId: from, toEntityId: to, domain, accountFrameHash: frameHash, accountHeight: 2, ...lock };
  const outcome = kind === 'forward'
    ? { kind: 'forward' as const, nextHopEntityId: next, forwardAmount: 9n, innerEnvelope: opaque }
    : kind === 'final' ? { kind: 'final' as const, secret }
      : { kind: 'reject' as const, reason: 'insufficient_capacity' as const };
  const preparedEntry = { binding, outcome };
  const state = overrides.state ?? paymentState();
  const program = overrides.program ?? createBookIntentProgram();
  const accountTxs: Array<{ accountId: string; tx: unknown }> = [];
  const context = {
    env: {}, state, newState: state, input: { fromEntityId: from, toEntityId: to, domain },
    // A committed Rust Account output is authoritative before TS body materialization.
    account: { state: { locks: new Map() } }, outputs: [], accountTxs, candidateEffects: [],
    consumedPreparedHtlcBindings: new Set<string>(),
    infraContext: { htlc: { entries: [preparedEntry] } },
    preparedHtlcEntriesByBinding: new Map([[`${frameHash}:${hashlock}`, preparedEntry]]),
    bookIntentSlot: program.openSlot(),
  };
  return { context, tx, frame, accountTxs, state, program, from, next, proposerIsLeft: from.toLowerCase() < to.toLowerCase() };
};

const applyLock = (fixture: ReturnType<typeof setup>, committedViaNewFrame = true) =>
  applyCommittedHtlcLockFollowup(fixture.context as never, fixture.tx, fixture.frame as never, fixture.proposerIsLeft, committedViaNewFrame);

const secretResolve = (accountId: string) => ({
  accountId, tx: { type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'secret', secret } },
});

describe('same-frame incoming HTLC followup', () => {
  test('Account accepts only the raw matching preimage', async () => {
    const locks = PersistentAccountStateMap.fromEntries('locks', [[hashlock, {
      lockId: hashlock, hashlock, tokenId: 1, amount: 10n, timelock: 100_000n,
      revealBeforeHeight: 100, senderIsLeft: true, createdHeight: 1, createdTimestamp: 1,
    }]]);
    const deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, {
      tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 0n,
      leftCreditLimit: 0n, rightCreditLimit: 0n, leftHold: 10n, rightHold: 0n,
    }]]);
    const draft = () => ({ locks: beginAccountCollectionOverlay(locks).view, deltas: beginAccountCollectionOverlay(deltas).view });
    const rejected = draft();
    const wrong = await handleHtlcResolve(rejected as never,
      { type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'secret', secret: id('8') } }, false, 1, 1);
    expect(wrong.ok).toBe(false);
    expect(rejected.locks.has(hashlock)).toBe(true);
    expect(rejected.deltas.get(1)?.leftHold).toBe(10n);
    const applied = draft();
    const valid = await handleHtlcResolve(applied as never,
      { type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'secret', secret } }, false, 1, 1);
    expect(valid.ok).toBe(true);
    expect(applied.locks.has(hashlock)).toBe(false);
    expect(applied.deltas.get(1)?.leftHold).toBe(0n);
    expect(applied.deltas.get(1)?.offdelta).toBe(-10n);
  });

  test('explicit route cannot quote an omitted token capacity', () => {
    expect(() => quoteHtlcPaymentRoute([{
      entityId: id('2'), entityEncryptionPublicKey: id('9'), metadata: { routingFeePPM: 1, baseFee: 0n },
      accounts: [{ counterpartyId: id('3'), domain, tokenCapacities: {} }],
    }], [id('1'), id('2'), id('3')], 7, 10n)).toThrow(`HTLC_PAYMENT_PROFILE_TOKEN_NOT_ADVERTISED:${id('2')}:${id('3')}:7`);
  });

  test('queues the outbound Account proposal without an onion-advance frame', async () => {
    const fixture = setup('forward');
    await applyLock(fixture);
    expect(fixture.accountTxs).toEqual([{
      accountId: fixture.next,
      tx: { type: 'htlc_lock', data: expect.objectContaining({ lockId: hashlock, hashlock, amount: 9n, envelope: opaque }) },
    }]);
    expect(fixture.state.paybook.entries.size).toBe(0);
    applyBookIntentProgram(fixture.state, fixture.program);
    expect(fixture.state.paybook.entries.size).toBe(1);
    expect(fixture.state.paybook.entries.get(hashlock)?.pendingFee).toBe(1n);
  });

  test('ACK replay commits the sender frame without consuming recipient onion context', async () => {
    const fixture = setup('forward');
    delete (fixture.context as { infraContext?: unknown }).infraContext;
    await applyLock(fixture, false);
    applyBookIntentProgram(fixture.state, fixture.program);
    expect(fixture.accountTxs).toEqual([]);
    expect(fixture.state.paybook.entries.size).toBe(0);
    expect(fixture.context.consumedPreparedHtlcBindings.size).toBe(0);
  });

  test('same Entity frame rejects a second peer lock with an active hashlock without replacing its payment', async () => {
    const first = setup('forward');
    await applyLock(first);
    const original = first.context.bookIntentSlot.getPaybookEntry(first.state, hashlock);
    const collision = setup('forward', { from: id('a'), next: id('b'), frameHash: id('d'), state: first.state, program: first.program });
    await applyLock(collision);
    expect(collision.accountTxs).toEqual([{
      accountId: collision.from,
      tx: { type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'error', reason: 'hashlock_already_active' } },
    }]);
    expect(collision.context.bookIntentSlot.getPaybookEntry(first.state, hashlock)).toBe(original);
    expect(original).toMatchObject({ inboundEntity: first.from, outboundEntity: first.next });
    first.accountTxs.length = 0;
    applyHtlcSecretFollowups({ ...first.context, bookIntentSlot: first.program.openSlot() } as never, [{ secret, hashlock }]);
    expect(first.accountTxs).toEqual([secretResolve(first.from)]);
    applyBookIntentProgram(first.state, first.program);
    expect(first.state.paybook.entries.size).toBe(1);
    expect(first.state.paybook.feesEarned).toBe(1n);
  });

  test('final self-cycle leg augments only its own originated payment', async () => {
    const state = paymentState([[hashlock, { hashlock, tokenId: 1, amount: 8n, originated: true, outboundEntity: id('9'), createdTimestamp: 1 }]]);
    const fixture = setup('final', { state });
    await applyLock(fixture);
    expect(fixture.accountTxs).toEqual([secretResolve(fixture.from)]);
    applyBookIntentProgram(state, fixture.program);
    expect(state.paybook.entries.get(hashlock)).toMatchObject({ originated: true, outboundEntity: id('9'), inboundEntity: fixture.from, amount: 8n });
  });

  test('queues reject and refuses consuming one prepared binding twice', async () => {
    const fixture = setup('reject');
    await applyLock(fixture);
    expect(fixture.accountTxs).toEqual([{
      accountId: id('1'), tx: { type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'error', reason: 'insufficient_capacity' } },
    }]);
    await expect(applyLock(fixture)).rejects.toThrow('HTLC_PREPARED_CONTEXT_REUSED');
    expect(fixture.accountTxs).toHaveLength(1);
  });

  test('target queues the raw preimage in the same frame without an offer phase', async () => {
    const fixture = setup('final');
    await applyLock(fixture);
    expect(fixture.accountTxs).toEqual([secretResolve(fixture.from)]);
    applyBookIntentProgram(fixture.state, fixture.program);
    expect(fixture.state.paybook.entries.get(hashlock)).toMatchObject({ inboundEntity: fixture.from, amount: 10n, tokenId: 1 });
  });

  test('committed downstream resolution queues upstream once across exact replay with a deterministic deadline', () => {
    const state = paymentState([[hashlock, { hashlock, tokenId: 1, amount: 10n, inboundEntity: id('1'), outboundEntity: id('3'), createdTimestamp: 1 }]]);
    state.timestamp = 10;
    const program = createBookIntentProgram();
    const accountTxs: Array<{ accountId: string; tx: unknown }> = [];
    const context = { env: {}, state, newState: state, outputs: [], accountTxs, candidateEffects: [] };
    applyHtlcSecretFollowups({ ...context, bookIntentSlot: program.openSlot() } as never, [{ secret, hashlock }]);
    applyHtlcSecretFollowups({ ...context, bookIntentSlot: program.openSlot() } as never, [{ secret, hashlock }]);
    applyBookIntentProgram(state, program);
    const deadline = 10 + HTLC_SECRET_ACK_TIMEOUT_MS;
    expect(accountTxs).toEqual([secretResolve(id('1'))]);
    expect(state.paybook.entries.get(hashlock)).toMatchObject({ secret, secretAckPending: true, secretAckStartedAt: 10, secretAckDeadlineAt: deadline });
    expect(collectDerivedDeadlines(state, deadline - 1)).toEqual([]);
    expect(collectDerivedDeadlines(state, deadline)).toEqual([{
      id: `htlc-secret-ack:${hashlock}`, triggerAt: deadline, type: 'htlc_secret_ack_timeout', data: { hashlock, counterpartyEntityId: id('1') },
    }]);
    state.timestamp = 20;
    const replay = createBookIntentProgram();
    applyHtlcSecretFollowups({ ...context, bookIntentSlot: replay.openSlot() } as never, [{ secret, hashlock }]);
    applyBookIntentProgram(state, replay);
    expect(accountTxs).toHaveLength(1);
    expect(state.paybook.entries.get(hashlock)?.secretAckDeadlineAt).toBe(deadline);
  });

  test('originated lock rejection emits one terminal failure before removing its Paybook entry', () => {
    const state = paymentState([[hashlock, { hashlock, originated: true, outboundEntity: id('3'), createdTimestamp: 1 }]]);
    const candidateEffects: Parameters<typeof failOriginatedPayment>[1] = [];
    expect(failOriginatedPayment(state, candidateEffects, hashlock, 'insufficient_capacity')).toBe(true);
    expect(failOriginatedPayment(state, candidateEffects, hashlock, 'insufficient_capacity')).toBe(false);
    expect(candidateEffects).toEqual([{
      kind: 'runtimeEvent', eventName: 'HtlcFailed', data: { hashlock, lockId: hashlock, reason: 'insufficient_capacity', entityId: state.entityId },
    }]);
    expect(state.paybook.entries.has(hashlock)).toBe(false);
  });

  test('downstream timeout terminates its payment and queues one upstream failure across replay', () => {
    const state = paymentState([[hashlock, { hashlock, inboundEntity: id('1'), outboundEntity: id('3'), createdTimestamp: 1 }]]);
    const program = createBookIntentProgram();
    const accountTxs: Array<{ accountId: string; tx: unknown }> = [];
    const context = { state, newState: state, accountTxs, candidateEffects: [] };
    applyHtlcTimeoutFollowups({ ...context, bookIntentSlot: program.openSlot() } as never, [hashlock]);
    applyHtlcTimeoutFollowups({ ...context, bookIntentSlot: program.openSlot() } as never, [hashlock]);
    applyBookIntentProgram(state, program);
    expect(accountTxs).toEqual([{
      accountId: id('1'), tx: { type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'error', reason: 'downstream_error' } },
    }]);
    expect(state.paybook.entries.has(hashlock)).toBe(false);
    expect(context.candidateEffects).toEqual([]);
  });
});
