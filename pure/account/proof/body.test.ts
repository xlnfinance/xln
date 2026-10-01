import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { unwrapOr } from "../../kernel/core/result.ts";
import { holdOf, tokenOf } from "../fixtures.ts";
import { emptyLedger, MAX_HOLDS } from "../ledger.ts";
import type { Hold, Ledger, TokenId } from "../model.ts";
import { emptyAccount, withLedger } from "../state.ts";
import { proofBodyOf, type ProofTerms } from "./body.ts";

const SEED = `0x${"9b".repeat(32)}`;
const TRANSFORMER = "0xbdf04ab3c4283b1531b8cf812ef21d4fed9be445";
const terms: ProofTerms = {
  watchSeed: SEED, leftResponseSeconds: 60n, rightResponseSeconds: 90n, transformer: TRANSFORMER,
  secondsOf: (deadline) => 1_000n + 12n * deadline,
};
const GOLD = tokenOf(1n);
const SILVER = tokenOf(7n);

type Row = readonly [TokenId, Ledger];
const ledger = (offdelta: bigint, ...holds: readonly Hold[]): Ledger => ({ ...emptyLedger, offdelta, holds });
const account = (...rows: readonly Row[]) => rows.reduce((s, [t, l]) => withLedger(s, t, l), emptyAccount);
const show = (e: unknown) => JSON.stringify(e, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
const bodyOf = (t: ProofTerms, ...rows: readonly Row[]) =>
  unwrapOr(proofBodyOf(t, account(...rows)), (e) => expect.unreachable(show(e)));
const faultOf = (t: ProofTerms, ...rows: readonly Row[]) => {
  const r = proofBodyOf(t, account(...rows));
  return r.ok ? expect.unreachable("a body was made") : r.error;
};

/** A clause's payments, read back from its bytes by ethers: an independent decoder of DeltaTransformer's Batch. */
const BATCH = "tuple(tuple(uint256,tuple(bool,uint256),uint256,bytes32)[],"
  + "tuple(bool,uint256,uint256,uint256,uint256)[],"
  + "tuple(uint256,tuple(bool,uint256),uint16,bytes32,bytes32,bool)[])";
const decoded = (encodedBatch: string) => {
  const batch = ethers.AbiCoder.defaultAbiCoder().decode([BATCH], encodedBatch)[0] as readonly (readonly unknown[][])[];
  const [payments, swaps, pulls] = batch;
  return {
    swaps: swaps?.length, pulls: pulls?.length,
    payments: (payments ?? []).map((p) => {
      const [deltaIndex, amount, until, hash] = p as [bigint, [boolean, bigint], bigint, string];
      return { deltaIndex, negative: amount[0], magnitude: amount[1], until, hash };
    }),
  };
};

describe("account/proof R-PROOF-BODY the body an Account signs is a function of its state and terms", () => {
  test("an Account with no tokens signs a body with no rows and no clauses", () => {
    expect(bodyOf(terms)).toEqual({
      watchSeed: SEED, leftResponseSeconds: 60n, rightResponseSeconds: 90n,
      offdeltas: [], tokenIds: [], transformers: [],
    });
  });

  test("tokens go in ascending order whatever order they were opened in, each row with its own offdelta", () => {
    const body = bodyOf(terms, [SILVER, ledger(-9n)], [GOLD, ledger(4n)]);
    expect(body.tokenIds).toEqual([1n, 7n]);
    expect(body.offdeltas).toEqual([4n, -9n]);
  });

  test("a hold is one clause with one payment: its token's delta, its deadline in seconds, its hashlock", () => {
    const hold = holdOf("left", 5n, 1n, 10n);
    const body = bodyOf(terms, [SILVER, ledger(0n)], [GOLD, ledger(0n)], [tokenOf(9n), ledger(0n, hold)]);
    expect(body.transformers).toHaveLength(1);
    const clause = body.transformers[0] ?? expect.unreachable("no clause");
    expect(clause.transformerAddress).toBe(TRANSFORMER);
    expect(decoded(clause.encodedBatch)).toEqual({
      swaps: 0, pulls: 0,
      payments: [{ deltaIndex: 2n, negative: true, magnitude: 5n, until: 1_120n, hash: hold.hashlock }],
    });
  });

  test("a payer on the left moves the delta down and Right may gain; a payer on the right is the mirror", () => {
    const body = bodyOf(terms, [GOLD, ledger(0n, holdOf("left", 5n, 1n, 10n), holdOf("right", 3n, 2n, 10n))]);
    const [fromLeft, fromRight] = body.transformers;
    expect(fromLeft?.allowances).toEqual([{ deltaIndex: 0n, rightAllowance: 5n, leftAllowance: 0n }]);
    expect(fromRight?.allowances).toEqual([{ deltaIndex: 0n, rightAllowance: 0n, leftAllowance: 3n }]);
    const paid = decoded(fromRight?.encodedBatch ?? "").payments;
    expect(paid.map((p) => [p.negative, p.magnitude])).toEqual([[false, 3n]]);
  });

  test("clauses come in token order, then slot order, whatever order the holds were opened in", () => {
    const body = bodyOf(
      terms,
      [SILVER, ledger(0n, holdOf("left", 1n, 2n, 10n))],
      [GOLD, ledger(0n, holdOf("left", 1n, 3n, 10n), holdOf("left", 1n, 1n, 10n))],
    );
    const slots = body.transformers.map((c) => decoded(c.encodedBatch).payments.map((p) => [p.deltaIndex, p.hash]));
    expect(slots).toEqual([
      [[0n, holdOf("left", 1n, 1n, 10n).hashlock]], [[0n, holdOf("left", 1n, 3n, 10n).hashlock]],
      [[1n, holdOf("left", 1n, 2n, 10n).hashlock]],
    ]);
  });

  test("the same state signs the same body, whoever builds it and in whatever order its tokens were added", () => {
    const rows: readonly Row[] = [[GOLD, ledger(4n, holdOf("right", 2n, 1n, 10n))], [SILVER, ledger(-9n)]];
    expect(bodyOf(terms, ...rows)).toEqual(bodyOf(terms, ...rows.toReversed()));
  });

  test("a deadline that maps to no positive second is refused before anyone signs", () => {
    const zero = { ...terms, secondsOf: () => 0n };
    const held = [GOLD, ledger(0n, holdOf("left", 1n, 1n, 10n))] as const;
    expect(faultOf(zero, held)).toEqual({ _tag: "deadline_not_positive", seconds: 0n });
    expect(bodyOf(zero, [GOLD, ledger(0n)]).transformers).toEqual([]);
  });

  test("a body the Account contract would refuse is refused: too many clauses or tokens, windows too long", () => {
    const holds = (n: number) => Array.from({ length: n }, (_, i) => holdOf("left", 1n, BigInt(i + 1), 10n));
    expect(bodyOf(terms, [GOLD, ledger(0n, ...holds(MAX_HOLDS))]).transformers).toHaveLength(MAX_HOLDS);
    expect(faultOf(terms, [GOLD, ledger(0n, ...holds(MAX_HOLDS + 1))]))
      .toEqual({ _tag: "too_many_clauses", clauses: MAX_HOLDS + 1 });
    const tokens: readonly Row[] = Array.from({ length: 129 }, (_, i) => [tokenOf(BigInt(i)), ledger(0n)]);
    expect(faultOf(terms, ...tokens)).toEqual({ _tag: "too_many_tokens", tokens: 129 });
    expect(bodyOf(terms, ...tokens.slice(0, 128)).tokenIds).toHaveLength(128);
    const year = 365n * 24n * 3600n;
    expect(faultOf({ ...terms, leftResponseSeconds: year, rightResponseSeconds: 1n }, [GOLD, ledger(0n)]))
      .toEqual({ _tag: "response_windows_too_long", total: year + 1n });
    const exact = { ...terms, leftResponseSeconds: year, rightResponseSeconds: 0n };
    expect(bodyOf(exact, [GOLD, ledger(0n)]).tokenIds).toEqual([1n]);
  });

  test("an offdelta the contract's int512 cannot carry is refused, not wrapped", () => {
    expect(faultOf(terms, [GOLD, ledger(1n << 511n)])._tag).toBe("out_of_range");
    expect(bodyOf(terms, [GOLD, ledger((1n << 511n) - 1n)]).offdeltas).toEqual([(1n << 511n) - 1n]);
  });
});
