import { describe, expect, test } from 'bun:test';
import { applyCommittedHtlcLockFollowup, applyHtlcSecretFollowups } from '../../../entity/tx/handlers/account/committed-htlc-followups';
import { hashOpaqueHtlcCiphertext } from '../../../protocol/htlc/multi-recipient';
import { quoteHtlcPaymentRoute } from '../../../routing/htlc-quote';
import { initCrontab } from '../../../entity/scheduler';
import { handleHtlcResolve } from '../../../account/tx/handlers/htlc/resolve';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';

const id = (byte: string): string => `0x${byte.repeat(64)}`;
const domain = { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` };
const opaque = { version: 'xln:htlc-opaque:v1' as const, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };

const setup = (kind: 'forward' | 'reject' | 'final') => {
  const from = id('1');
  const to = id('2');
  const next = id('3');
  const lockId = id('4');
  const hashlock = id('5');
  const frameHash = id('6');
  const envelopeHash = hashOpaqueHtlcCiphertext(opaque);
  const lock = { lockId, hashlock, tokenId: 1, amount: 10n, timelock: 100_000n, revealBeforeHeight: 100, envelopeHash };
  const tx = { type: 'htlc_lock' as const, data: { ...lock, envelope: opaque } };
  const frame = { stateHash: frameHash, height: 2, timestamp: 1, accountTxs: [tx] };
  const binding = {
    fromEntityId: from, toEntityId: to, domain, accountFrameHash: frameHash, accountHeight: 2,
    lockId, envelopeHash, hashlock, tokenId: 1, amount: 10n, timelock: 100_000n, revealBeforeHeight: 100,
  };
  const accountTxs: Array<{ accountId: string; tx: unknown }> = [];
  const state = { entityId: to, timestamp: 1, htlcRoutes: new Map(), lockBook: new Map() };
  const outcome = kind === 'forward'
    ? { kind: 'forward' as const, nextHopEntityId: next, forwardAmount: 9n, innerEnvelope: opaque }
    : kind === 'final'
      ? { kind: 'final' as const, secret: id('7') }
      : { kind: 'reject' as const, reason: 'next_hop_offline' as const };
  const consumedPreparedHtlcBindings = new Set<string>();
  const context = {
    env: {}, state, newState: state,
    input: { fromEntityId: from, toEntityId: to, domain },
    account: { state: { locks: new Map([[lockId, lock]]) } }, outputs: [], accountTxs,
    candidateEffects: [], consumedPreparedHtlcBindings,
    infraContext: { htlc: { entries: [{ binding, outcome }] } },
  };
  return { context, tx, frame, accountTxs, state, next };
};

describe('same-frame incoming HTLC followup', () => {
  test('Account accepts only the raw matching preimage', async () => {
    const secret = id('7');
    const account = {
      locks: new Map([[id('4'), {
        lockId: id('4'), hashlock: hashHtlcSecret(secret), tokenId: 1, amount: 10n,
        timelock: 100_000n, revealBeforeHeight: 100, senderIsLeft: true,
        createdHeight: 1, createdTimestamp: 1,
      }]]),
      deltas: new Map([[1, {
        tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 0n,
        leftCreditLimit: 0n, rightCreditLimit: 0n, leftHold: 10n, rightHold: 0n,
      }]]),
    };
    const wrong = await handleHtlcResolve(
      structuredClone(account) as never,
      { type: 'htlc_resolve', data: { lockId: id('4'), outcome: 'secret', secret: id('8') } },
      false, 1, 1,
    );
    expect(wrong.success).toBe(false);
    const applied = structuredClone(account);
    const valid = await handleHtlcResolve(
      applied as never,
      { type: 'htlc_resolve', data: { lockId: id('4'), outcome: 'secret', secret } },
      false, 1, 1,
    );
    expect(valid.success).toBe(true);
    expect(applied.locks.has(id('4'))).toBe(false);
  });

  test('explicit route cannot quote an omitted token capacity', () => {
    expect(() => quoteHtlcPaymentRoute([{
      entityId: id('2'), entityEncryptionPublicKey: id('9'),
      metadata: { routingFeePPM: 1, baseFee: 0n },
      accounts: [{ counterpartyId: id('3'), domain, tokenCapacities: {} }],
    }], [id('1'), id('2'), id('3')], 7, 10n)).toThrow(
      `HTLC_PAYMENT_PROFILE_TOKEN_NOT_ADVERTISED:${id('2')}:${id('3')}:7`,
    );
  });

  test('queues the outbound Account proposal without an onion-advance frame', async () => {
    const fixture = setup('forward');
    await applyCommittedHtlcLockFollowup(fixture.context as never, fixture.tx, fixture.frame as never, true);
    expect(fixture.accountTxs).toEqual([{
      accountId: fixture.next,
      tx: { type: 'htlc_lock', data: expect.objectContaining({ amount: 9n, envelope: opaque }) },
    }]);
    expect(fixture.state.htlcRoutes.size).toBe(1);
  });

  test('queues reject and refuses consuming one prepared binding twice', async () => {
    const fixture = setup('reject');
    await applyCommittedHtlcLockFollowup(fixture.context as never, fixture.tx, fixture.frame as never, true);
    expect(fixture.accountTxs[0]).toEqual(expect.objectContaining({ accountId: id('1') }));
    await expect(applyCommittedHtlcLockFollowup(fixture.context as never, fixture.tx, fixture.frame as never, true))
      .rejects.toThrow('HTLC_PREPARED_CONTEXT_REUSED');
  });

  test('target queues the raw preimage in the same frame without an offer phase', async () => {
    const fixture = setup('final');
    await applyCommittedHtlcLockFollowup(fixture.context as never, fixture.tx, fixture.frame as never, true);
    expect(fixture.accountTxs).toEqual([{
      accountId: id('1'),
      tx: { type: 'htlc_resolve', data: { lockId: id('4'), outcome: 'secret', secret: id('7') } },
    }]);
  });

  test('committed downstream resolution queues upstream once across exact replay', () => {
    const secret = id('7');
    const hashlock = id('5');
    const accountTxs: Array<{ accountId: string; tx: unknown }> = [];
    const state = {
      entityId: id('2'), timestamp: 10, htlcFeesEarned: 0n, crontabState: initCrontab(),
      htlcRoutes: new Map([[hashlock, {
        hashlock, tokenId: 1, amount: 10n, inboundEntity: id('1'), inboundLockId: id('4'),
        outboundEntity: id('3'), outboundLockId: id('8'), createdTimestamp: 1,
      }]]),
      lockBook: new Map(),
    };
    const context = {
      env: {}, state, newState: state, outputs: [], accountTxs, candidateEffects: [],
    };
    applyHtlcSecretFollowups(context as never, [{ secret, hashlock }]);
    const durableAckDeadline = state.htlcRoutes.get(hashlock)?.secretAckDeadlineAt;
    applyHtlcSecretFollowups(context as never, [{ secret, hashlock }]);
    expect(accountTxs).toEqual([{
      accountId: id('1'),
      tx: { type: 'htlc_resolve', data: { lockId: id('4'), outcome: 'secret', secret } },
    }]);
    expect(state.htlcRoutes.get(hashlock)).toMatchObject({
      secret,
      secretAckPending: true,
      secretAckDeadlineAt: durableAckDeadline,
    });
    expect(state.crontabState.hooks.has(`htlc-secret-ack:${hashlock}`)).toBe(true);
  });
});
