// What every reader of untrusted text has in common: a fault that names the place, a record that has exactly the keys
// its type has, and the plain kinds a field can be. wire.ts reads messages with them, link.ts the handshake and the
// sealed records, so a stranger's text is judged by one set of rules.
import { err, ok, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import type { ValueFault } from "./value.ts";

export type ReadFault =
  | Tagged<"too_big", { bytes: number }>
  | Tagged<"bad_text", { fault: ValueFault }>
  | Tagged<"bad_shape", { at: string; want: string }>;

export const bad = (at: string, want: string): Result<never, ReadFault> => err({ _tag: "bad_shape", at, want });

export type Reader<T> = (at: string, v: unknown) => Result<T, ReadFault>;

export type Fields = Readonly<Record<string, unknown>>;

export const record = (at: string, v: unknown, keys: readonly string[]): Result<Fields, ReadFault> => {
  const isRecord = typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
  const held = isRecord ? Object.keys(v) : [];
  const exact = held.length === keys.length && keys.every((key) => held.includes(key));
  return isRecord && exact ? ok(v as Fields) : bad(at, `{${keys.join(",")}}`);
};

export const text: Reader<string> = (at, v) => (typeof v === "string" ? ok(v) : bad(at, "string"));
export const big: Reader<bigint> = (at, v) => (typeof v === "bigint" ? ok(v) : bad(at, "bigint"));
export const count: Reader<number> = (at, v) =>
  (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? ok(v) : bad(at, "count"));

export const bytesOf = (length: number): Reader<Uint8Array> => (at, v) =>
  (v instanceof Uint8Array && v.length === length ? ok(v) : bad(at, `${length} bytes`));

export const field = <T>(at: string, o: Fields, key: string, read: Reader<T>) => read(`${at}.${key}`, o[key]);
