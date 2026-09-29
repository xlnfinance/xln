import { CONSTANT_CTX, type RunContext } from "../../run/RunContext.js";
import type { CallCtx } from "../../run/CallCtx.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { isSchemeString, isString, type SchemeStringLike, type SchemeValue } from "../types.js";
import { nil } from "./ANil.js";
import type { CallResult } from "./ACallable.js";
import { attachOffendingValue } from "../../errors.js";
import { ASYMBOL_LITERAL, ASYMBOL_OBJECT, DATA } from "../../well-known/symbols.js";

/**
 * Provenance × interning invariant: `SchemeSymbol.list[name]` is the canonical
 * empty-provenance instance shared by every reader. `withProvenance` must NOT
 * replace it (that would stamp every other reader with one call-site's
 * provenance); instead it mints a fresh uninterned copy via this sentinel.
 * Safe because `SchemeSymbol.is` compares `__name__`, not reference.
 *
 * Lineage: symbol interning is hash-consing (Ershov, 1958) / the flyweight
 * pattern — canonical shared instances keyed by name.
 */
const UNINTERNED = Symbol("UNINTERNED");

// Flyweight intern tables keyed by RunContext. Live mints use CONSTANT_CTX (AValue
// carries no per-value ctx) — one permanent table unless a call site passes another
// ctx. Map is key-pollution-safe (`__proto__` is an entry, not Object.prototype).
// Equality is `__name__`-based (`equals`/`is`); table lifetime is separate from eq?.
// deferred: ambient active-run ctx would restore per-run collectable tables.
const internTables = new WeakMap<RunContext, Map<string, ASymbol>>();
function internTableFor(ctx: RunContext): Map<string, ASymbol> {
  let table = internTables.get(ctx);
  if (table === undefined) {
    table = new Map();
    internTables.set(ctx, table);
  }
  return table;
}

/**
 * A real keyword name — either arrival's `:limit` or Racket's `#:limit` spelling.
 * Bare `:` / `#:` alone are not keywords. Matches `provenance/lineage.ts`'s
 * `memberRead` / `type-layer/lower.ts`'s `isKeyword` for the `:` form; the `#:`
 * twin is accepted at construction and canonicalized to `:` (see below).
 */
function isKeywordName(name: string): boolean {
  return (
    typeof name === "string" &&
    ((name.length > 1 && name.startsWith(":") && !name.startsWith("::")) || (name.length > 2 && name.startsWith("#:")))
  );
}

/** Canonical intern key for a keyword: `#:limit` → `:limit`. Arrival's one
 *  keyword identity is the `:`-prefixed name; Racket's `#:` is accepted input. */
function canonicalizeKeywordName(name: string): string {
  return name.startsWith("#:") ? `:${name.slice(2)}` : name;
}

export class ASymbol extends AValue {
  // Interning is per run context — see `internTables` / `internTableFor` above.
  /** Special symbol markers. `literal` is `unique symbol`-typed (the `Symbol.for` registry
   *  value is unchanged) so the gensym literal slot can be a DECLARED computed field below —
   *  a single typed key, not the broad symbol index signature esbuild rejects. Written by
   *  `gensym`'s `hidden_prop(symbol, "__literal__", name)` (values/values-repr.ts); `name` is
   *  a string (named gensym) or number (anonymous `#:gN`); a gensym minted via the
   *  no-double-gensym path carries no slot at all — hence `?` + `string | number`. */
  static readonly literal = ASYMBOL_LITERAL;
  static readonly object = ASYMBOL_OBJECT;
  readonly kind = "symbol" as const;
  /** Interned symbols carry their string name; a GENSYM carries a raw ES6 `symbol`
   *  as its name — the symbol IS the uniqueness (uninterned by construction, no
   *  capture in macro expansion). Every reader must handle both arms. */
  declare __name__: string | symbol;
  declare [ASymbol.literal]?: string | number;
  declare [DATA]?: boolean;

  constructor(
    name: string | symbol | SchemeStringLike,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
    intern: symbol | true = true,
  ) {
    super(provenance);
    const unwrapped: string | symbol = isSchemeString(name) ? name.valueOf() : name;

    // A keyword redirects to AKeywordSymbol — a real subclass with a statically-declared
    // `apply` method, not a per-instance patch. `new.target` distinguishes "someone called
    // `new ASymbol(':a')` directly" (redirect) from "AKeywordSymbol's own super() call"
    // (already the right class — proceed as normal below). The redirect happens before
    // interning so the CACHED instance (whichever branch mints or hits it) is always the
    // correctly-typed one. Racket `#:limit` canonicalizes to `:limit` so both spellings
    // intern as the same keyword identity.
    if (new.target === ASymbol && typeof unwrapped === "string" && isKeywordName(unwrapped)) {
      return new AKeywordSymbol(canonicalizeKeywordName(unwrapped), provenance, intern);
    }

    if (intern !== UNINTERNED && typeof unwrapped === "string") {
      // Intern under CONSTANT_CTX (see internTables). deferred: ambient run ctx.
      const table = internTableFor(CONSTANT_CTX);
      const hit = table.get(unwrapped);
      if (hit !== undefined) {
        return hit;
      }
      this.__name__ = unwrapped;
      table.set(unwrapped, this);
      return;
    }

    this.__name__ = unwrapped;
  }

  static is(symbol: unknown, name: string | ASymbol | RegExp): boolean {
    return (
      symbol instanceof ASymbol &&
      ((name instanceof ASymbol && symbol.__name__ === name.__name__) ||
        (typeof name === "string" && symbol.__name__ === name) ||
        (name instanceof RegExp && typeof symbol.__name__ === "string" && name.test(symbol.__name__)))
    );
  }

  toString(quote?: boolean): string {
    if (isSymbol(this.__name__)) {
      return symbol_to_string(this.__name__);
    }
    const str = this.valueOf();
    // Bar-quoted `|...|` round-trip (R7RS §7.1.1 write syntax): quote when asked AND the
    // name needs it — empty (`""` has no unquoted spelling at all), contains a bar/backslash
    // (both of which the reader would otherwise treat as a delimiter/escape starter), or
    // contains a character that breaks unquoted symbol syntax (whitespace, a bracket/quote
    // delimiter, or a leading `;` comment starter). Only `|` and `\` need escaping inside the
    // bars — every other character (including literal whitespace) is legal there verbatim.
    if (quote && typeof str === "string" && (str === "" || /[|\\\s()[\]']|^;/.test(str))) {
      const escaped = str.replaceAll(/[|\\]/g, (char) => `\\${char}`);
      return `|${escaped}|`;
    }
    return String(str);
  }

  // Print protocol — the bare symbol name (toString(quote=false), the display form).
  ["arrival/print"](): string {
    return this.toString();
  }

  literal(): string {
    if (this.is_gensym()) {
      // The declared `[ASymbol.literal]` slot is `string | number | undefined`:
      // a named gensym stored its source name, an anonymous `#:gN` stored its
      // counter (number), and a no-double-gensym mint carries no slot at all.
      // Coerce to the `string` contract; fall back to the symbol's printed form.
      const lit = this[ASymbol.literal];
      return lit === undefined ? this.toString() : String(lit);
    }
    // Non-gensyms always have string names
    return this.__name__ as string;
  }

  valueOf(): string | symbol {
    // Returned raw — used as environment keys (a gensym's ES6-symbol name is a
    // legal, collision-free Map/Record key like any string).
    return this.__name__;
  }

  // Setoid — symbol ≡ symbol with the same `__name__`; `===` works for both string names and
  // gensym ES6 symbols (interned identity). Mirrors `ASymbol.is`.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof ASymbol && this.__name__ === other.__name__;
  }

  // Ord (extends Setoid) — lexicographic over STRING names. A gensym's `__name__` is an ES6
  // symbol with no meaningful order — falling back to `String(...)` gives a STABLE total
  // order within a run (Symbol toString is stable), so totality/antisymmetry/transitivity hold.
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return other instanceof ASymbol && String(this.__name__) <= String(other.__name__);
  }

  // Type predicate — `(symbol? x)` (a `symbol.taglessGuard`) asks the receiver instead of the
  // builtin reaching around with `instanceof ASymbol`. A Symbol answers #t; others default #f.
  ["arrival/tagless-final/symbol?"](): boolean {
    return true;
  }

  is_gensym(): boolean {
    return is_gensym(this.__name__);
  }

  ["arrival/toJS"](): string {
    // A symbol's JS face is the INTERNED NAME, plain — never an apostrophe-prefixed form.
    // An apostrophe prefix ("'hello") would keep symbols distinguishable from strings on
    // the JS face, but it leaks interpreter texture into every egress consumer (compiled
    // artifacts, cache keys, infer args) and is ambiguous with a user string that legitimately
    // starts with an apostrophe. Symbol-vs-string distinguishability lives in the boxed world
    // (symbol?/eq?); egress is a one-way fold, same family as nil→[] and dotted-pair→2-list:
    // round trip = projection∘borrow, not identity.
    return isString(this.__name__) ? this.__name__ : symbol_to_string(this.__name__ as symbol);
  }

  withProvenance(p: ReadonlySet<number>): ASymbol {
    return new ASymbol(this.__name__, p, UNINTERNED);
  }
}

/**
 * A `:`-prefixed keyword — the ONLY difference from `ASymbol` is this statically-declared
 * `apply`, so `(:key obj)` dispatches through the ordinary `is_applyable`/`fn[tf("apply")]`
 * call-dispatch path (evaluator.ts) like any other callable, no special-cased resolver.
 * `ASymbol`'s own constructor redirects here for every keyword-shaped name — never
 * constructed directly by call sites, so `instanceof ASymbol` still holds everywhere a
 * keyword is used as a plain symbol.
 *
 * Applied to nothing, a keyword returns itself (point-free/composition use — `(compose :a
 * :b)`). Applied to one value, it hands ITSELF to that value's own `get` (not a folded
 * string) so the target decides how to fold/match it — no centralized accessor call here.
 */
export class AKeywordSymbol extends ASymbol {
  ["arrival/tagless-final/apply"](args: readonly SchemeValue[], callCtx: CallCtx, _canBounce = false): CallResult {
    if (args.length === 0) return this;
    const target = args[0] as unknown as Record<string, unknown> | null | undefined;
    const getter = target?.["arrival/tagless-final/get"];
    // `get` takes bare `runCtx` — pull it off `callCtx`.
    if (typeof getter === "function") return getter.call(target, this, callCtx.runCtx) as CallResult;
    // B2 (benchmark-defect-register.md): a receiver with NO `arrival/tagless-final/get`
    // term splits into two facts a bare `nil` fall-through would conflate:
    //   • nil (kind "nil", or a raw JS null/undefined reaching here) is a legitimate
    //     ABSENT receiver — `(:key nil)` stays nil (pinned by
    //     projection-nil-tolerance.test.ts and keyword-accessor-leaf-door.test.ts).
    //   • anything else lacking `get` (string/number/boolean/character/symbol/vector —
    //     no member protocol at all) is a TYPE ERROR wearing absence's clothes: returning
    //     nil hides it, so the caller reads empty fields forever with no signal. Door
    //     instead, naming the kind and routing to the manifold's own parser prelude
    //     (mirrors unbound-variable.ts's NEEDS_PARSING_HINT phrasing).
    if (target == null || (target as unknown as AValue).kind === "nil") return nil;
    const kind = target instanceof AValue ? target.kind : typeof target;
    // OFFENDING_VALUE (errors.ts): names the receiver a downstream door can read off
    // `.provenance` — same discipline as op-helpers.ts's `stringValue` door (B1) and
    // `arrival-manifold/bind.ts`'s ARGS_REJECTION.
    throw attachOffendingValue(
      new TypeError(
        `${String(this.__name__)} on a ${kind} — a ${kind} has no members to read (it declares no ` +
          `arrival/tagless-final/get). If this is text that should be parsed first, try (detect-parse s).`,
      ),
      target,
    );
  }
}

// ── Symbol helpers ──
function isSymbol(x: unknown): x is symbol {
  return typeof x === "symbol" || (typeof x === "object" && Object.prototype.toString.call(x) === "[object Symbol]");
}

function symbol_to_string(obj: symbol): string {
  return obj.toString().replace(/^Symbol\(([^)]+)\)/, "$1");
}

function is_gensym(symbol: unknown): boolean {
  if (typeof symbol === "symbol") {
    return /^Symbol\(#:/.test(symbol.toString());
  }
  return false;
}

// INTEROP: gensym metadata rides well-known symbols (`literal` live; `object` write-only,
// nothing reads it). FAMILY RULE (`instanceof AValue`) blocks prototype field walks;
// interning is module-scope `internTables`, not a class member.
