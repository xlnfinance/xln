import { describe, expect, test } from "bun:test";
import { depositable, epochAdvanced, framed, freshChain, proofNonce, withWindows } from "./chain.ts";
import type { ChainFacts } from "./model.ts";

const STORED = [0n, 1n, 5n, 100n, 2n ** 64n];
const FRAMES = [1n, 2n, 3n, 10n];

const after = (n: bigint, f: ChainFacts): ChainFacts => (n === 0n ? f : after(n - 1n, framed(f)));

describe("entity/chain the nonce of a proof is read from the chain's stored nonce", () => {
  test("R-IMPLICIT-NONCE-FROM-CHAIN no proof of an epoch is at stored + 1, whatever the stored nonce", () => {
    STORED.forEach((stored) =>
      FRAMES.forEach((frames) => {
        const nonce = proofNonce(after(frames, epochAdvanced(freshChain, 1n, stored)));
        expect(nonce).toBe(stored + 1n + frames);
        expect(nonce).toBeGreaterThanOrEqual(stored + 2n);
      }));
  });

  test("R-IMPLICIT-NONCE-FROM-CHAIN an epoch with no co-signed frame has no proof; a new one forgets the old", () => {
    expect(proofNonce(epochAdvanced(freshChain, 1n, 5n))).toBeUndefined();
    expect(proofNonce(epochAdvanced(after(4n, freshChain), 1n, 5n))).toBeUndefined();
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
