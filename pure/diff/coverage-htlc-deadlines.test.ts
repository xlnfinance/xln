// Coverage: every boundary of the incoming-frame HTLC deadline preflight (og
// account/consensus/dispute/deadline-policy.ts getIncomingAccountDeadlineViolation) against live og. The
// randomized MATCH in account-consensus spreads clocks by +-40s, so it almost never lands on an edge; this grid
// puts each clock exactly one millisecond / one block before, on, and after every bound.
import { describe, expect, test } from "bun:test";
import { getIncomingAccountDeadlineViolation } from "../../core/account/consensus/dispute/deadline-policy.ts";
import { hashHtlcSecret } from "../../core/protocol/htlc/utils.ts";
import {
  HTLC_ENFORCEMENT_RESERVE_MS, incomingDeadline, tokenId,
  type AccountFrame, type HtlcLock, type WireAccountTx,
} from "../xln.ts";
import { genesisAB, unwrap } from "../xln_run.ts";

type OgArgs = Parameters<typeof getIncomingAccountDeadlineViolation>;
/** og's typed shells are built from plain data; this is the one place a shell is given its og type. */
const asOg = <T,>(shell: unknown): T => shell as T;
const W = (b: string): string => `0x${b.repeat(32)}`;

const NOW = 1_000_000;
const FIN = 10;
const RESERVE = Number(HTLC_ENFORCEMENT_RESERVE_MS);
const SECRET = W("5a");
const HASHLOCK = hashHtlcSecret(SECRET);
const T1 = unwrap(tokenId("1"));

type Kind = "lock" | "secret" | "bad_secret" | "timeout" | "manual";
type Clocks = {
  readonly timelock: number; readonly rbh: number; readonly frameTs: number; readonly frameJ: number;
};
type Case = Clocks & { readonly kind: Kind; readonly proposerIsLeft: boolean; readonly senderIsLeft: boolean };

/** og's reason codes, named as the rewrite's deadline reasons. */
const OG_REASONS: Readonly<Record<string, string>> = {
  HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT: "lock_window",
  HTLC_SECRET_ENFORCEMENT_WINDOW_TOO_SHORT: "secret_window",
  HTLC_SECRET_FRAME_CLOCK_EXPIRED: "secret_frame_expired",
  HTLC_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY: "payer_cancel_early",
  HTLC_TIMEOUT_FRAME_CLOCK_NOT_EXPIRED: "timeout_not_expired",
};

// ---- og ----
const ogTxOf = (c: Case): unknown => {
  switch (c.kind) {
    case "lock": return {
      type: "htlc_lock",
      data: { lockId: "L", hashlock: HASHLOCK, timelock: BigInt(c.timelock), revealBeforeHeight: c.rbh, amount: 1n, tokenId: 1 },
    };
    case "secret": return { type: "htlc_resolve", data: { lockId: "L", outcome: "secret", secret: SECRET } };
    case "bad_secret": return { type: "htlc_resolve", data: { lockId: "L", outcome: "secret", secret: W("5b") } };
    default: return { type: "htlc_resolve", data: { lockId: "L", outcome: "error", reason: c.kind } };
  }
};
const ogVerdict = (c: Case, txs: readonly unknown[]): string => {
  const lock = {
    lockId: "L", hashlock: HASHLOCK, timelock: BigInt(c.timelock), revealBeforeHeight: c.rbh, amount: 1n, tokenId: 1,
    senderIsLeft: c.senderIsLeft, createdHeight: 1, createdTimestamp: 0,
  };
  const held = c.kind !== "lock";
  const account = asOg<OgArgs[0]>({ locks: new Map(held ? [["L", lock]] : []) });
  const frame = asOg<OgArgs[1]>({ timestamp: c.frameTs, jHeight: c.frameJ, height: 2, accountTxs: txs });
  const context = asOg<OgArgs[3]>({ entityTimestamp: NOW, finalizedJHeight: FIN });
  const v = getIncomingAccountDeadlineViolation(account, frame, c.proposerIsLeft, context);
  if (v === undefined) return "none";
  const code = v.reason.split(":")[0] ?? "";
  return `${v.disposition}:${OG_REASONS[code] ?? code}`;
};

// ---- rewrite ----
const rwTxOf = (c: Case): WireAccountTx => {
  switch (c.kind) {
    case "lock": return {
      type: "htlc_lock", lockId: "L", hashlock: HASHLOCK, timelock: BigInt(c.timelock),
      revealBeforeHeight: BigInt(c.rbh), amount: 1n, tokenId: T1,
    };
    case "secret": return { type: "htlc_resolve", lockId: "L", outcome: "secret", secret: SECRET };
    case "bad_secret": return { type: "htlc_resolve", lockId: "L", outcome: "secret", secret: W("5b") };
    default: return { type: "htlc_resolve", lockId: "L", outcome: "error", reason: c.kind };
  }
};
const rwVerdict = (c: Case, txs: readonly WireAccountTx[]): string => {
  const lock: HtlcLock = {
    lockId: "L", hashlock: HASHLOCK, timelock: BigInt(c.timelock), revealBeforeHeight: BigInt(c.rbh), amount: 1n,
    tokenId: T1, senderIsLeft: c.senderIsLeft, createdHeight: 1n, createdTimestamp: 0n,
  };
  const held = c.kind !== "lock";
  const body = { ...genesisAB().state, locks: new Map(held ? [["L", lock]] : []) };
  const frame: AccountFrame = {
    timestamp: BigInt(c.frameTs), jHeight: BigInt(c.frameJ), height: 2n, txs,
    prevFrameHash: W("00"), accountStateRoot: W("00"), stateHash: W("00"),
  };
  const r = incomingDeadline(body, frame, c.proposerIsLeft, { now: BigInt(NOW), finalizedJHeight: BigInt(FIN) });
  if (r.ok) return "none";
  return `${r.error.dispute ? "dispute" : "reject"}:${r.error.error.reason}`;
};

// ---- the grid: every clock one unit either side of, and on, each bound ----
const around = (x: number): readonly number[] => [x - 1, x, x + 1];
const TIMELOCKS = [...around(NOW), ...around(NOW + RESERVE), NOW + 3 * RESERVE];
const HEIGHTS = [...around(FIN), FIN + 5];
const cases = (): readonly Case[] =>
  (["lock", "secret", "bad_secret", "timeout", "manual"] as const).flatMap((kind) =>
    [true, false].flatMap((proposerIsLeft) =>
      [true, false].flatMap((senderIsLeft) =>
        TIMELOCKS.flatMap((timelock) =>
          [...around(timelock), NOW].flatMap((frameTs) =>
            HEIGHTS.flatMap((rbh) =>
              [...around(rbh), FIN].map((frameJ) => ({ kind, proposerIsLeft, senderIsLeft, timelock, rbh, frameTs, frameJ }))))))));
const label = (c: Case): string => JSON.stringify(c);

describe("coverage-htlc-deadlines: incoming HTLC deadline preflight on every clock boundary", () => {
  test("MATCH: one-tx frames over the full boundary grid -- same none / reject / dispute and same reason as og", () => {
    const verdicts = new Map<string, number>();
    for (const c of cases()) {
      const og = ogVerdict(c, [ogTxOf(c)]);
      expect([label(c), rwVerdict(c, [rwTxOf(c)])]).toEqual([label(c), og]);
      verdicts.set(og, (verdicts.get(og) ?? 0) + 1);
    }
    const summary = JSON.stringify([...verdicts]);
    for (const v of ["none", "reject:lock_window", "dispute:secret_window", "reject:secret_frame_expired",
      "reject:payer_cancel_early", "reject:timeout_not_expired"]) {
      expect([summary, v, verdicts.has(v)]).toEqual([summary, v, true]);
    }
  });

  test("MATCH: a lock and its resolve in one frame -- the lock the frame opens is what its resolve is scanned against", () => {
    for (const c of cases().filter((x) => x.kind !== "lock")) {
      const opened: Case = { ...c, kind: "lock", senderIsLeft: c.proposerIsLeft };
      const unheld: Case = { ...c, kind: "lock" };
      const og = ogVerdict(unheld, [ogTxOf(opened), ogTxOf(c)]);
      expect([label(c), rwVerdict(unheld, [rwTxOf(opened), rwTxOf(c)])]).toEqual([label(c), og]);
    }
  });
});
