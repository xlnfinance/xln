/**
 * Accounts-level Merkle parity: the Rust account module owns a radix-16
 * Patricia tree over all accounts (leaf = per-account payment-profile state
 * root, key = 32-byte account id). This test pins that tree bit-for-bit
 * against the same data model built with the TypeScript persistent radix map:
 * restore N prefix-splitting accounts over the live process wire, compare the
 * 32-byte root from the Restore reply, then apply a payment wave through
 * Prepare -> Commit and compare the rebranched root from the Commit reply.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { applyAccountTxToMutableReplica } from '../../core/account/tx/apply';
import { computeAccountStateRoot } from '../../core/account/commitment/state-root';
import { createDefaultDelta } from '../../core/account/state/delta';
import { PersistentAccountStateMap } from '../../core/account/state/persistent-state-map';
import { PersistentRadixValueMap } from '../../core/protocol/state/persistent-radix-value-map';
import type { AccountReplica, AccountTx, Delta } from '../../core/types/account';
import { addr, entity, makeAccount } from '../../core/__tests__/helpers/cross-j';
import { RscoreProcessClient, type RscoreWireValue } from '../../core/rscore/client';

const BINARY = join(import.meta.dir, '../../rscore/target/release/xln-rscore');

const DEPOSITORY = addr('88');
const WATCH_SEED = entity('99');
const CHAIN_ID = 31_337;
const RESPONSE_SECONDS: [number, number] = [10, 10];

// Account ids exercise every rebranch shape: 0x...01/0x...02 split a leaf at
// the last nibble, 0x01000000 splits the deep zero extension, 0x80... forces
// a top-level branch slot.
const ACCOUNT_IDS = [
  `0x${'00'.repeat(28)}00000001`,
  `0x${'00'.repeat(28)}00000002`,
  `0x${'00'.repeat(28)}01000000`,
  `0x80${'00'.repeat(27)}00000001`,
] as const;

const hexBytes = (value: string): Uint8Array => {
  const clean = value.slice(2);
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

// Distinct entity pair per account; hub-style shared LEFT keeps ids simple.
const LEFT = entity('aa');
const rightEntity = (index: number): string => entity((0xb0 + index).toString(16));

const initialDelta = (): Delta => ({
  ...createDefaultDelta(1),
  collateral: 100_000n,
});

const makeTsAccount = (index: number): AccountReplica => {
  const account = makeAccount(LEFT, rightEntity(index), {
    chainId: CHAIN_ID,
    depositoryAddress: DEPOSITORY,
  });
  account.state.watchSeed = WATCH_SEED;
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, initialDelta()]]);
  return account;
};

const deltaWire = (delta: Delta): RscoreWireValue[] => [
  delta.tokenId,
  delta.collateral.toString(),
  delta.ondelta.toString(),
  delta.offdelta.toString(),
  delta.leftCreditLimit.toString(),
  delta.rightCreditLimit.toString(),
  delta.leftAllowance.toString(),
  delta.rightAllowance.toString(),
  delta.leftHold.toString(),
  delta.rightHold.toString(),
];

const seedWire = (index: number, account: AccountReplica): RscoreWireValue[] => [
  hexBytes(ACCOUNT_IDS[index]!),
  hexBytes(LEFT),
  hexBytes(LEFT),
  hexBytes(rightEntity(index)),
  CHAIN_ID,
  hexBytes(DEPOSITORY),
  hexBytes(WATCH_SEED),
  RESPONSE_SECONDS,
  [...account.state.deltas.values()].map(deltaWire),
  [],
];

const paymentTx = (index: number, amount: bigint): AccountTx => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount,
    route: [LEFT],
    description: `parity-${index}`,
    fromEntityId: rightEntity(index),
    toEntityId: LEFT,
    deliveryMode: 'direct',
  },
});

const paymentJob = (inputIndex: number, accountIndex: number, amount: bigint): RscoreWireValue[] => [
  inputIndex,
  hexBytes(ACCOUNT_IDS[accountIndex]!),
  1, // proposer = right (byLeft=false)
  [0, 0, 0, 0],
  [0, 1, amount.toString(), [LEFT], `parity-${accountIndex}`, rightEntity(accountIndex), LEFT, 0, null],
];

/** TS reference: same data model as the Rust accounts tree. */
const referenceRoot = (accounts: readonly AccountReplica[]): Uint8Array => {
  let map = PersistentRadixValueMap.empty<string, AccountReplica>({
    radix: 16,
    ownKey: (key: string): string => key,
    keyBytes: hexBytes,
    valueHash: (account: AccountReplica): string => computeAccountStateRoot(account.state),
    ownValue: (account: AccountReplica): AccountReplica => account,
  });
  accounts.forEach((account, index) => {
    map = map.updated(ACCOUNT_IDS[index]!, account);
  });
  return hexBytes(map.rootHash());
};

describe.skipIf(!existsSync(BINARY))('rscore accounts-tree parity', () => {
  test('restore and commit report the TS-identical radix-16 accounts root', async () => {
    const accounts = ACCOUNT_IDS.map((_, index) => makeTsAccount(index));
    const client = new RscoreProcessClient(BINARY, {
      engineGeneration: Buffer.alloc(8, 0xa0),
      runtimeId: Buffer.alloc(20, 0x10),
      sessionId: Buffer.alloc(16, 0x20),
    });
    try {
      await client.hello(2);
      const loaded = (await client.restore(0, accounts.map((account, index) => seedWire(index, account)))) as unknown[];
      expect(loaded[0]).toBe(0);
      expect(new Uint8Array(loaded[1] as Uint8Array)).toEqual(referenceRoot(accounts));

      // One payment per account, distinct amounts: every leaf rebranches.
      const jobs = accounts.map((_, index) => paymentJob(index, index, BigInt(7 + index)));
      const prepared = (await client.prepare(jobs)) as unknown[];
      const verdicts = (prepared[2] as unknown[]).map(row => Number(((row as unknown[])[2] as unknown[])[0]));
      expect(verdicts).toEqual(accounts.map(() => 0)); // all applied

      for (const [index, account] of accounts.entries()) {
        const result = await applyAccountTxToMutableReplica(
          account,
          paymentTx(index, BigInt(7 + index)),
          false,
          0,
          0,
          false,
        );
        if (!result.ok) throw new Error(`TS_APPLY_REJECTED:${index}:${result.rejection.code}`);
      }

      const committed = (await client.commit(client.requestIdBytes(client.lastRequestId))) as unknown[];
      expect(committed[0]).toBe(1); // revision
      expect(new Uint8Array(committed[1] as Uint8Array)).toEqual(referenceRoot(accounts));

      await client.shutdown();
    } finally {
      client.kill();
    }
  }, 30_000);
});
