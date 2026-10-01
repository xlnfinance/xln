// What the account tests share: 32-byte secrets, the holds they lock and a seeded draw. Only tests import this.
import { keccakHex } from "../kernel/encoding/bytes.ts";
import type { JHeight, JView } from "./clause/clock.ts";
import { holdId, type ClauseHold, type Hold, type Side, type TokenId } from "./model.ts";
import type { SigningContext } from "./proof/signing.ts";

/** A height, a view or a token, by a cast: small numbers in range; the real constructors have tests of their own. */
export const heightOf = (n: bigint): JHeight => n as JHeight;
export const tokenOf = (n: bigint): TokenId => n as TokenId;
export const viewOf = (n: bigint): JView => n as bigint as JView;

/** The secret number `n`: `length` bytes, all `n`; 32 unless a test wants a malformed one. */
export const secretOf = (n: number, length = 32): Uint8Array => Uint8Array.from({ length }, () => n);

export const hashlockOf = (secret: Uint8Array): string => keccakHex(secret);

/** A hold in slot `id` on secret number `n` (the slot's number unless given); the money tests do not care which. */
export const holdOf = (payer: Side, amount: bigint, id = 1n, deadline = 100n, n = Number(id)): Hold =>
  ({ id: holdId(id), payer, amount, hashlock: hashlockOf(secretOf(n)), deadline: heightOf(deadline) });

/** The ledger's own tests open holds the clause rules have not looked at: this is their seam, only tests have it. */
export const admitted = (hold: Hold): ClauseHold => hold as ClauseHold;

/** A draw is a pure function of where it is asked: seed, run, step and which question; `n` is the number of answers. */
export const draw = (seed: number, run: number, step: number, k: number, n: number): number => {
  const where = Math.imul(seed * 1000003 + run, 2654435761) ^ Math.imul(step + 1, 1597334677);
  const a = where ^ Math.imul(k + 7, 3266489917);
  const b = Math.imul(a ^ (a >>> 15), 2246822507);
  return (Math.imul(b ^ (b >>> 13), 3266489909) >>> 0) % n;
};

/** Where the account tests sign: a Sepolia-shaped deployment, one Account, a deadline read as 12 s a block. */
export const signing: SigningContext = {
  deployment: { chainId: 11155111n, depository: `0x${"ab".repeat(20)}` },
  accountKey: `0x${"11".repeat(32)}${"22".repeat(32)}`,
  ondeltaEpoch: 1n,
  firstNonce: 3n,
  terms: {
    watchSeed: `0x${"9b".repeat(32)}`, leftResponseSeconds: 60n, rightResponseSeconds: 60n,
    transformer: `0x${"bd".repeat(20)}`, secondsOf: (deadline) => 1_000n + 12n * deadline,
  },
};
