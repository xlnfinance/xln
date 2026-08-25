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
import { engineOutputProjection } from '../../core/rscore/shadow';
import {
  deriveExactSwapFillRatio,
  exactFillRatioToUint16,
} from '../../core/orderbook/swap-execution';
import {
  accountTxWire,
  shadowOutputRows,
  swapMarketPolicyWire,
} from '../../core/rscore/shadow-wire';

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

/**
 * uint64 claim counters that a JS number cannot hold. The engine commits the
 * counter into the jurisdiction section, so a lossy wire integer produces a
 * different account state root — these are the exact boundary values.
 */
const LARGE_CLAIM_COUNTS = [
  2n ** 53n,
  2n ** 53n + 1n,
  2n ** 64n - 1n,
] as const;

// A non-zero counter requires a non-genesis root (the two are checked
// against each other), so the vector carries a concrete accumulated root.
const CLAIM_ROOT = entity('c1');

const makeTsAccountWithClaims = (index: number, count: bigint): AccountReplica => {
  const account = makeTsAccount(index);
  account.state.leftPendingJClaims = { version: 1, root: CLAIM_ROOT, count };
  account.state.rightPendingJClaims = { version: 1, root: CLAIM_ROOT, count: count - 1n };
  return account;
};


// Sections the engine carries but never interprets; all empty for a fresh
// payment-profile account (roots zero, J-claim accumulators at genesis).
const EMPTY_CLAIM: RscoreWireValue[] = [hexBytes(EMPTY_ACCOUNT_J_CLAIM_ROOT), 0];
const EMPTY_CARRIED: RscoreWireValue[] = [
  new Uint8Array(32),
  [], // resting swap offers: owned by the engine, shipped in full
  new Uint8Array(32), new Uint8Array(32), new Uint8Array(32),
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

const claimWire = (accumulator: { root: string; count: bigint }): RscoreWireValue[] =>
  [hexBytes(accumulator.root), accumulator.count];

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
  [
    new Uint8Array(32),
    [], // resting swap offers: owned by the engine, shipped in full
    new Uint8Array(32), new Uint8Array(32), new Uint8Array(32),
    [],
    claimWire(account.state.leftPendingJClaims),
    claimWire(account.state.rightPendingJClaims),
  ],
  // No replica shell: these vectors pin the financial engine, so the engine's
  // leaf stays the payment-profile state root and referenceRoot below is the
  // matching TypeScript tree.
  null,
  // No consensus state: these accounts start at genesis, and build no
  // recovery proof of their own.
  null,
  null,
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
  [0, 0, 0, 0, 0],
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
  null,
  // No authority: these vectors drive the engine directly, without a peer
  // signature to recover.
  null,
];

// Give leg of the swap: token 2 (18 decimals) against token 1 (6 decimals),
// the pair the registry quotes with a price step of one tick.
const SWAP_GIVE = 10n ** 18n;
const SWAP_WANT = 2_000_000n;
const SWAP_MAX_FEE = 100_000n;

const makeTsSwapAccount = (index: number): AccountReplica => {
  const account = makeTsAccount(index);
  // Both legs need capacity on both sides: the maker gives token 2, the
  // resolving counterparty pays token 1.
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [
    [1, {
      ...createDefaultDelta(1),
      collateral: 10n ** 12n,
      leftCreditLimit: 10n ** 12n,
      rightCreditLimit: 10n ** 12n,
    }],
    [2, {
      ...createDefaultDelta(2),
      collateral: 10n ** 19n,
      leftCreditLimit: 10n ** 19n,
      rightCreditLimit: 10n ** 19n,
    }],
  ]);
  return account;
};

const swapOfferTx = (index: number): AccountTx => ({
  type: 'swap_offer',
  data: {
    offerId: `parity-offer-${index}`,
    giveTokenId: 2,
    giveTokenDecimals: 18,
    giveAmount: SWAP_GIVE,
    wantTokenId: 1,
    wantTokenDecimals: 6,
    wantAmount: SWAP_WANT,
    maxFee: SWAP_MAX_FEE,
    minNetReceive: SWAP_WANT - SWAP_MAX_FEE,
  },
});

// createdHeight comes from the finalized J height, not the account frame
// height: the two are deliberately different here so the wrong clock diverges.
const SWAP_J_HEIGHT = 21;
const SWAP_ACCOUNT_HEIGHT = 3;

const swapOfferJob = (index: number): RscoreWireValue[] => [
  index,
  hexBytes(ACCOUNT_IDS[index]!),
  1, // proposer = right (byLeft=false); same-j maker is the proposer
  // enforcementJHeight is deliberately NOT the frame J height here.
  [0, 0, SWAP_J_HEIGHT + 12, SWAP_ACCOUNT_HEIGHT, SWAP_J_HEIGHT],
  [
    6,
    `parity-offer-${index}`,
    2,
    18,
    SWAP_GIVE.toString(),
    1,
    6,
    SWAP_WANT.toString(),
    SWAP_MAX_FEE.toString(),
    (SWAP_WANT - SWAP_MAX_FEE).toString(),
    null,
    null, // no explicit price ticks: the engine derives the canonical one
  ],
  null,
  // No authority: these vectors drive the engine directly, without a peer
  // signature to recover.
  null,
];

const swapResolveTx = (
  index: number,
  fillRatio: number,
  filledGive: bigint,
  filledWant: bigint,
  cancelRemainder: boolean,
): AccountTx => ({
  type: 'swap_resolve',
  data: {
    offerId: `parity-offer-${index}`,
    fillRatio,
    cancelRemainder,
    executionGiveAmount: filledGive,
    executionWantAmount: filledWant,
  },
});

const swapResolveJob = (
  index: number,
  fillRatio: number,
  filledGive: bigint,
  filledWant: bigint,
  cancelRemainder: boolean,
): RscoreWireValue[] => [
  index,
  hexBytes(ACCOUNT_IDS[index]!),
  0, // proposer = left: only the counterparty resolves
  [0, 0, SWAP_J_HEIGHT + 12, SWAP_ACCOUNT_HEIGHT + 1, SWAP_J_HEIGHT],
  [
    8,
    `parity-offer-${index}`,
    fillRatio,
    null, // fillNumerator
    null, // fillDenominator
    cancelRemainder ? 1 : 0,
    null, // comment
    null, // restingGiveTokenId
    null, // restingWantTokenId
    null, // feeTokenId
    null, // feeAmount
    filledGive.toString(),
    filledWant.toString(),
    null, // restingPriceTicks
    null, // restingGiveAmount
    null, // restingWantAmount
    null, // restingQuantizedGive
    null, // restingQuantizedWant
  ],
  null,
  // No authority: these vectors drive the engine directly, without a peer
  // signature to recover.
  null,
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

// A release gate sets XLN_RSCORE_REQUIRE_BINARY=1: an absent binary is then a
// failure, never a silent skip.
if (!existsSync(BINARY) && process.env['XLN_RSCORE_REQUIRE_BINARY'] === '1') {
  throw new Error(`RSCORE_BINARY_MISSING:${BINARY}`);
}

describe.skipIf(!existsSync(BINARY))('rscore accounts-tree parity', () => {
  test('restore and commit report the TS-identical radix-16 accounts root', async () => {
    const accounts = ACCOUNT_IDS.slice(0, 4).map((_, index) => makeTsAccount(index));
    const client = new RscoreProcessClient(BINARY, {
      engineGeneration: Buffer.alloc(8, 0xa0),
      runtimeId: Buffer.alloc(20, 0x10),
      sessionId: Buffer.alloc(16, 0x20),
    });
    try {
      await client.hello(2, swapMarketPolicyWire());
      const loaded = (await client.bootstrapAccounts(
        0,
        accounts.map((account, index) => seedWire(index, account)),
      )) as unknown[];
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

  test('a same-j swap offer holds and rests identically in both engines', async () => {
    const accounts = ACCOUNT_IDS.slice(0, 3).map((_, index) => makeTsSwapAccount(index));
    const client = new RscoreProcessClient(BINARY, {
      engineGeneration: Buffer.alloc(8, 0xa0),
      runtimeId: Buffer.alloc(20, 0x10),
      sessionId: Buffer.alloc(16, 0x20),
    });
    try {
      await client.hello(2, swapMarketPolicyWire());
      const loaded = (await client.bootstrapAccounts(
        0,
        accounts.map((account, index) => seedWire(index, account)),
      )) as unknown[];
      expect(new Uint8Array(loaded[1] as Uint8Array)).toEqual(referenceRoot(accounts));

      const prepared = (await client.prepare(accounts.map((_, index) => swapOfferJob(index)))) as unknown[];
      const verdicts = (prepared[2] as unknown[]).map(row => Number(((row as unknown[])[2] as unknown[])[0]));
      expect(verdicts).toEqual(accounts.map(() => 0)); // all applied
      // One offer event per input, in input order, decoded through the same
      // projection the shadow mirror compares with.
      const engineOutputs = accounts.map((_, index) => engineOutputProjection(
        prepared[3] as unknown[],
        ACCOUNT_IDS[index]!.slice(2),
      ));
      expect(engineOutputs.map(rows => rows.length)).toEqual(accounts.map(() => 1));

      for (const [index, account] of accounts.entries()) {
        const result = await applyAccountTxToMutableReplica(
          account,
          swapOfferTx(index),
          false,
          0,
          SWAP_J_HEIGHT,
          false,
        );
        if (!result.ok) throw new Error(`TS_APPLY_REJECTED:${index}:${result.rejection.code}`);
        // The offer event the Entity layer consumes must match field for
        // field, not only the resulting account root.
        if (result.outcome !== 'swap_offer_created') throw new Error(`TS_OUTCOME:${result.outcome}`);
        expect(engineOutputs[index]![0]![2]).toEqual(shadowOutputRows(result)[0]!);
        const offer = account.state.swapOffers.get(`parity-offer-${index}`)!;
        expect(shadowOutputRows(result)).toEqual([[
          'offerUpsert',
          `parity-offer-${index}`,
          account.state.leftEntity,
          account.state.rightEntity,
          2,
          18,
          offer.giveAmount.toString(),
          1,
          6,
          offer.wantAmount.toString(),
          offer.maxFee.toString(),
          offer.minNetReceive.toString(),
          offer.priceTicks!.toString(),
          null,
          1,
          SWAP_J_HEIGHT,
          offer.quantizedGive!.toString(),
          offer.quantizedWant!.toString(),
        ]]);
      }

      const committed = (await client.commit(client.requestIdBytes(client.lastRequestId))) as unknown[];
      // The hold and the resting row are hashed state: the committed root must
      // both match TypeScript and differ from the pre-offer root.
      expect(new Uint8Array(committed[1] as Uint8Array)).toEqual(referenceRoot(accounts));
      expect(new Uint8Array(committed[1] as Uint8Array)).not.toEqual(new Uint8Array(loaded[1] as Uint8Array));
      await client.shutdown();
    } finally {
      client.kill();
    }
  }, 30_000);

  /**
   * Quantization grid: amounts that are lot-aligned, amounts that are not, and
   * amounts whose exact-quote-lot multiple exceeds one lot (where the canonical
   * order preparation and offer creation deliberately disagree). Acceptance
   * itself is compared, so a rejection on one side only is a failure.
   */
  test('offer quantization agrees with TypeScript over an amount grid', async () => {
    const GRID = [
      { give: 10n ** 18n, want: 2_000_000n },
      { give: 15n * 10n ** 12n, want: 40_000n },
      { give: 102n * 10n ** 17n, want: 25_505_100_000n },
      { give: 3n * 10n ** 12n + 7n, want: 8_000n },
      { give: 10n ** 15n, want: 3n },
    ] as const;
    const accounts = GRID.map((_, index) => makeTsSwapAccount(index));
    const client = new RscoreProcessClient(BINARY, {
      engineGeneration: Buffer.alloc(8, 0xa0),
      runtimeId: Buffer.alloc(20, 0x10),
      sessionId: Buffer.alloc(16, 0x20),
    });
    try {
      await client.hello(2, swapMarketPolicyWire());
      await client.bootstrapAccounts(0, accounts.map((account, index) => seedWire(index, account)));
      const jobs = GRID.map((entry, index) => {
        const job = swapOfferJob(index);
        const tx = job[4] as RscoreWireValue[];
        tx[4] = entry.give.toString();
        tx[7] = entry.want.toString();
        tx[8] = '0';
        tx[9] = entry.want.toString();
        return job;
      });
      const prepared = (await client.prepare(jobs)) as unknown[];
      const verdicts = (prepared[2] as unknown[])
        .map(row => Number((((row as unknown[])[2]) as unknown[])[0]));

      const applied: boolean[] = [];
      for (const [index, entry] of GRID.entries()) {
        const result = await applyAccountTxToMutableReplica(
          accounts[index]!,
          {
            type: 'swap_offer',
            data: {
              offerId: `parity-offer-${index}`,
              giveTokenId: 2,
              giveTokenDecimals: 18,
              giveAmount: entry.give,
              wantTokenId: 1,
              wantTokenDecimals: 6,
              wantAmount: entry.want,
              maxFee: 0n,
              minNetReceive: entry.want,
            },
          },
          false,
          0,
          SWAP_J_HEIGHT,
          false,
        );
        applied.push(result.ok);
        if (result.ok) {
          const engineRows = engineOutputProjection(
            prepared[3] as unknown[],
            ACCOUNT_IDS[index]!.slice(2),
          );
          expect(engineRows.map(row => row[2])).toEqual(shadowOutputRows(result));
        }
      }
      expect(verdicts.map(verdict => verdict === 0)).toEqual(applied);
      // At least one grid point must exercise each outcome, or the grid proves
      // nothing about the boundary.
      expect(applied.some(Boolean) && applied.some(value => !value)).toBe(true);

      const committed = (await client.commit(client.requestIdBytes(client.lastRequestId))) as unknown[];
      expect(new Uint8Array(committed[1] as Uint8Array)).toEqual(referenceRoot(accounts));
      await client.shutdown();
    } finally {
      client.kill();
    }
  }, 30_000);

  test('an explicit price tick is the committed book level in both engines', async () => {
    const accounts = ACCOUNT_IDS.slice(0, 2).map((_, index) => makeTsSwapAccount(index));
    const client = new RscoreProcessClient(BINARY, {
      engineGeneration: Buffer.alloc(8, 0xa0),
      runtimeId: Buffer.alloc(20, 0x10),
      sessionId: Buffer.alloc(16, 0x20),
    });
    try {
      await client.hello(2, swapMarketPolicyWire());
      await client.bootstrapAccounts(0, accounts.map((account, index) => seedWire(index, account)));
      // One step below the deterministic tick: aligned, drift within a step, so
      // the signed intent owns the level and the quote is recomputed from it.
      const derived = 20_000n;
      const explicit = derived - 1n;
      // The wire must carry the tick, not only the engine honour it.
      const explicitTx: AccountTx = {
        type: 'swap_offer',
        data: {
          ...(swapOfferTx(0) as Extract<AccountTx, { type: 'swap_offer' }>).data,
          priceTicks: explicit,
        },
      };
      expect(accountTxWire(explicitTx)?.[11]).toBe(explicit.toString());
      const jobs = accounts.map((_, index) => {
        const job = swapOfferJob(index);
        (job[4] as RscoreWireValue[])[11] = explicit.toString();
        return job;
      });
      const prepared = (await client.prepare(jobs)) as unknown[];
      expect((prepared[2] as unknown[])
        .map(row => Number((((row as unknown[])[2]) as unknown[])[0])))
        .toEqual(accounts.map(() => 0));

      for (const [index, account] of accounts.entries()) {
        const tx = swapOfferTx(index) as Extract<AccountTx, { type: 'swap_offer' }>;
        const result = await applyAccountTxToMutableReplica(
          account,
          { type: 'swap_offer', data: { ...tx.data, priceTicks: explicit } },
          false,
          0,
          SWAP_J_HEIGHT,
          false,
        );
        if (!result.ok) throw new Error(`TS_OFFER_REJECTED:${index}:${result.rejection.message}`);
        expect(account.state.swapOffers.get(`parity-offer-${index}`)!.priceTicks).toBe(explicit);
        const engineRows = engineOutputProjection(
          prepared[3] as unknown[],
          ACCOUNT_IDS[index]!.slice(2),
        );
        expect(engineRows.map(row => row[2])).toEqual(shadowOutputRows(result));
      }
      const committed = (await client.commit(client.requestIdBytes(client.lastRequestId))) as unknown[];
      expect(new Uint8Array(committed[1] as Uint8Array)).toEqual(referenceRoot(accounts));
      await client.shutdown();
    } finally {
      client.kill();
    }
  }, 30_000);

  test.each([['full'], ['partial']] as const)(
    'a same-j swap resolve settles both legs identically (%s fill)',
    async (mode: string) => {
      const accounts = ACCOUNT_IDS.slice(0, 3).map((_, index) => makeTsSwapAccount(index));
      const client = new RscoreProcessClient(BINARY, {
        engineGeneration: Buffer.alloc(8, 0xa0),
        runtimeId: Buffer.alloc(20, 0x10),
        sessionId: Buffer.alloc(16, 0x20),
      });
      try {
        await client.hello(2, swapMarketPolicyWire());
        await client.bootstrapAccounts(0, accounts.map((account, index) => seedWire(index, account)));

        // Wave 1: rest the offer on both sides.
        await client.prepare(accounts.map((_, index) => swapOfferJob(index)));
        await client.commit(client.requestIdBytes(client.lastRequestId));
        for (const [index, account] of accounts.entries()) {
          const result = await applyAccountTxToMutableReplica(
            account, swapOfferTx(index), false, 0, SWAP_J_HEIGHT, false,
          );
          if (!result.ok) throw new Error(`TS_OFFER_REJECTED:${index}`);
        }

        // The resolve terms are read off the committed offer, exactly as a
        // matcher would: the test never invents a second quantization.
        const resting = accounts[0]!.state.swapOffers.get('parity-offer-0')!;
        const quantizedGive = resting.quantizedGive!;
        const quantizedWant = resting.quantizedWant!;
        const filledGive = mode === 'full' ? quantizedGive : quantizedGive / 2n;
        const filledWant = mode === 'full'
          ? quantizedWant
          : (filledGive * quantizedWant + quantizedGive - 1n) / quantizedGive;
        const fillRatio = exactFillRatioToUint16(
          deriveExactSwapFillRatio(quantizedGive, filledGive),
        );

        const prepared = (await client.prepare(accounts.map((_, index) =>
          swapResolveJob(index, fillRatio, filledGive, filledWant, false)))) as unknown[];
        const verdicts = (prepared[2] as unknown[])
          .map(row => (((row as unknown[])[2] as unknown[])));
        if (Number(verdicts[0]![0]) !== 0) throw new Error(JSON.stringify(verdicts[0]));
        expect(verdicts.map(verdict => Number(verdict[0]))).toEqual(accounts.map(() => 0));

        for (const [index, account] of accounts.entries()) {
          const result = await applyAccountTxToMutableReplica(
            account,
            swapResolveTx(index, fillRatio, filledGive, filledWant, false),
            true,
            0,
            SWAP_J_HEIGHT,
            false,
          );
          if (!result.ok) throw new Error(`TS_RESOLVE_REJECTED:${index}:${result.rejection.message}`);
          const engineRows = engineOutputProjection(
            prepared[3] as unknown[],
            ACCOUNT_IDS[index]!.slice(2),
          );
          expect(engineRows.map(row => row[2])).toEqual(shadowOutputRows(result));
        }
        // A full fill closes the row; a partial fill leaves a requantized one.
        expect(accounts[0]!.state.swapOffers.get('parity-offer-0') === undefined)
          .toBe(mode === 'full');

        const committed = (await client.commit(client.requestIdBytes(client.lastRequestId))) as unknown[];
        expect(new Uint8Array(committed[1] as Uint8Array)).toEqual(referenceRoot(accounts));
        await client.shutdown();
      } finally {
        client.kill();
      }
    },
    30_000,
  );

  test.each(LARGE_CLAIM_COUNTS.map(count => [count.toString()] as const))(
    'carries a uint64 J-claim counter losslessly (%s)',
    async (countText: string) => {
      const count = BigInt(countText);
      const accounts = ACCOUNT_IDS.slice(0, 3)
        .map((_, index) => makeTsAccountWithClaims(index, count));
      const client = new RscoreProcessClient(BINARY, {
        engineGeneration: Buffer.alloc(8, 0xa0),
        runtimeId: Buffer.alloc(20, 0x10),
        sessionId: Buffer.alloc(16, 0x20),
      });
      try {
        await client.hello(2, swapMarketPolicyWire());
        const loaded = (await client.bootstrapAccounts(
          0,
          accounts.map((account, index) => seedWire(index, account)),
        )) as unknown[];
        // A lossy counter changes the jurisdiction section and therefore every
        // leaf digest, so the forest root is the assertion that pins it.
        expect(new Uint8Array(loaded[1] as Uint8Array)).toEqual(referenceRoot(accounts));
      } finally {
        client.kill();
      }
    },
  );

  /**
   * Every field the seed carries must reach the committed root. A field that
   * the engine silently ignores would let a wrong value pass reconciliation,
   * so each perturbation is asserted to move the root.
   */
  const PERTURBATIONS: ReadonlyArray<readonly [string, (wire: RscoreWireValue[]) => void]> = [
    ['jNonce', wire => { (wire[10] as RscoreWireValue[])[0] = 4_242; }],
    ['lastFinalizedJHeight', wire => { (wire[10] as RscoreWireValue[])[1] = 9_999; }],
    ['disputeLeftSeconds', wire => { (wire[7] as RscoreWireValue[])[0] = 11; }],
    ['disputeRightSeconds', wire => { (wire[7] as RscoreWireValue[])[1] = 13; }],
    ['pullsRoot', wire => { (wire[11] as RscoreWireValue[])[0] = hexBytes(entity('a1')); }],
    ['swapOffers', wire => {
      (wire[11] as RscoreWireValue[])[1] = [[
        'offer-1', 2, 18, '1000000000000000000', 1, 6, '2000000', '0', '2000000', '20000',
        null, 0, 3,
      ]];
    }],
    ['subcontractsRoot', wire => { (wire[11] as RscoreWireValue[])[2] = hexBytes(entity('a3')); }],
    ['requestedRebalanceRoot', wire => { (wire[11] as RscoreWireValue[])[3] = hexBytes(entity('a4')); }],
    ['requestedRebalanceFeeStateRoot', wire => { (wire[11] as RscoreWireValue[])[4] = hexBytes(entity('a5')); }],
    ['rebalanceFeePolicies', wire => {
      (wire[11] as RscoreWireValue[])[5] = [[1, [3, '7', '11', '13', 1_700_000_000_000], []]];
    }],
    ['leftPendingJClaimsCount', wire => {
      ((wire[11] as RscoreWireValue[])[6] as RscoreWireValue[])[1] = 5n;
    }],
    ['rightPendingJClaimsRoot', wire => {
      ((wire[11] as RscoreWireValue[])[7] as RscoreWireValue[])[0] = hexBytes(entity('a6'));
    }],
    ['watchSeed', wire => { wire[6] = hexBytes(entity('a7')); }],
    ['chainId', wire => { wire[4] = 31_338; }],
  ];

  test.each(PERTURBATIONS.map(([name]) => [name] as const))(
    'a wrong %s moves the committed root',
    async (name: string) => {
      const perturb = PERTURBATIONS.find(([label]) => label === name)?.[1];
      if (!perturb) throw new Error(`PERTURBATION_MISSING:${name}`);
      const accounts = ACCOUNT_IDS.slice(0, 3).map((_, index) => makeTsAccount(index));
      const client = new RscoreProcessClient(BINARY, {
        engineGeneration: Buffer.alloc(8, 0xa0),
        runtimeId: Buffer.alloc(20, 0x10),
        sessionId: Buffer.alloc(16, 0x20),
      });
      try {
        await client.hello(2, swapMarketPolicyWire());
        const seeds = accounts.map((account, index) => seedWire(index, account));
        perturb(seeds[0]!);
        const loaded = (await client.bootstrapAccounts(0, seeds)) as unknown[];
        expect(new Uint8Array(loaded[1] as Uint8Array)).not.toEqual(referenceRoot(accounts));
      } finally {
        client.kill();
      }
    },
  );
});
