// String wrapper — immutable (string-set!/string-fill! are notImplemented stubs; every
// "mutator" returns a fresh AString) over a code-point view, with provenance and Fantasy
// Land algebras. `freeze()` is JS-level defense-in-depth for a parsed literal, not a
// runtime-enforced mutation guard.
// Lineage: R7RS-small §6.7 strings; Setoid + Functor/Semigroup/Monoid/Applicative are Fantasy Land.
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import type { ANumeric } from "../numbers.js";
import { ACharacter } from "./ACharacter.js";
import { withInputProvenance } from "../op-helpers.js";
import type { SourceLocation } from "../../errors.js";

type StringLike = string | AString | { valueOf(): string };
type NumberLike = number | ANumeric | { valueOf(): number };

export class AString extends AValue {
  readonly kind = "string" as const;

  __string__: string;

  constructor(
    string: ACharacter[] | StringLike,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
    location?: SourceLocation,
  ) {
    super(provenance, location);
    this.__string__ = Array.isArray(string) ? string.map((x) => x.toString()).join("") : string.valueOf();
  }

  get length(): number {
    // R7RS strings are sequences of Unicode code points, not UTF-16 code units.
    return [...this.__string__].length;
  }

  static isString(x: unknown): x is AString | string {
    return x instanceof AString || typeof x === "string";
  }

  // Monoid — empty string is identity for append. No-arg static has no crossing to derive a live ctx from.
  static ["arrival/tagless-final/empty"](): AString {
    return new AString("");
  }

  // Applicative — lift a value into a SchemeString. Same "no crossing" note as empty.
  static ["arrival/tagless-final/of"](value: unknown): AString {
    return new AString(String(value));
  }

  *[Symbol.iterator]() {
    const chars = [...this.__string__];
    for (const char of chars) {
      yield new ACharacter(char);
    }
  }

  serialize(): string {
    return this.valueOf();
  }

  freeze(): void {
    const string = this.__string__;
    delete (this as Partial<AString>).__string__;
    Object.defineProperty(this, "__string__", {
      value: string,
      // Non-configurable + non-writable — frozen string literals are immutable per R7RS §6.7.
      configurable: false,
      writable: false,
      enumerable: true,
    });
  }

  get(n: NumberLike): string {
    return [...this.__string__][typeof n === "number" ? n : n.valueOf()];
  }

  cmp(string: StringLike): number {
    const a = this.valueOf();
    const b = string.valueOf();
    if (a < b) {
      return -1;
    } else if (a === b) {
      return 0;
    } else {
      return 1;
    }
  }

  // Setoid — REPRESENTATION-BLIND: boxed AString equals both another AString of the same
  // content AND the same value unboxed. A string has no exact/inexact-style grade; identity
  // is purely its characters. Comparing only `instanceof AString` made `(equal? boxed "x")`
  // ⇒ #f and broke dedup/`member?` over derived strings. structuralEqual consults Setoid
  // before valueOf, so this is THE place string equality is decided.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return this.__string__ === (other instanceof AString ? other.__string__ : other);
  }

  // Ord — lexicographic via JS `<=` (total code-unit order). Non-AString → false.
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return other instanceof AString && this.__string__ <= other.__string__;
  }

  // Functor — map over characters by code point. SYNC; no reduce/filter (keeps fl-interop
  // from routing strings through async sequence dispatch).
  ["arrival/tagless-final/map"](f: (char: string) => string): AString {
    return new AString([...this.__string__].map(f).join(""));
  }

  // Element-count — code-point length. Characters carry no element ids, so this carries
  // the STRING's OWN provenance (unlike Pair/Vector element-union). Code-point length
  // (spread), so astral chars count once.
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
    return withInputProvenance([this], [...this.__string__].length);
  }

  ["arrival/tagless-final/concat"](other: AString): AString {
    return new AString(this.__string__ + other.valueOf());
  }

  lower(): AString {
    return new AString(this.__string__.toLowerCase());
  }

  upper(): AString {
    return new AString(this.__string__.toUpperCase());
  }

  clone(): AString {
    return new AString(this.valueOf());
  }

  valueOf(): string {
    return this.__string__;
  }

  toString(): string {
    return this.__string__;
  }

  ["arrival/print"](): string {
    return this.toString();
  }

  ["arrival/toJS"](): string {
    return this.__string__;
  }

  withProvenance(p: ReadonlySet<number>): AString {
    return new AString(this.__string__, p, this.location);
  }
}
{
  const ignore = new Set(["length", "constructor"]);
  const _keys = Object.getOwnPropertyNames(String.prototype).filter((name) => {
    return !ignore.has(name);
  });
  const wrap = (fn: (...args: unknown[]) => unknown) =>
    function (this: AString, ...args: unknown[]) {
      return fn.apply(this.__string__, args);
    };
  // Irreducible reflection bridges: indexes String.prototype by a runtime key and writes
  // onto AString.prototype. `typeof` keeps the graft to callables.
  const proto = AString.prototype as unknown as Record<string, unknown>;
  const strProto = String.prototype as unknown as Record<string, unknown>;
  for (const key of _keys) {
    const fn = strProto[key];
    if (typeof fn === "function") proto[key] = wrap(fn as (...args: unknown[]) => unknown);
  }
}

// INTEROP BOUNDARY: the loop grafts String.prototype methods as OWN enumerable properties.
// accessMember's fast path returns own props without boundary checks; symbol-to-field
// resolution would otherwise expose the whole surface. The nominal FAMILY RULE in
// interop-access.ts (`instanceof AValue`) blocks inherited surface on the prototype walk.
// Own properties remain accessible (grafted methods are own — intended API).
