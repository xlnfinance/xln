// What the account tests share: 32-byte secrets and the holds they lock. Only tests import this.
import { keccakHex } from "../kernel/encoding/bytes.ts";
import { holdId, type Hold, type Side } from "./model.ts";

/** The secret number `n`: `length` bytes, all `n`; 32 unless a test wants a malformed one. */
export const secretOf = (n: number, length = 32): Uint8Array => Uint8Array.from({ length }, () => n);

export const hashlockOf = (secret: Uint8Array): string => keccakHex(secret);

/** A hold in slot `id` on secret number `n` (the slot's number unless given); the money tests do not care which. */
export const holdOf = (payer: Side, amount: bigint, id = 1n, deadline = 100n, n = Number(id)): Hold =>
  ({ id: holdId(id), payer, amount, hashlock: hashlockOf(secretOf(n)), deadline });
