// Canonical value encoding: RLP over typed nodes.
//
// Every JS value a commitment covers becomes a labelled RLP node (`["string", bytes]`, `["map", rows...]`), so two
// different values never share an encoding. Maps, sets and object fields are ordered by the encoding of their keys,
// and an undefined field is absent.
import { bytesToHex, concat, minimalBytes, utf8 } from "./bytes.ts";
import { err, flatMap, map, ok, traverse, type Result } from "./result.ts";
import type { Tagged } from "./tagged.ts";

export type CanonicalValueFault = Tagged<"non_finite_number" | "unsupported_type" | "invalid_utf8">;
export type Rlp = Uint8Array | readonly Rlp[];

const compare = (a: string, b: string): number => {
  switch (true) {
    case a < b: return -1;
    case a > b: return 1;
    default: return 0;
  }
};
const sortedBy = <X>(xs: readonly X[], key: (x: X) => string): readonly X[] =>
  xs.map((x) => [key(x), x] as const).toSorted(([a], [b]) => compare(a, b)).map(([, x]) => x);

type Kind = "string" | "list";
/** The first prefix byte of each kind: a short body adds its length to it, a long one adds the length of its length. */
const SHORT_BASE: Readonly<Record<Kind, number>> = { string: 0x80, list: 0xc0 };
const LONG_BASE: Readonly<Record<Kind, number>> = { string: 0xb7, list: 0xf7 };

/** RLP's three spellings: a lone low byte is itself, a short body gets one prefix, a long one its length. */
const payload = (kind: Kind, body: Uint8Array): Uint8Array => {
  const loneLowByte = kind === "string" && body.length === 1 && (body[0] ?? 0x80) < 0x80;
  if (loneLowByte) return body;
  if (body.length <= 55) return concat([Uint8Array.of(SHORT_BASE[kind] + body.length), body]);
  const size = minimalBytes(BigInt(body.length));
  return concat([Uint8Array.of(LONG_BASE[kind] + size.length), size, body]);
};

export const rlp = (node: Rlp): Uint8Array =>
  (node instanceof Uint8Array ? payload("string", node) : payload("list", concat(node.map(rlp))));

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const text = (v: string): Result<Uint8Array, CanonicalValueFault> =>
  (LONE_SURROGATE.test(v) ? err({ _tag: "invalid_utf8" }) : ok(utf8(v)));
const labelled = (label: string, ...rest: readonly Rlp[]): Rlp => [utf8(label), ...rest];
const numberNode = (v: number): Result<Rlp, CanonicalValueFault> =>
  (Number.isFinite(v) ? ok(labelled("number", utf8(String(v)))) : err({ _tag: "non_finite_number" }));
const bigintNode = (v: bigint): Rlp =>
  labelled("bigint", Uint8Array.of(v < 0n ? 1 : 0), minimalBytes(v < 0n ? -v : v));
const byEncoding = (node: Rlp): string => bytesToHex(rlp(node));

const mapNode = (m: ReadonlyMap<unknown, unknown>): Result<Rlp, CanonicalValueFault> => {
  const rows = traverse(m, ([k, v]) => traverse([k, v], node));
  return map(rows, (rs) => labelled("map", ...sortedBy(rs, (row) => byEncoding(row[0] ?? []))));
};
const setNode = (s: ReadonlySet<unknown>): Result<Rlp, CanonicalValueFault> =>
  map(traverse(s, node), (ns) => labelled("set", ...sortedBy(ns, byEncoding)));
const objectNode = (o: Record<string, unknown>): Result<Rlp, CanonicalValueFault> => {
  const keys = Object.keys(o).toSorted(compare).filter((k) => o[k] !== undefined);
  const field = (k: string) => flatMap(text(k), (name) => map(node(o[k]), (n): Rlp => [name, n]));
  return map(traverse(keys, field), (fields) => labelled("object", ...fields));
};

const node = (v: unknown): Result<Rlp, CanonicalValueFault> => {
  switch (true) {
    case v === null: return ok(labelled("null"));
    case typeof v === "boolean": return ok(labelled("bool", Uint8Array.of(v ? 1 : 0)));
    case typeof v === "number": return numberNode(v);
    case typeof v === "bigint": return ok(bigintNode(v));
    case typeof v === "string": return map(text(v), (b) => labelled("string", b));
    case Array.isArray(v): return map(traverse(v, node), (ns) => labelled("array", ...ns));
    case v instanceof Map: return mapNode(v);
    case v instanceof Set: return setNode(v);
    case typeof v === "object": return objectNode(v as Record<string, unknown>);
    default: return err({ _tag: "unsupported_type" });
  }
};

export const encodeCanonicalValue = (v: unknown): Result<Uint8Array, CanonicalValueFault> =>
  map(node(v), rlp);
