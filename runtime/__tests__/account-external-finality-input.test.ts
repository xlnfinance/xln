import { expect, test } from 'bun:test';

import { applyAccountInput } from '../account/consensus';
import { createAccountDisputeFinalityInput } from '../account/input';
import { cloneIsolatedAccountInput } from '../protocol/account-input-clone';
import { createEmptyEnv } from '../runtime';
import { addr, makeAccount } from './helpers/cross-j';

test('authenticated J finality enters the canonical AccountInput boundary', async () => {
  const leftEntity = `0x${'11'.repeat(32)}`;
  const rightEntity = `0x${'22'.repeat(32)}`;
  const account = makeAccount(leftEntity, rightEntity, {
    chainId: 31_337,
    depositoryAddress: addr('dd'),
  });
  const delta = account.deltas.get(1)!;
  delta.collateral = 7n;
  delta.ondelta = 3n;
  delta.offdelta = -2n;
  delta.leftHold = 1n;

  const input = createAccountDisputeFinalityInput(
    account,
    leftEntity,
    4,
    [1],
  );
  const cloned = cloneIsolatedAccountInput(input);
  expect(cloned).toEqual(input);
  expect(cloned).not.toBe(input);
  expect(cloned.finality.finalizedTokenIds).not.toBe(
    input.finality.finalizedTokenIds,
  );

  const result = await applyAccountInput(
    createEmptyEnv('account-external-finality'),
    account,
    cloned,
  );

  expect(result.success).toBe(true);
  expect(result.externalFinality).toEqual({
    hadActiveDispute: false,
    hadSettlementWorkspace: false,
    removedSettlementTxs: 0,
  });
  expect(account.currentHeight).toBe(0);
  expect(account.jNonce).toBe(4);
  expect(account.status).toBe('disputed');
  expect(account.deltas.get(1)).toMatchObject({
    collateral: 0n,
    ondelta: 0n,
    offdelta: 0n,
    leftHold: 0n,
  });
});

test('external finality rejects an entity outside the bilateral account', () => {
  const account = makeAccount(
    `0x${'11'.repeat(32)}`,
    `0x${'22'.repeat(32)}`,
  );
  expect(() =>
    createAccountDisputeFinalityInput(
      account,
      `0x${'33'.repeat(32)}`,
      1,
      [],
    ),
  ).toThrow('ACCOUNT_FINALITY_INPUT_OWNER_MISMATCH');
});
