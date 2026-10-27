import { expect, test } from 'bun:test';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { computeFrameHash } from '../../../account/consensus/frame/hash';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { assertAccountLendingCovenants } from '../../../protocol/dispute/lending-covenant';
import { decodeValidatedBuffer, encodeBuffer } from '../../../storage/codec/codec';
import { hydrateAccountDocFromStorage, projectPortableAccountDoc } from '../../../storage/read/projections';
import { validateStorageAccountDocValue } from '../../../storage/schema/authoritative-schema';
import type { AccountReplica, AccountTx } from '../../../types/account';
import { entity, makeAccount, putTestAccountDelta } from '../../helpers/cross-j';

const LEFT = entity('11');
const RIGHT = entity('22');
const POSITION = 'lend-1111111111111111';
const MATURITY = 86_401_000;
const CLOSE_KEY = `close:${POSITION}`;

const funded = async (saverIsLeft: boolean) => {
  const account = makeAccount(LEFT, RIGHT);
  putTestAccountDelta(account, { ...account.state.deltas.get(1)!, collateral: 20_000n, ondelta: 10_000n });
  const lenderEntityId = saverIsLeft ? LEFT : RIGHT;
  const hubEntityId = saverIsLeft ? RIGHT : LEFT;
  const fund: AccountTx = {
    type: 'lending_fund',
    data: {
      positionId: POSITION,
      lenderEntityId,
      hubEntityId,
      tokenId: 1,
      amount: 10_000n,
      termId: '1d',
      interestBps: 100,
    },
  };
  expect((await applyAccountTxToMutableReplica(account, fund, saverIsLeft, 1_000)).ok).toBe(true);
  const request: AccountTx = {
    type: 'lending_close_request',
    data: { positionId: POSITION, lenderEntityId, hubEntityId },
  };
  const payout = (amount: bigint): AccountTx => ({
    type: 'lending_close_payout',
    data: {
      positionId: POSITION,
      lenderEntityId,
      hubEntityId,
      tokenId: 1,
      amount,
    },
  });
  return { account, request, payout };
};

// This L1 exercises the canonical storage decoder; signed frames and ordered
// Runtime WAL recovery are exercised by lending-real-crash-recovery.test.ts.
const restore = (account: AccountReplica, timestamp: number): AccountReplica => {
  account.currentFrame = {
    ...account.currentFrame,
    height: 1,
    timestamp,
    accountStateRoot: computeAccountStateRoot(account.state),
    prevFrameHash: 'genesis',
  };
  account.currentFrame.stateHash = computeFrameHash(account.currentFrame);
  account.currentHeight = 1;
  const doc = decodeValidatedBuffer(encodeBuffer(projectPortableAccountDoc(account)), validateStorageAccountDocValue);
  const restored = hydrateAccountDocFromStorage(doc);
  expect(computeAccountStateRoot(restored.state)).toBe(computeAccountStateRoot(account.state));
  return restored;
};

for (const saverIsLeft of [true, false]) {
  test(`fixed savings rejects an unsolicited bank payout before and after maturity, saverLeft=${saverIsLeft}`, async () => {
    const { account, payout } = await funded(saverIsLeft);
    const before = computeAccountStateRoot(account.state);
    for (const timestamp of [MATURITY - 1, MATURITY, MATURITY + 1])
      for (const amount of [10_000n, 10_100n]) {
        const result = await applyAccountTxToMutableReplica(account, payout(amount), !saverIsLeft, timestamp);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Unrequested savings payout accepted');
        expect(result.rejection.message).toBe('LENDING_SAVINGS_CLOSE_AUTHORIZATION_REQUIRED');
        expect(computeAccountStateRoot(account.state)).toBe(before);
        expect(account.state.subcontracts?.has(POSITION)).toBe(true);
      }
  });

  for (const requestAt of [MATURITY - 1, MATURITY, MATURITY + 1]) {
    test(`first savings close choice survives retry and restore, saverLeft=${saverIsLeft}, requestAt=${requestAt}`, async () => {
      const fixture = await funded(saverIsLeft);
      let account = fixture.account;
      const early = requestAt < MATURITY;
      const expectedAmount = early ? 10_000n : 10_100n;
      expect((await applyAccountTxToMutableReplica(account, fixture.request, saverIsLeft, requestAt)).ok).toBe(true);
      expect(account.state.lendingIntents?.get(CLOSE_KEY)).toBe(early ? 'close-early' : 'close-mature');
      const authorizedRoot = computeAccountStateRoot(account.state);
      account = restore(account, requestAt);
      expect((await applyAccountTxToMutableReplica(account, fixture.request, saverIsLeft, MATURITY + 10_000)).ok).toBe(
        true,
      );
      expect(computeAccountStateRoot(account.state)).toBe(authorizedRoot);
      for (const invalidAmount of early ? [10_100n] : [10_000n, 10_099n]) {
        const result = await applyAccountTxToMutableReplica(
          account,
          fixture.payout(invalidAmount),
          !saverIsLeft,
          MATURITY + 20_000,
        );
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Savings close choice changed');
        expect(result.rejection.message).toBe('LENDING_SAVINGS_PAYOUT_AMOUNT_MISMATCH');
        expect(computeAccountStateRoot(account.state)).toBe(authorizedRoot);
      }
      const paid = await applyAccountTxToMutableReplica(
        account,
        fixture.payout(expectedAmount),
        !saverIsLeft,
        MATURITY + 20_000,
      );
      expect(paid.ok).toBe(true);
      expect(account.state.subcontracts?.has(POSITION)).toBe(false);
      expect(account.state.lendingIntents?.get(`payout:${POSITION}`)).toBe('close-payout');
      expect(account.state.deltas.get(1)!.offdelta).toBe((saverIsLeft ? 1n : -1n) * (expectedAmount - 10_000n));
      const paidRoot = computeAccountStateRoot(account.state);
      await expect(
        applyAccountTxToMutableReplica(account, fixture.payout(expectedAmount), !saverIsLeft, MATURITY + 30_000),
      ).resolves.toMatchObject({ ok: false, rejection: { message: expect.stringContaining('LENDING_INTENT_REPLAY') } });
      expect((await applyAccountTxToMutableReplica(account, fixture.request, saverIsLeft, MATURITY + 30_000)).ok).toBe(
        false,
      );
      expect(computeAccountStateRoot(account.state)).toBe(paidRoot);
    });
  }

  test(`only the saver authorizes the close and its choice changes the root, saverLeft=${saverIsLeft}`, async () => {
    const early = await funded(saverIsLeft);
    const mature = await funded(saverIsLeft);
    const before = computeAccountStateRoot(early.account.state);
    await expect(
      applyAccountTxToMutableReplica(early.account, early.request, !saverIsLeft, MATURITY - 1),
    ).resolves.toMatchObject({ ok: false, rejection: { message: expect.stringContaining('LENDING_LENDER_NOT_PROPOSER') } });
    expect(computeAccountStateRoot(early.account.state)).toBe(before);
    expect((await applyAccountTxToMutableReplica(early.account, early.request, saverIsLeft, MATURITY - 1)).ok).toBe(
      true,
    );
    expect((await applyAccountTxToMutableReplica(mature.account, mature.request, saverIsLeft, MATURITY)).ok).toBe(true);
    expect(computeAccountStateRoot(early.account.state)).not.toBe(computeAccountStateRoot(mature.account.state));
  });
}

test('obsolete fixed savings requests without a committed close choice fail cold restore', async () => {
  const { account } = await funded(true);
  account.state = {
    ...account.state,
    lendingIntents: PersistentAccountStateMap.fromEntries('lendingIntents', [
      [`fund:${POSITION}`, 'fund'],
      [CLOSE_KEY, 'close-request'],
    ]),
  };
  expect(() => assertAccountLendingCovenants(account.state)).toThrow('LENDING_CLOSE_AUTHORIZATION_FORMAT_UNSUPPORTED');
  expect(() => restore(account, MATURITY)).toThrow('LENDING_CLOSE_AUTHORIZATION_FORMAT_UNSUPPORTED');
});
