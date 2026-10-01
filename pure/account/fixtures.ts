// What the account tests share: 32-byte secrets and the holds they lock. Only tests import this.
import { keccakHex } from "../kernel/encoding/bytes.ts";
import type { JHeight, JView } from "./clause/clock.ts";
import { holdId, type ClauseHold, type Hold, type Side, type TokenId } from "./model.ts";

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
