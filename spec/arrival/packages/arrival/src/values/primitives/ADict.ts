/**
 * ADict — native, immutable open-key map (`{…}` literal / `(dict …)`).
 *
 * Unlike AJSObject (which re-boxes every field through jsToScheme — correct for
 * genuinely-foreign JS, wrong for already-evaluated SchemeValues with real
 * provenance), ADict stores entries as-is so provenance survives.
 *
 * Keyed by DictKey OBJECTS (symbol or string), not folded strings — a key keeps
 * its own provenance. `indexByName` collapses fold-name collisions (`:a` and `"a"`
 * share a slot) onto one canonical key object (Map key equality is reference identity).
 *
 * ALSO the `{…}` reader-literal carrier: a reader-minted node carries `literalForms`
 * and answers the cached `(dict …)` application from `arrival/tagless-final/lower`
 * in code position; under `quote` the node is itself the readable datum. Mint is
 * `ADict.fromLiteralForms`; `reader/dict-grammar.ts` keeps only key-shape predicates.
 *
 * AJSObject stays for genuinely foreign objects with no prior Scheme lineage.
 */
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { egressContainerProxy } from "../../membrane/egress-proxy.js";
import { APair } from "./APair.js";
import { ASymbol } from "./ASymbol.js";
import { ACharacter } from "./ACharacter.js";
import { AString } from "./AString.js";
import { nil } from "./ANil.js";
import { type MembraneExit, type SchemeValue } from "../types.js";
import { type SeenMap, structuralEqual } from "../structural-equal.js";
import { attestDeep, freshIfSingleton, isAttested } from "../attestation.js";
import { is_promise } from "../value-guards.js";
import { isSettleChain, settleEntry } from "./pending-entry.js";
// Runtime import cycle (benign): jsToScheme is hoisted; called only inside get() at runtime.
import { jsToScheme } from "../../membrane/rosetta.js";
import type { SourceLocation } from "../../errors.js";

/** Code-position lowering cache for `{…}` dict-literal nodes — `(dict …)` built once
 *  per node (shared AST). WeakMap keeps cache off the dict payload. */
const LOWERED_LITERAL = new WeakMap<ADict, APair<SchemeValue, SchemeValue>>();

export type DictKey = ASymbol | AString | ACharacter;

/** Reader-minted `{…}` dict-literal node: ADict with `literalForms` present. */
export type DictLiteralNode = ADict & { literalForms: readonly SchemeValue[] };

/** Fold-name — string identity `:a` and `"a"` share. Strips a keyword's `:`. */
export function foldKeyName(key: DictKey): string {
  if (key instanceof ASymbol) {
    const name = typeof key.__name__ === "string" ? key.__name__ : String(key.valueOf());
    return name.startsWith(":") ? name.slice(1) : name;
  }
  return key.valueOf();
}

/** Static string key of a key-position datum, or null. `:keyword` folds to bare name. */
export function staticDictKey(datum: SchemeValue): string | null {
  if (datum instanceof ASymbol) {
    const name = typeof datum.__name__ === "string" ? datum.__name__ : String(datum.valueOf());
    return name.length > 1 && name.startsWith(":") ? name.slice(1) : null;
  }
  if (datum instanceof AString) {
    return datum.toString();
  }
  return null;
}

/** True iff a plain object is dict-SHAPED: Object.prototype or null proto, never an array.
 *  Lets a foreign dict-shaped AJSObject still answer `dict?` without being an ADict. */
export function isDictShaped(source: unknown): boolean {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return false;
  const proto = Object.getPrototypeOf(source);
  return proto === Object.prototype || proto === null;
}

export class ADict extends AValue {
  readonly kind = "dict" as const;

  /** `{…}` reader-literal marker: flat form sequence (keys then values, alternating).
   *  Present ⇒ reader-minted dict literal; absent on `dict`-constructed or quasiquote-folded.
   *  Readonly and constructor-threaded — never assigned post-construction.
   *  Unquote-key forms live only here (no static entry in byKey). */
  readonly literalForms?: readonly SchemeValue[];

  static isDictLiteral(v: unknown): v is DictLiteralNode {
    return v instanceof ADict && v.literalForms !== undefined;
  }

  /** Canonical store — key OBJECTS, not folded strings. Promise-valued entries held
   *  inert as lazy pending cells; settlement memoizes in place, never a semantic mutation. */
  private readonly byKey: Map<DictKey, SchemeValue | Promise<SchemeValue>>;

  private readonly indexByName: Readonly<Record<string, DictKey>>;

  /** `pairs` must already carry unique fold-names — duplicate resolution is the producer's policy. */
  constructor(
    pairs: ReadonlyArray<readonly [DictKey, SchemeValue | Promise<SchemeValue>]>,
    provenance = EMPTY_PROVENANCE,
    location?: SourceLocation,
    literalForms?: readonly SchemeValue[],
  ) {
    super(provenance, location);
    const byKey = new Map<DictKey, SchemeValue | Promise<SchemeValue>>();
    const indexByName: Record<string, DictKey> = Object.create(null);
    for (const [key, value] of pairs) {
      const name = foldKeyName(key);
      Error.invariant(
        !(name in indexByName),
        `ADict: duplicate fold-name "${name}" reached the constructor — the caller must resolve duplicates first`,
      );
      indexByName[name] = key;
      byKey.set(key, value);
    }
    this.byKey = byKey;
    this.indexByName = Object.freeze(indexByName);
    this.literalForms = literalForms;
  }

  /**
   * Mint dict-literal node from an already-VALIDATED flat form sequence (reader owns
   * validation — arity, key admissibility, static-duplicate — for ParseError + location).
   * Static keys kept as real key DATUM objects. Unquote-form keys exist only in
   * `literalForms`. Fold-names unique by construction (Parser throws E-DICT-DUP-KEY first).
   * `loc`: reader passes `{`'s SourceLocation; quasiquote re-instantiation omits it.
   */
  static fromLiteralForms(forms: readonly SchemeValue[], loc?: SourceLocation): DictLiteralNode {
    const pairs: Array<readonly [DictKey, SchemeValue]> = [];
    for (let i = 0; i + 1 < forms.length; i += 2) {
      const keyDatum = forms[i];
      if ((keyDatum instanceof ASymbol || keyDatum instanceof AString) && staticDictKey(keyDatum) !== null) {
        pairs.push([keyDatum, forms[i + 1]]);
      }
    }
    return new ADict(pairs, EMPTY_PROVENANCE, loc, forms) as DictLiteralNode;
  }

  /** Accessor for `@`/`dict-ref`. Missing key → nil.
   *  Promise-valued entry is a LAZY PENDING CELL: first read mints one settle chain;
   *  settlement replaces the slot; later reads are sync. Settled value boxes with THIS
   *  dict's provenance (Option-C: raw JS inherits container lineage). */
  get(name: string): SchemeValue | Promise<SchemeValue> {
    const key = this.indexByName[name];
    if (key === undefined) return nil;
    const entry = this.byKey.get(key);
    if (entry === undefined) return nil;
    // Pluck inheritance (attestation stamp site 2): attested container ⇒ attested field.
    // `freshIfSingleton` first — shared flyweights never attest.
    const pluck = (v: SchemeValue): SchemeValue => (isAttested(this) ? attestDeep(freshIfSingleton(v)) : v);
    if (is_promise(entry)) {
      if (isSettleChain(entry)) return entry;
      const cell = settleEntry(
        entry,
        (settled) => pluck(jsToScheme(CONSTANT_CTX, settled, {}, this.provenance)),
        (boxed) => this.byKey.set(key, boxed),
      );
      this.byKey.set(key, cell);
      return cell;
    }
    return pluck(entry);
  }

  /** Distinguishes "key absent" from "key present, value is legitimately nil". */
  has(name: string): boolean {
    return name in this.indexByName;
  }

  keys(): string[] {
    return Object.keys(this.indexByName);
  }

  /** Canonical key objects, provenance intact — for a future key-preserving accessor. */
  keyObjects(): readonly DictKey[] {
    return Object.values(this.indexByName);
  }

  withProvenance(p: ReadonlySet<number>): ADict {
    // Same-identity re-stamp: a `{…}` literal node stays a `{…}` literal node.
    return new ADict([...this.byKey.entries()], p, this.location, this.literalForms);
  }

  // Code-position lowering: `{…}` reader-literal lowers ONCE, cached, to `(dict …)`.
  // Non-literal ADict answers null (self-evaluating).
  ["arrival/tagless-final/lower"](): APair<SchemeValue, SchemeValue> | null {
    if (this.literalForms === undefined) return null;
    let lowered = LOWERED_LITERAL.get(this);
    if (lowered === undefined) {
      lowered = APair.fromArray(CONSTANT_CTX, [new ASymbol("dict"), ...this.literalForms], false) as APair<
        SchemeValue,
        SchemeValue
      >;
      LOWERED_LITERAL.set(this, lowered);
    }
    return lowered;
  }

  /** R9 lazy egress — ONE crossing protocol, keyed on `exit`. Folded plain string keys;
   *  values unwrap lazily. Bare: per-box identity. Membrane: full recursive crossing
   *  under pinned scope; identity per (box, mode, scope). */
  ["arrival/toJS"](exit?: MembraneExit): Record<string, unknown> {
    return egressContainerProxy(
      this,
      "object",
      {
        keys: () => this.keys(),
        read: (name) => {
          const entry = this.get(name);
          if (!is_promise(entry)) return entry;
          return exit
            ? entry.then((boxed) => exit.element(boxed))
            : entry.then((boxed) => (boxed instanceof AValue ? boxed["arrival/toJS"]() : boxed));
        },
      },
      exit ? { membrane: exit } : undefined,
    ) as Record<string, unknown>;
  }

  ["arrival/print"](): string {
    const parts = this.keys().map((name) => `:${name} ${String(this.get(name))}`);
    return `(dict${parts.length > 0 ? ` ${parts.join(" ")}` : ""})`;
  }

  // Setoid — same fold-names, values `equal?`-recursive. Compares at fold-name level
  // (not key-object level): `(dict :a 1)` and `(dict "a" 1)` stay equal.
  ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean {
    if (!(other instanceof ADict)) return false;
    const ownNames = this.keys();
    const otherNames = other.keys();
    if (ownNames.length !== otherNames.length) return false;
    for (const name of ownNames) {
      if (!(name in other.indexByName)) return false;
      if (!structuralEqual(this.get(name), other.get(name), seen)) return false;
    }
    return true;
  }

  ["arrival/tagless-final/get"](key: SchemeValue | string): SchemeValue | Promise<SchemeValue> {
    return this.get(typeof key === "string" ? key : foldKeyName(key as DictKey));
  }

  ["arrival/tagless-final/has"](key: SchemeValue | string): boolean {
    return this.has(typeof key === "string" ? key : foldKeyName(key as DictKey));
  }

  ["arrival/tagless-final/keys"](): string[] {
    return this.keys();
  }
}
