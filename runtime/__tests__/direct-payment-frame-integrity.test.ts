import { describe, expect, test } from 'bun:test';

import { handleDirectPayment } from '../account-tx/handlers/direct-payment';
import { computeFrameHash } from '../account-consensus-frame';
import type { AccountFrame, AccountMachine, AccountTx } from '../types';
import { createDefaultDelta } from '../validation-utils';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;

async function makeHashedFrame(): Promise<AccountFrame> {
  const delta = {
    ...createDefaultDelta(1),
    collateral: 1_000n,
  };
  const frame: AccountFrame = {
    height: 1,
    timestamp: 1,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: `0x${'00'.repeat(32)}`,
    stateHash: '',
    byLeft: true,
    deltas: [{ ...delta }],
  };
  frame.stateHash = await computeFrameHash(frame);
  return frame;
}

async function makeAccount(): Promise<AccountMachine> {
  const delta = {
    ...createDefaultDelta(1),
    collateral: 1_000n,
  };
  return {
    proofHeader: { fromEntity: RIGHT, toEntity: LEFT, nextProofNonce: 1 },
    leftEntity: LEFT,
    rightEntity: RIGHT,
    leftEntityId: LEFT,
    rightEntityId: RIGHT,
    status: 'active',
    currentHeight: 1,
    currentFrame: await makeHashedFrame(),
    deltas: new Map([[1, delta]]),
    collateral: new Map(),
    requestedRebalance: new Map(),
    mempool: [],
  } as unknown as AccountMachine;
}

describe('direct payment frame integrity', () => {
  test('updates live deltas without mutating the hashed current frame', async () => {
    const account = await makeAccount();
    const frameHashBefore = account.currentFrame.stateHash;
    const frameJsonBefore = JSON.stringify(account.currentFrame, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    const tx: Extract<AccountTx, { type: 'direct_payment' }> = {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 100n,
        route: [RIGHT, LEFT],
        fromEntityId: RIGHT,
        toEntityId: LEFT,
        description: 'integrity-regression',
      },
    };

    const result = handleDirectPayment(account, tx, false);

    expect(result.success).toBe(true);
    expect(account.deltas.get(1)?.offdelta).toBe(100n);
    expect(account.currentFrame.stateHash).toBe(frameHashBefore);
    expect(await computeFrameHash(account.currentFrame)).toBe(frameHashBefore);
    expect(JSON.stringify(account.currentFrame, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    )).toBe(frameJsonBefore);
  });

  test('derives payer from frame proposer and rejects forged direction fields', async () => {
    const account = await makeAccount();
    const forged: Extract<AccountTx, { type: 'direct_payment' }> = {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 100n,
        fromEntityId: LEFT,
        toEntityId: RIGHT,
      },
    };

    const result = handleDirectPayment(account, forged, false);
    expect(result.success).toBe(false);
    expect(result.error).toContain('must match the frame proposer');
    expect(account.deltas.get(1)?.offdelta).toBe(0n);
  });
});
