// A WAL row as text and back, exactly: the shell keeps rows on disk, and `recover` replays what comes back, so a value
// that changed in a round trip (a bigint turned into a number, a missing field turned into a present one) would be a
// replay that diverges for no reason the Runtime could name. JSON has no bigint, no bytes and no `undefined`; each gets
// a one-key tag, and an object that already has a key of that shape is refused, so no plain value reads as a tag.
// Anything else (a Map, a function, a NaN) is refused at the write, never stored.
import { err, flatMap, ok, traverse, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import { bytesToHex, hexToBytes } from "../../kernel/encoding/bytes.ts";

export type ValueFault =
  | Tagged<"unsupported", { at: string; kind: string }>
  | Tagged<"reserved_key", { at: string; key: string }>
  | Tagged<"not_json", { reason: string }>
  | Tagged<"bad_tag", { at: string }>;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const RESERVED = /^\$[nxu]$/;

const isPlain = (v: object): boolean => Object.getPrototypeOf(v) === Object.prototype;

const entriesOf = (at: string, v: object): Result<Json, ValueFault> => {
  const reserved = Object.keys(v).find((key) => RESERVED.test(key));
  if (reserved !== undefined) return err({ _tag: "reserved_key", at, key: reserved });
  const field = ([key, x]: readonly [string, unknown]) =>
    flatMap(tagged(`${at}.${key}`, x), (j) => ok([key, j] as const));
  const fields = traverse(Object.entries(v), field);
  return flatMap(fields, (pairs) => ok(Object.fromEntries(pairs)));
};

const tagged = (at: string, v: unknown): Result<Json, ValueFault> => {
  switch (true) {
    case v === null || typeof v === "boolean" || typeof v === "string": return ok(v);
    case typeof v === "number": return Number.isFinite(v) ? ok(v) : err({ _tag: "unsupported", at, kind: "number" });
    case typeof v === "bigint": return ok({ $n: v.toString() });
    case v === undefined: return ok({ $u: 0 });
    case v instanceof Uint8Array: return ok({ $x: bytesToHex(v) });
    case Array.isArray(v): return traverse(v, (x, i) => tagged(`${at}[${i}]`, x));
    case typeof v === "object" && v !== null && isPlain(v): return entriesOf(at, v);
    default: return err({ _tag: "unsupported", at, kind: typeof v });
  }
};

/** The text of a value, or the first place in it that has no exact text. */
export const encodeValue = (value: unknown): Result<string, ValueFault> =>
  flatMap(tagged("$", value), (json) => ok(JSON.stringify(json)));

const only = (v: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.keys(v).length === 1 && key in v;

const objectAt = (at: string, o: Readonly<Record<string, unknown>>): Result<unknown, ValueFault> => {
  switch (true) {
    case only(o, "$u"): return ok(undefined);
    case only(o, "$n"): return bigintAt(at, o["$n"]);
    case only(o, "$x"): return bytesAt(at, o["$x"]);
    default: return flatMap(
      traverse(Object.entries(o), ([key, x]) => flatMap(read(`${at}.${key}`, x), (v) => ok([key, v] as const))),
      (pairs) => ok(Object.fromEntries(pairs)),
    );
  }
};

const read = (at: string, j: unknown): Result<unknown, ValueFault> => {
  if (Array.isArray(j)) return traverse(j, (x, i) => read(`${at}[${i}]`, x));
  return typeof j === "object" && j !== null ? objectAt(at, j as Readonly<Record<string, unknown>>) : ok(j);
};

const bigintAt = (at: string, digits: unknown): Result<bigint, ValueFault> =>
  (typeof digits === "string" && /^-?\d+$/.test(digits) ? ok(BigInt(digits)) : err({ _tag: "bad_tag", at }));

const bytesAt = (at: string, hex: unknown): Result<Uint8Array, ValueFault> => {
  const bytes = typeof hex === "string" ? hexToBytes(hex) : err({ _tag: "no_prefix" } as const);
  return bytes.ok ? ok(bytes.value) : err({ _tag: "bad_tag", at });
};

// The one `try`: JSON.parse throws on text it cannot read, and no pure expression tells readable text from unreadable
// without trying. The catch turns the throw into the Result every caller handles.
const parsed = (text: string): Result<unknown, ValueFault> => {
  try {
    return ok(JSON.parse(text));
  } catch (error) {
    return err({ _tag: "not_json", reason: error instanceof Error ? error.message : "unreadable" });
  }
};

export const decodeValue = (text: string): Result<unknown, ValueFault> =>
  flatMap(parsed(text), (json) => read("$", json));
