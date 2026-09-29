// env.ts — Layer Σ: OracleEnv backed by a live arrival AmbientRuntime.
//
// Σ's symbol source #1 is `boundSymbols()` — identifiers bound in the running discovery env.
// `AmbientRuntime` is a chain of frames, each holding bindings in `__env__` and a `__parent__`
// pointer. Enumerating the chain (own keys of every frame up to the root, deduped) IS the
// bound set the sandbox would resolve a free symbol against — so Σ enforces the grant for free:
// an env-bound name is exactly a name production code can call.
//
// `isCallable(id)` decides operator-position filtering: a bound value is applicable iff it is
// a JS function (every arrival primitive + lambda is) or a Macro/Syntax (a special-form head).
// Detected structurally (typeof + constructor-name walk) rather than importing the Macro class,
// keeping the oracle free of a runtime dependency on the evaluator.
//
// `signatureOf` is T — not modelled here; returns null (graceful per the contract).
import type { AmbientRuntime } from "../env/AmbientRuntime.js";
import type { Macro } from "../eval/Macro.js";
import type { Syntax } from "../eval/Syntax.js";
import { is_applyable } from "../values/value-guards.js";
import type { OracleEnv } from "./contract.js";
import type { OracleEnvΣ } from "./sigma.js";

/** True iff a bound value can be a form head — the three callable shapes, tested WITHOUT a
 *  runtime edge into the evaluator:
 *    1. a callable-as-value class (`is_applyable`, a values/value-guards.ts leaf — the tagless-
 *       final procedures a capability's `symbol.rosetta`/`symbol.native` declarations bind);
 *    2. a bare host function — the callability MARKER on a flat grant map
 *       (`oracleEnvFromBindings`). Grant envs are never executed; they only answer Σ's
 *       "is this name an admissible operator?" bit. Production AmbientRuntime frames do not
 *       host bare fns (the membrane only admits is_applyable), so this arm is grant-only.
 *    3. a Macro / Syntax special-form head (`if`, `let`, `quote`, syntax-rules macros),
 *       matched by walking the prototype chain's constructor NAMES (not by importing the
 *       class — a Syntax-extends-Macro subclass is caught too).
 *  Macro/Syntax imports are `import type`, erased at compile; `is_applyable` is a value-kernel
 *  leaf — zero runtime edge into the evaluator. */
function isCallableValue(value: unknown): value is Function | Macro | Syntax {
  if (value === undefined || value === null) return false;
  if (is_applyable(value)) return true;
  // Flat-grant callability bit — see arm (2) above. Must precede the proto walk: a bare fn's
  // prototype is `Function.prototype`, whose constructor name is "Function", not Macro/Syntax.
  if (typeof value === "function") return true;
  let proto: object | null = Object.getPrototypeOf(value as object);
  while (proto) {
    const name = (proto.constructor as { name?: string } | undefined)?.name;
    if (name === "Macro" || name === "Syntax") return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Wrap a live {@link AmbientRuntime} as the Σ-aware {@link OracleEnvΣ}. `boundSymbols()`
 * enumerates the frame chain (own string keys of every `__env__` up to the root);
 * `isCallable()` resolves a name the same way the runtime would (nearest binding wins) and
 * tests its value's applicability.
 *
 * Enumeration is a snapshot taken on each call — cheap for scout-sized envs, always
 * reflecting the env handed in. Symbol-keyed bindings are intentionally excluded: Σ
 * constrains SOURCE symbols, which are string-named.
 */
export function makeOracleEnv(env: AmbientRuntime): OracleEnvΣ {
  const boundSymbols = (): ReadonlySet<string> => {
    const names = new Set<string>();
    let frame: AmbientRuntime | null = env;
    while (frame) {
      // RAW `__env__` READ — sanctioned, not rerouted through `.get()` / `_lookupWithResolvers`
      // (audit S3; writer-side half of this sanction is AmbientRuntime.ts's `.bind`
      // preamble, S2c). Two reasons, both behavior changes if rerouted:
      //   1. `.get()` throws `RawCrossingError` on a raw JS scalar (a writer bug) — a static
      //      probe should degrade that name to "unbound," not crash introspection.
      //   2. `_lookupWithResolvers` on a `ResolvingAmbient` also walks `__resolvers__`, firing
      //      a resolver callback per unmatched name per frame. That is NOT behavior-identical:
      //      a resolver can synthesize a binding no `__env__` frame owns (capability doors like
      //      `symbol.notImplemented` — see this class's `get()` comment), so rerouting would
      //      silently grow Σ's admitted set to "everything a resolver could eventually answer"
      //      instead of "names actually resident in a frame," and would run resolver side
      //      effects during what callers expect to be a cheap read-only enumeration.
      for (const key of Object.keys(frame.__env__)) names.add(key);
      frame = frame.__parent__;
    }
    // car/cdr are kernel-synthesized c[ad]+r primitives — always-available callables, so they
    // belong in Σ even though no frame binds them (the family's emittable base case).
    names.add("car");
    names.add("cdr");
    return names;
  };

  const isCallable = (id: string): boolean => {
    // car/cdr and every c[ad]+r are kernel-synthesized accessors — always callable.
    if (/^c[ad]+r$/.test(id)) return true;
    // Resolve the nearest binding the runtime would pick. RAW `__env__` read, same sanction
    // as `boundSymbols` above (audit S3) — not `_lookupWithResolvers`.
    let frame: AmbientRuntime | null = env;
    while (frame) {
      if (Object.hasOwn(frame.__env__, id)) {
        return isCallableValue(frame.__env__[id]);
      }
      frame = frame.__parent__;
    }
    return false;
  };

  const signatureOf: OracleEnv["signatureOf"] = (_id: string) => null;

  return { boundSymbols, isCallable, signatureOf };
}

/**
 * Build an {@link OracleEnvΣ} straight off a flat record of grant bindings — the scope-node-
 * free form of `makeOracleEnv(new AmbientRuntime(_, bindings, null))`. A grant ("these symbols
 * are callable") is never inherited, set, or looked up through — only enumerated and probed for
 * callability — so it needs the Σ INTERFACE, not a runtime scope-node.
 *
 * Equivalent, field for field, to the single-frame `AmbientRuntime` path (that env's `__env__`
 * IS the record, parent `null`): `boundSymbols()` = the record's own string keys; `isCallable(id)`
 * = the same {@link isCallableValue} predicate over `bindings[id]`; `signatureOf` is T, null
 * per the contract. The two paths MUST agree.
 *
 * The grant boundary is enforced for free — an unbound name is ungeneratable — exactly as the
 * AmbientRuntime-backed path enforces it.
 */
export function oracleEnvFromBindings(bindings: Record<string, unknown>): OracleEnvΣ {
  const boundSymbols = (): ReadonlySet<string> => new Set(Object.keys(bindings));

  const isCallable = (id: string): boolean => (Object.hasOwn(bindings, id) ? isCallableValue(bindings[id]) : false);

  const signatureOf: OracleEnv["signatureOf"] = (_id: string) => null;

  return { boundSymbols, isCallable, signatureOf };
}
