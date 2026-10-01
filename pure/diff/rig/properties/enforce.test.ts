// P1's payout check against a fake chain: an honest finalize is clean, and every way the chain can pay a side less than the Account said is red.
import { expect, test } from "bun:test";
import { unwrap } from "../../../xln_run.ts";
import { accountId, genesisReplica, tokenId } from "../../../xln.ts";
import type { AccountReplica, EntityId } from "../../../xln.ts";
import { beliefLines } from "./belief.ts";
import { before, payoutLines, type ChainView } from "./enforce.ts";

const L = `0x${"1".padStart(64, "0")}` as EntityId;
const R = `0x${"2".padStart(64, "0")}` as EntityId;
const TK = unwrap(tokenId("1"));
const TERMS = {
  domain: { chainId: 31337, depositoryAddress: `0x${"d".repeat(40)}` },
  watchSeed: `0x${"ab".repeat(32)}`,
  disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
};
const genesis = unwrap(genesisReplica(unwrap(accountId(L, R)), TERMS));
/** Collateral 100 and Δ = -30: Left owes Right 30, so the chain has to pay Left -30 and Right 130. */
const account: AccountReplica = {
  ...genesis,
  state: {
    ...genesis.state,
    account: { ...genesis.state.account, deltas: new Map([[TK, { tokenId: TK, ondelta: 0n, collateral: 100n, offdelta: -30n, leftCreditLimit: 50n, rightCreditLimit: 0n }]]) },
  },
};

type Books = { collateral: bigint; ondelta: bigint; reserves: Record<string, bigint>; debts: Record<string, { creditor: string; amount: bigint }[]> };
const chainOf = (books: Books): ChainView => ({
  getCollateral: async () => ({ collateral: books.collateral, ondelta: books.ondelta }),
  getReserves: async (id: string) => books.reserves[id] ?? 0n,
  getDebts: async (id: string) => books.debts[id] ?? [],
} as unknown as ChainView);
const start = (): Books => ({ collateral: 100n, ondelta: 0n, reserves: { [L]: 1000n, [R]: 1000n }, debts: {} });

test("P1: a finalize paying each side what the Account said is clean", async () => {
  const books = start();
  const rows = await before(chainOf(books), account);
  books.collateral = 0n;
  books.reserves = { [L]: 970n, [R]: 1130n };
  expect(beliefLines("P1", account, new Map(rows.map((b) => [b.tokenId, b] as const)))).toEqual([]);
  expect(await payoutLines(chainOf(books), rows)).toEqual([]);
});

test("P1: a shortfall booked as debt instead of reserve is still clean", async () => {
  const books = start();
  const rows = await before(chainOf(books), account);
  books.collateral = 0n;
  books.reserves = { [L]: 1000n, [R]: 1100n };
  books.debts = { [L]: [{ creditor: R, amount: 30n }] };
  expect(await payoutLines(chainOf(books), rows)).toEqual([]);
});

test("P1: a Right paid less than c − Δ is red", async () => {
  const books = start();
  const rows = await before(chainOf(books), account);
  books.collateral = 0n;
  books.reserves = { [L]: 970n, [R]: 1100n };
  const lines = await payoutLines(chainOf(books), rows);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("the chain paid Left -30 (owed -30) and Right 100 (owed 130)");
});

test("P1: a Left charged more than the Account said it owed is red", async () => {
  const books = start();
  const rows = await before(chainOf(books), account);
  books.collateral = 0n;
  books.reserves = { [L]: 960n, [R]: 1130n };
  expect(await payoutLines(chainOf(books), rows)).toHaveLength(1);
});

test("P1: collateral the chain holds differently from the Account's belief is red", async () => {
  const books = { ...start(), collateral: 90n };
  const rows = await before(chainOf(books), account);
  expect(beliefLines("P1", account, new Map(rows.map((b) => [b.tokenId, b] as const)))).toHaveLength(1);
});
