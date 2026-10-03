import { describe, expect, test } from "bun:test";
import { proofBodyHash } from "../chain/proof/proof.ts";
import { CLAUSED, must } from "../j/fixtures.ts";
import {
  accountLost, behindFrom, behindOver, depositable, disputeOpened, epochAdvanced, framed, freshChain, proofNonce, quiet,
  withWindows,
} from "./chain.ts";
import { entityFrame } from "./frame.ts";
import { anchor, entityOf, GOLD, judge, open } from "./fixtures.ts";
import { emptyEntity, type ChainFacts, type EntityInput } from "./model.ts";

const STORED = [0n, 1n, 5n, 100n, 2n ** 64n];
const FRAMES = [1n, 2n, 3n, 10n];
const SLOTS = [1, 2, 5, 11];

const after = (n: bigint, f: ChainFacts): ChainFacts => (n === 0n ? f : after(n - 1n, framed(f)));

describe("entity/chain the nonce of a proof is read from the chain's stored nonce", () => {
  test("R-IMPLICIT-NONCE-FROM-CHAIN no proof of an epoch is at stored + 1, whatever the stored nonce", () => {
    STORED.forEach((stored) =>
      FRAMES.forEach((frames) =>
        SLOTS.forEach((slot) => {
          const nonce = proofNonce(after(frames, epochAdvanced(freshChain, 1n, stored)), slot);
          expect(nonce).toBe(stored + 1n + BigInt(slot));
          expect(nonce).toBeGreaterThanOrEqual(stored + 2n);
        })));
  });

  test("R-IMPLICIT-NONCE-FROM-CHAIN the newest proof is at its slot, not at the count of frames", () => {
    const facts = after(1n, epochAdvanced(freshChain, 1n, 5n));
    expect(proofNonce(facts, 1)).toBe(7n);
    expect(proofNonce(facts, 2)).toBe(8n);
    expect(proofNonce(facts, 4)).toBe(10n);
  });

  test("R-IMPLICIT-NONCE-FROM-CHAIN an epoch with no co-signed frame has no proof; a new one forgets the old", () => {
    expect(proofNonce(epochAdvanced(freshChain, 1n, 5n), 4)).toBeUndefined();
    expect(proofNonce(epochAdvanced(after(4n, freshChain), 1n, 5n), 4)).toBeUndefined();
  });

  test("an epoch that is not above the known one is a repeat or an older report and changes nothing", () => {
    const known = after(2n, epochAdvanced(freshChain, 3n, 9n));
    expect(epochAdvanced(known, 3n, 99n)).toBe(known);
    expect(epochAdvanced(known, 2n, 1n)).toBe(known);
  });

  test("R-NO-DEPOSIT-BEFORE-COSIGN only epoch 0 without a frame cannot take a deposit", () => {
    expect(depositable(freshChain)).toBe(false);
    expect(depositable(framed(freshChain))).toBe(true);
    expect(depositable(epochAdvanced(freshChain, 1n, 0n))).toBe(true);
  });

  test("R-WINDOWS-NEVER-SHORTEN each window is held on its own", () => {
    const signed = framed({ ...freshChain, windows: { left: 60n, right: 120n } });
    expect(withWindows(signed, { left: 61n, right: 120n }).ok).toBe(true);
    expect(withWindows(signed, { left: 60n, right: 119n }).ok).toBe(false);
    expect(withWindows(signed, { left: 59n, right: 500n }).ok).toBe(false);
  });
});

describe("entity/chain the record that the Host holds an Account's events back (R-WATCH-STALL)", () => {
  test("R-WATCH-STALL the earliest block an Account was held from stands until it is over", () => {
    expect(freshChain.behind).toBeUndefined();
    const held = behindFrom(freshChain, 9n);
    expect(held.behind).toBe(9n);
    expect(behindFrom(held, 12n)).toBe(held);
    expect(behindFrom(held, 7n).behind).toBe(7n);
    expect(behindOver(held).behind).toBeUndefined();
  });

  test("R-WATCH-STALL the Entity keeps the record per Account, through other news, until over", () => {
    const ALICE = entityOf(1);
    const BOB = entityOf(2);
    const CAROL = entityOf(3);
    const run = (state: ReturnType<typeof emptyEntity>, ...inputs: readonly EntityInput[]) =>
      entityFrame(judge, anchor, state, inputs).state;
    const open2 = run(emptyEntity(ALICE), open(BOB), open(CAROL));
    const held = run(open2, { _tag: "j_behind", peer: BOB, from: 9n }, { _tag: "j_behind", peer: BOB, from: 12n });
    expect(held.chain.get(BOB)?.behind).toBe(9n);
    expect(held.chain.get(CAROL)?.behind).toBeUndefined();
    const moved = run(held, { _tag: "j_epoch", peer: BOB, epoch: 1n, stored: 4n });
    expect(moved.chain.get(BOB)).toMatchObject({ epoch: 1n, behind: 9n });
    expect(run(moved, { _tag: "j_behind_over", peer: BOB }).chain.get(BOB)?.behind).toBeUndefined();
    expect(run(moved, { _tag: "j_behind_over", peer: CAROL }).chain.get(BOB)?.behind).toBe(9n);
  });

  test("R-WATCH-WINDOW an Account the Host can no longer read is behind for good: told over it stays quiet", () => {
    const lost = accountLost(freshChain, 9n);
    expect(lost).toMatchObject({ behind: 9n, lost: true });
    expect(accountLost(accountLost(freshChain, 4n), 9n).behind).toBe(4n);
    expect(accountLost(behindFrom(freshChain, 3n), 9n)).toMatchObject({ behind: 3n, lost: true });
    expect(behindOver(lost)).toBe(lost);
    expect(quiet(behindOver(lost))).toBe(true);
    const ALICE = entityOf(1);
    const BOB = entityOf(2);
    const run = (state: ReturnType<typeof emptyEntity>, ...inputs: readonly EntityInput[]) =>
      entityFrame(judge, anchor, state, inputs);
    const told = run(run(emptyEntity(ALICE), open(BOB)).state, { _tag: "j_account_lost", peer: BOB, from: 9n });
    expect(told.state.chain.get(BOB)).toMatchObject({ behind: 9n, lost: true });
    expect(told.notices).toEqual([{ _tag: "account_lost", peer: BOB, from: 9n }]);
    const freed = run(told.state, { _tag: "j_behind_over", peer: BOB });
    expect(freed.state.chain.get(BOB)).toMatchObject({ behind: 9n, lost: true });
  });

  test("R-WATCH-STALL an Account the Host still owes events of signs nothing new, until told over", () => {
    expect(quiet(freshChain)).toBe(false);
    expect(quiet(behindFrom(freshChain, 5n))).toBe(true);
    expect(quiet(behindOver(behindFrom(freshChain, 5n)))).toBe(false);
  });

  const HASH = must(proofBodyHash(CLAUSED));
  const dispute = (body?: typeof CLAUSED, bodyHash = HASH) => ({
    _tag: "j_dispute", peer: entityOf(2), epoch: 0n, by: "right", nonce: 7n, timeout: 100n, proposerIsLeft: true,
    bodyHash,
    ...(body === undefined ? {} : { body }),
  }) as const;

  test("R-WATCH-STALL a dispute told without its body takes the body when it is told again with it", () => {
    const bare = disputeOpened(freshChain, dispute());
    expect(bare.against).toMatchObject({ nonce: 7n, window: 100n });
    expect(bare.against?.body).toBeUndefined();
    const read = disputeOpened(bare, dispute(CLAUSED));
    expect(read.against?.body).toEqual(CLAUSED);
    expect(read.against).toMatchObject({ nonce: 7n, window: 100n, over: false });
  });

  test("R-WATCH-STALL a body the chain did not log the hash of is not taken, with or without one held", () => {
    const bare = disputeOpened(freshChain, dispute());
    const other = { ...CLAUSED, leftResponseSeconds: CLAUSED.leftResponseSeconds + 1n };
    expect(disputeOpened(bare, dispute(other)).against?.body).toBeUndefined();
    const read = disputeOpened(bare, dispute(CLAUSED));
    const nonce = { ...dispute(other), nonce: 8n };
    expect(disputeOpened(read, nonce)).toEqual(read);
    expect(disputeOpened(read, dispute(other)).against?.body).toEqual(CLAUSED);
  });

  test("R-WATCH-STALL a repeated start fills no body for another epoch, nonce or logged hash", () => {
    const bare = disputeOpened(freshChain, dispute());
    const other = { ...CLAUSED, leftResponseSeconds: CLAUSED.leftResponseSeconds + 1n };
    const repeats = [
      { ...dispute(CLAUSED), epoch: 1n },
      { ...dispute(CLAUSED), nonce: 8n },
      dispute(other, must(proofBodyHash(other))),
    ];
    repeats.forEach((repeated) => {
      expect(disputeOpened(bare, repeated)).toBe(bare);
      expect(disputeOpened(bare, repeated).against?.body).toBeUndefined();
    });
    expect(disputeOpened(bare, dispute(CLAUSED)).against?.body).toEqual(CLAUSED);
  });

  describe("a finalize held back for its secrets is told late (R-WATCH-STALL)", () => {
    const ALICE = entityOf(1);
    const BOB = entityOf(2);
    const run = (state: ReturnType<typeof emptyEntity>, ...inputs: readonly EntityInput[]) =>
      entityFrame(judge, anchor, state, inputs).state;
    const paid = { _tag: "j_epoch", peer: BOB, epoch: 1n, stored: 5n, finalBodyHash: HASH } as const;
    const newer = { ...dispute(CLAUSED), peer: BOB, epoch: 1n, nonce: 9n } as const;
    const collateral = { _tag: "j_collateral", peer: BOB, token: GOLD, collateral: 500n, ondelta: 0n } as const;
    const base = run(emptyEntity(ALICE), open(BOB));

    test("R-WATCH-STALL the epoch told at once pays the Account out, before the end of the dispute is told", () => {
      const facts = run(run(base, collateral), paid).chain.get(BOB);
      expect(facts).toMatchObject({ epoch: 1n });
      expect(facts?.held.get(GOLD)).toEqual({ collateral: 0n, ondelta: 0n });
    });

    test("R-WATCH-STALL a start of the epoch after is heard once the advance was; a late end leaves it alone", () => {
      const heard = run(base, paid, newer, collateral);
      expect(heard.chain.get(BOB)?.against).toMatchObject({ nonce: 9n });
      const over = run(heard, { _tag: "j_dispute_over", peer: BOB, late: true }).chain.get(BOB);
      expect(over?.against).toMatchObject({ nonce: 9n });
      expect(over?.held.get(GOLD)).toEqual({ collateral: 500n, ondelta: 0n });
      const early = run(heard, { _tag: "j_dispute_over", peer: BOB }).chain.get(BOB);
      expect(early?.against).toBeUndefined();
      expect(early?.held.get(GOLD)).toEqual({ collateral: 0n, ondelta: 0n });
    });

    test("R-WATCH-STALL a start of the epoch after told before the advance is dropped: the advance goes first", () => {
      expect(run(base, newer).chain.get(BOB)?.against).toBeUndefined();
    });
  });
});
