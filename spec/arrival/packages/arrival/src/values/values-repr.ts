// Value/symbol representation helpers — consumed by AmbientRuntime.ts (`patch_value`'s
// member-read settling), ASymbol.ts, the scheme/core pack (env/core/core.ts, `gensym`),
// and the macro engine (syntax-rules.ts). Kept as a sibling LEAF so the macro engine
// doesn't back-edge into those higher modules — the cycle this split exists to prevent.
//
// `is_promise` comes from value-guards.ts, the true value-kernel leaf (promoted out
// of eval/guards.ts's false-leaf home — hermeticity audit P3).
// ----------------------------------------------------------------------
import { is_promise } from "./value-guards.js";
import { CONSTANT_CTX, type RunContext } from "../run/RunContext.js";
import { AString } from "./primitives/AString.js";
import { ASymbol } from "./primitives/ASymbol.js";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";
import { DATA } from "../well-known/symbols.js";
import { ACharacter } from "./primitives/ACharacter.js";
import type { SchemeValue } from "./types.js";
import { ABool } from "./primitives/ABool.js";
import { ANil } from "./primitives/ANil.js";
import { APair } from "./primitives/APair.js";

// The symbol-NAME surface these helpers operate on: the pre-boxing JS layer —
// exactly what ASymbol's constructor accepts as a name (`SchemeSymbolName`) — NOT
// a boxed SchemeValue. `gensym`/`is_gensym` take a raw name (string/symbol/number),
// an ASymbol wrapper, or null — never a boxed SchemeValue directly.
type SymbolName = string | symbol | number;

/** Non-enumerable, non-writable Symbol-keyed slot — used for metadata that must
 *  not surface in enumeration or be clobbered (e.g. a gensym's `__literal__` name,
 *  or the `__object__` dotted-path array). The stored `value` is arbitrary hidden
 *  metadata, not a boxed Scheme value — hence `unknown`. */
export function hidden_prop(obj: SchemeValue, name: string, value: unknown): void {
  Object.defineProperty(obj, Symbol.for(name), {
    get: () => value,
    set: () => {},
    configurable: false,
    enumerable: false,
  });
}

/** Gensym JS symbols are recognized by the `#:` name prefix — the marker
 *  `gensym` stamps below. (Mirrors SchemeSymbol.is_gensym.) Accepts either a
 *  raw name (the ES6 `symbol` is the gensym carrier) or a boxed value/ASymbol —
 *  only a raw `symbol` ever answers true; everything else is structurally not a
 *  gensym name. */
export function is_gensym(symbol: SchemeValue | SymbolName | null): symbol is symbol {
  if (typeof symbol === "symbol") {
    return !!/^Symbol\(#:/.test(symbol.toString());
  }
  return false;
}

/** Mint a hygienic SchemeSymbol backed by a unique ES6 Symbol (uniqueness is
 *  what guarantees no capture in macro expansion). Idempotent on an already-gensym
 *  input — avoids double-gensym in nested syntax-rules. */
export const gensym = (function () {
  let count = 0;

  function with_props(name: SymbolName, sym: symbol) {
    // ASymbol's ctor param is declared `string | SchemeStringLike`, but its own body only
    // special-cases `typeof unwrapped === "string"` for interning — anything else (a gensym's
    // raw ES6 symbol) is stored verbatim as `__name__` (ASymbol.ts's `isSymbol`/`is_gensym`
    // helpers read it back as a symbol). Honest cast to the existing, already-handled contract.
    const symbol = new ASymbol(sym);
    hidden_prop(symbol, "__literal__", name);
    return symbol;
  }

  return function (name: SymbolName | ASymbol | null = null) {
    if (name instanceof ASymbol) {
      if (name.is_gensym()) {
        return name;
      }
      name = name.valueOf();
    }
    if (is_gensym(name)) {
      // avoid double-gensym in nested syntax-rules
      // Same ASymbol contract as `with_props` above: a gensym's raw ES6 symbol is stored as-is.
      return new ASymbol(name as unknown as string);
    }
    // ES6 symbol guarantees uniqueness as the backing name.
    if (name !== null) {
      return with_props(name, Symbol(`#:${name}`));
    }
    count++;
    return with_props(count, Symbol(`#:g${count}`));
  };
})();

// ----------------------------------------------------------------------
// Marks a value as quoted data so the evaluator won't re-evaluate it. Pairs/symbols
// carry the __data__ flag. A still-pending datum (async macro expansion can hand
// back a thenable) threads through and quotes on settle — hence PromiseLike is
// part of the signature even though SchemeValue itself excludes promises.
// Overloads pin the shape: sync in → sync out, thenable in → thenable out, so
// `patch_value` keeps a plain SchemeValue, not a union.
// ----------------------------------------------------------------------
export function quote(value: SchemeValue): SchemeValue;
export function quote(value: PromiseLike<SchemeValue>): PromiseLike<SchemeValue>;
export function quote(value: SchemeValue | PromiseLike<SchemeValue>): SchemeValue | PromiseLike<SchemeValue> {
  // Narrows the DECLARED union rather than routing through `is_promise`'s lossy
  // `Promise<unknown>` guard: the only thenable this admits is `PromiseLike<SchemeValue>`,
  // so `.then(quote)` stays fully typed with no cast.
  if (isPendingDatum(value)) {
    return value.then(quote);
  }
  if (value instanceof APair) {
    value[DATA] = true;
  } else if (value instanceof ASymbol) {
    value[DATA] = true;
  }
  return value;
}

/** Same runtime test as `is_promise`, but expressed as a predicate over the
 *  value-repr union so the resolved payload keeps its `SchemeValue` type instead
 *  of collapsing to `unknown` (the cost of `is_promise`'s generic guard). */
function isPendingDatum(value: SchemeValue | PromiseLike<SchemeValue>): value is PromiseLike<SchemeValue> {
  return is_promise(value);
}

// Lift raw JS string/number to Scheme. Bigint is host-only (no case → identity);
// objects/arrays box at the membrane. AmbientRuntime.get doors on raw storage
// scalars — does not call this. Callers: reader/parse, pending-entry, public barrel.
// `ctx` = mint identity claim; CONSTANT_CTX when no live run.
export function box(object: unknown, _ctx: RunContext = CONSTANT_CTX): SchemeValue {
  switch (typeof object) {
    case "string":
      return new AString(object);
    case "number":
      if (Number.isNaN(object)) return new AInexact(Number.NaN);
      if (Number.isSafeInteger(object)) {
        return new AExact(object);
      }
      return new AInexact(object);
    default:
      return object as SchemeValue;
  }
}

// ----------------------------------------------------------------------
// Settles a value read out of a binding/member before handing back to Scheme:
// a Pair is cycle-marked then quoted (so the evaluator treats it as data, not
// a call); everything else is boxed. AmbientRuntime.get's read path does not route
// here — it inlines the pair arm and DOORS on raw scalars directly; this stays a
// public value-repr helper for host-side member settling.
// ----------------------------------------------------------------------
export function patch_value(value: unknown, ctx: RunContext = CONSTANT_CTX): SchemeValue {
  if (value instanceof APair) {
    value.mark_cycles();
    return quote(value);
  }
  return box(value, ctx);
}

// ----------------------------------------------------------------------
// An atom is any self-evaluating leaf (symbol, string, nil, char, number,
// boolean) — not a compound pair/structure. Accepts `unknown` because it also
// classifies the raw-JS leaf surface (a bare `null` is the membrane's #f
// sibling, raw `true`/`false` are pre-L1 booleans) — none of which are
// SchemeValue members.
// ----------------------------------------------------------------------
export function is_atom(obj: unknown): obj is ASymbol | AString | ANil | ACharacter | AExact | AInexact | ABool {
  return (
    obj instanceof ASymbol ||
    obj instanceof AString ||
    obj instanceof ANil ||
    obj instanceof ACharacter ||
    obj instanceof AExact ||
    obj instanceof AInexact ||
    obj instanceof ABool
  );
}
