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
import { EMPTY_ACCOUNT_J_CLAIM_ROOT } from '../../core/account/j-claims/j-claim-codec';
import { RscoreProcessClient, type RscoreWireValue } from '../../core/rscore/client';

const BINARY = join(import.meta.dir, '../../rscore/target/release/xln-rscore');

const DEPOSITORY = addr('88');
const WATCH_SEED = entity('99');
const CHAIN_ID = 31_337;
const RESPONSE_SECONDS: [number, number] = [10, 10];

// The account id IS the counterparty entity id (engine enforces the binding).
// These ids exercise every rebranch shape: ...01/...02 split a leaf at the
// last nibble, ...01000000 splits the deep zero prefix, 0x80... forces a
// top-level branch slot.
const ACCOUNT_IDS = [
  `0x${'00'.repeat(28)}00000001`,
  `0x${'00'.repeat(28)}00000002`,
  `0x${'00'.repeat(28)}01000000`,
  `0x80${'00'.repeat(27)}00000001`,
  `0x${'00'.repeat(28)}00000003`,
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
const rightEntity = (index: number): string => ACCOUNT_IDS[index]!;

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
  // Post-faucet shape: the J journal counters are committed verbatim, so a
  // snapshot taken after J events must restore root-identically.
  account.state.jNonce = index;
  account.state.lastFinalizedJHeight = index * 7;
  return account;
};


// Sections the engine carries but never interprets; all empty for a fresh
// payment-profile account (roots zero, J-claim accumulators at genesis).
const EMPTY_CLAIM: RscoreWireValue[] = [hexBytes(EMPTY_ACCOUNT_J_CLAIM_ROOT), 0];
const EMPTY_CARRIED: RscoreWireValue[] = [
  new Uint8Array(32), new Uint8Array(32), new Uint8Array(32),
  new Uint8Array(32), new Uint8Array(32),
  [], // rebalance fee policies: owned by the engine, shipped in full
  EMPTY_CLAIM, EMPTY_CLAIM,
];

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
  hexBytes(account.state.leftEntity),
  hexBytes(account.state.rightEntity),
  CHAIN_ID,
  hexBytes(DEPOSITORY),
  hexBytes(WATCH_SEED),
  RESPONSE_SECONDS,
  [...account.state.deltas.values()].map(deltaWire),
  [],
  [account.state.jNonce, account.state.lastFinalizedJHeight],
  EMPTY_CARRIED,
];

const paymentTx = (account: AccountReplica, index: number, amount: bigint): AccountTx => ({
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount,
    route: [account.state.leftEntity],
    description: `parity-${index}`,
    fromEntityId: account.state.rightEntity,
    toEntityId: account.state.leftEntity,
    deliveryMode: 'direct',
  },
});

const paymentJob = (
  account: AccountReplica,
  inputIndex: number,
  accountIndex: number,
  amount: bigint,
): RscoreWireValue[] => [
  inputIndex,
  hexBytes(ACCOUNT_IDS[accountIndex]!),
  1, // proposer = right (byLeft=false)
  [0, 0, 0, 0],
  [
    0,
    1,
    amount.toString(),
    [account.state.leftEntity],
    `parity-${accountIndex}`,
    account.state.rightEntity,
    account.state.leftEntity,
    0,
    null,
  ],
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
    const accounts = ACCOUNT_IDS.slice(0, 4).map((_, index) => makeTsAccount(index));
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
      const jobs = accounts.map((account, index) => paymentJob(account, index, index, BigInt(7 + index)));
      const prepared = (await client.prepare(jobs)) as unknown[];
      const verdicts = (prepared[2] as unknown[]).map(row => Number(((row as unknown[])[2] as unknown[])[0]));
      expect(verdicts).toEqual(accounts.map(() => 0)); // all applied

      for (const [index, account] of accounts.entries()) {
        const result = await applyAccountTxToMutableReplica(
          account,
          paymentTx(account, index, BigInt(7 + index)),
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

      // Account creation between waves: UpsertAccounts must rebranch to the
      // same root the TS model computes with the added leaf.
      const bornIndex = accounts.length;
      const born = makeTsAccount(bornIndex);
      const upserted = (await client.upsertAccounts([seedWire(bornIndex, born)])) as unknown[];
      const grown = [...accounts, born];
      expect(new Uint8Array(upserted[1] as Uint8Array)).toEqual(referenceRoot(grown));

      await client.shutdown();
    } finally {
      client.kill();
    }
  }, 30_000);
});
