// Two v1 rules the spec names and og lacks:
//  - N2, no deadline beyond a party's own tolerance: under H1 an Account with an open HTLC cannot finalize before its
//    deadline unless the secret shows up, so a lock signed for years holds the Account (and a forwarding hub's onward
//    lane) open for years. The lock horizon bounds it, in time and in J height, at lock admission and at the forward
//    decision.
//  - HOP, an onward deadline ends HOP >= 2 * LAG before the inbound one: the deltas derive from the deployment's LAG
//    (a J transaction is included, and its event read, within LAG), and every dispute window stays above LAG (C11).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { stricterDeparture } from "./departures.ts";
import { TERMS, unwrap } from "../xln_run.ts";
import {
  HTLC_MIN_FORWARD_TIMELOCK_MS, HTLC_REVEAL_DELTA_BLOCKS, HTLC_TIMELOCK_DELTA_MS, LAG_BLOCKS, LAG_MS,
  MAX_LOCK_HORIZON_BLOCKS, MAX_LOCK_HORIZON_MS, accountId, accountTerms, applyAccountBody, entityId,
  genesisAccount, genesisAccountBody, hashHtlcSecret, onwardDeadline, tokenId,
  type AccountBody, type FoldCtx,
} from "../xln.ts";

const word = (byte: string): string => `0x${byte.repeat(32)}`;
const T1 = unwrap(tokenId("1"));
const DAY_MS = 86_400_000;

describe("lock horizon: the deadline a party accepts is bounded", () => {
  test("the default is seven days, in time and in J blocks", () => {
    expect(MAX_LOCK_HORIZON_MS).toBe(7 * DAY_MS);
    expect(MAX_LOCK_HORIZON_BLOCKS).toBe(Math.ceil((7 * DAY_MS) / 5_000));
  });

  const open = (): { body: AccountBody; ctx: FoldCtx } => {
    const terms = unwrap(accountTerms({
      domain: { chainId: 1, depositoryAddress: `0x${"ab".repeat(20)}` },
      watchSeed: word("44"),
      disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
    }));
    const id = unwrap(accountId(unwrap(entityId(word("11"))), unwrap(entityId(word("22")))));
    const ctx: FoldCtx = { byLeft: true, nowMs: 1_000_000n, jHeight: 100n, accountHeight: 1n };
    const granted = [true, false].reduce(
      (body, byLeft) => unwrap(applyAccountBody(body, { type: "set_credit_limit", tokenId: T1, limit: 20n }, { ...ctx, byLeft })).state,
      genesisAccountBody(genesisAccount(id), terms),
    );
    return { body: granted, ctx };
  };
  const HASHLOCK = hashHtlcSecret(word("5a"))!;
  const lock = (timelock: bigint, revealBeforeHeight: bigint) =>
    ({ type: "htlc_lock" as const, lockId: HASHLOCK, hashlock: HASHLOCK, timelock, revealBeforeHeight, amount: 5n, tokenId: T1 });
  const horizonTime = (ctx: FoldCtx): bigint => ctx.nowMs + BigInt(MAX_LOCK_HORIZON_MS);
  const horizonHeight = (ctx: FoldCtx): bigint => ctx.jHeight + BigInt(MAX_LOCK_HORIZON_BLOCKS);
  const refusal = (body: AccountBody, tx: ReturnType<typeof lock>, ctx: FoldCtx): string => {
    const applied = applyAccountBody(body, tx, ctx);
    return applied.ok ? "accepted" : applied.error._tag === "refused" ? applied.error.failure.message : applied.error._tag;
  };

  test("a lock ending exactly at the horizon is accepted", () => {
    const { body, ctx } = open();
    expect(refusal(body, lock(horizonTime(ctx), horizonHeight(ctx)), ctx)).toBe("accepted");
  });

  test("a lock one millisecond past the time horizon is refused as deadline_too_far", () => {
    const { body, ctx } = open();
    expect(refusal(body, lock(horizonTime(ctx) + 1n, horizonHeight(ctx)), ctx)).toContain("deadline_too_far");
  });

  test("a lock one block past the J-height horizon is refused as deadline_too_far", () => {
    const { body, ctx } = open();
    expect(refusal(body, lock(horizonTime(ctx), horizonHeight(ctx) + 1n), ctx)).toContain("deadline_too_far");
  });

  test("both parties refuse it, whichever side proposes", () => {
    const { body, ctx } = open();
    const far = lock(horizonTime(ctx) + 1n, horizonHeight(ctx));
    expect(refusal(body, far, { ...ctx, byLeft: false })).toContain("deadline_too_far");
  });

  test("the forward decision separates a safe onward deadline, an unsafe one and one beyond the horizon", () => {
    const now = { timestamp: 2_000_000, jHeight: 100 };
    const safe = { timelock: BigInt(now.timestamp + 60_000), revealBeforeHeight: 200 };
    expect(onwardDeadline(now, safe)).toBe("safe");
    const near = { timelock: BigInt(now.timestamp + HTLC_TIMELOCK_DELTA_MS + HTLC_MIN_FORWARD_TIMELOCK_MS), revealBeforeHeight: 200 };
    expect(onwardDeadline(now, near)).toBe("unsafe");
    expect(onwardDeadline(now, { ...safe, revealBeforeHeight: now.jHeight + HTLC_REVEAL_DELTA_BLOCKS })).toBe("unsafe");
    const farTime = { timelock: BigInt(now.timestamp + MAX_LOCK_HORIZON_MS + 1), revealBeforeHeight: 200 };
    expect(onwardDeadline(now, farTime)).toBe("too_far");
    const farHeight = { timelock: safe.timelock, revealBeforeHeight: now.jHeight + MAX_LOCK_HORIZON_BLOCKS + 1 };
    expect(onwardDeadline(now, farHeight)).toBe("too_far");
    const edge = { timelock: BigInt(now.timestamp + MAX_LOCK_HORIZON_MS), revealBeforeHeight: now.jHeight + MAX_LOCK_HORIZON_BLOCKS };
    expect(onwardDeadline(now, edge)).toBe("safe");
  });

  test("the walk may end on it: og accepting such a lock is a registered stricter-than-og departure", () => {
    const at = { timestamp: 2_000_000, jHeight: 100 };
    const og = (timelock: number, revealBeforeHeight: number) => ({ type: "htlc_lock", data: { timelock: BigInt(timelock), revealBeforeHeight } });
    expect(stricterDeparture(og(at.timestamp + MAX_LOCK_HORIZON_MS + 1, 150), at)?.reason).toBe("deadline_too_far");
    expect(stricterDeparture(og(at.timestamp + 60_000, at.jHeight + MAX_LOCK_HORIZON_BLOCKS + 1), at)?.reason).toBe("deadline_too_far");
    expect(stricterDeparture(og(at.timestamp + MAX_LOCK_HORIZON_MS, at.jHeight + MAX_LOCK_HORIZON_BLOCKS), at)).toBeUndefined();
    expect(stricterDeparture({ type: "direct_payment" }, at)).toBeUndefined();
  });
});

describe("HOP and LAG: the deltas come from the deployment's lag", () => {
  test("HOP is 2 * LAG, in time and in blocks, and today's deltas are unchanged", () => {
    expect(HTLC_TIMELOCK_DELTA_MS).toBeGreaterThanOrEqual(2 * LAG_MS);
    expect(HTLC_REVEAL_DELTA_BLOCKS).toBeGreaterThanOrEqual(2 * LAG_BLOCKS);
    expect(HTLC_TIMELOCK_DELTA_MS).toBe(2 * LAG_MS);
    expect(HTLC_REVEAL_DELTA_BLOCKS).toBe(Math.ceil(2 * LAG_BLOCKS));
    expect(HTLC_TIMELOCK_DELTA_MS).toBe(10_000);
    expect(HTLC_REVEAL_DELTA_BLOCKS).toBe(3);
  });

  test("every dispute window stays above LAG (C11): the contracts' floor and the default terms", () => {
    const source = readFileSync(join(import.meta.dir, "../../contracts/contracts/Account.sol"), "utf8");
    const floor = Number(/MIN_RESPONSE_SECONDS\s*=\s*(\d+)/.exec(source)?.[1]);
    expect(floor * 1000).toBeGreaterThan(LAG_MS);
    const { leftResponseSeconds, rightResponseSeconds } = TERMS.disputeConfig;
    expect(Math.min(leftResponseSeconds, rightResponseSeconds) * 1000).toBeGreaterThan(LAG_MS);
  });
});
