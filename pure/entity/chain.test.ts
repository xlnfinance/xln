import { describe, expect, test } from "bun:test";
import {
  behindFrom, behindOver, depositable, epochAdvanced, framed, freshChain, proofNonce, withWindows,
} from "./chain.ts";
import { entityFrame } from "./frame.ts";
import { anchor, entityOf, judge, open } from "./fixtures.ts";
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

  test("R-WATCH-STALL the Entity keeps the record per Account, through other news, until told over", () => {
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
});
