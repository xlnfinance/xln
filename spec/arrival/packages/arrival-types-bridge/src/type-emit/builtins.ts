/**
 * COPY-AS-CHUNK (constitution §4.5 — greenfield package, never shared imports).
 * Sources: arrival/packages/mercury/src/stdlib.ts (the name ROSTER only) +
 * foundations/arrival/arrival-sugarcoat/src/sugarcoat-render.ts (`decodeAccessor`,
 * reduced to its acceptance test).
 *
 * Adaptations from the source chunks:
 *   - REDUCED to head classification. The type pass asks exactly one question —
 *     "does this head lower to an ambient global function call?" — so only the
 *     KEY SETS survive; the string `Emitter` bodies are run-plane machinery the
 *     Residual algebra replaces (constitution §3.4) and must not seed the
 *     greenfield tree. The three lists mirror the source's STDLIB / BINOP / UNOP
 *     tables 1:1 (BINOP/UNOP overlap STDLIB — kept verbatim for diffability).
 *   - `decodeAccessor` / phase1 `cxrCall` are ported as `decodeCxr`: the type
 *     pass lowers `(car x)` → `(x)[0]`, `(cdr x)` → `(x).slice(1)`,
 *     `(cadr x)` → `(x)[1]`, … — sugarcoat-alike index/slice, not ambient
 *     `car(x)` calls. Bare `car` in value position (`map(car, xs)`) still
 *     resolves to the PRE leaf for eta.
 *   - Transitional module: the registry harvest (`../registry`) becomes the name
 *     authority when the engine walker integrates (registry-emit.md) — this
 *     roster then dissolves into harvested rows.
 */

// stdlib.ts STDLIB table keys.
const STDLIB_NAMES = [
  "map",
  "filter",
  "every",
  "some",
  "list",
  "cons",
  "list-ref",
  "first",
  "length",
  "reverse",
  "append",
  "min",
  "max",
  "apply",
  "max-by",
  "+",
  "-",
  "*",
  "/",
  "modulo",
  "remainder",
  "quotient",
  "=",
  "<",
  ">",
  "<=",
  ">=",
  "eq?",
  "eqv?",
  "equal?",
  "string=?",
  "string-ci=?",
  "string-append",
  "zero?",
  "even?",
  "odd?",
  "null?",
  "empty?",
  "not",
  "and",
  "or",
  "dict",
] as const;

// stdlib.ts BINOP table keys (operator-as-argument forms).
const BINOP_NAMES = [
  "+",
  "-",
  "*",
  "/",
  "=",
  "<",
  ">",
  "<=",
  ">=",
  "cons",
  "eq?",
  "eqv?",
  "equal?",
  "string=?",
  "string-ci=?",
  "modulo",
  "remainder",
  "quotient",
] as const;

// stdlib.ts UNOP table keys.
const UNOP_NAMES = ["first", "zero?", "even?", "odd?", "not", "null?", "empty?", "length"] as const;

const BUILTIN_NAMES: ReadonlySet<string> = new Set([...STDLIB_NAMES, ...BINOP_NAMES, ...UNOP_NAMES]);

/**
 * A `c[ad]+r` pair-accessor word (car, cdr, cadr, caadr, cadadr, …).
 * Same acceptance as sugarcoat's `decodeAccessor` / phase1's CXR_RE.
 */
export const isAccessor = (name: string): boolean => /^c[ad]+r$/.test(name);

/**
 * One step of a decomposed `c[ad]+r` chain (operand-order), matching sugarcoat /
 * phase1: a run of cdrs collapses into a drop count that the next car folds
 * into an index (`slice(k)[0]` ≡ `[k]`). Trailing drops stay as `.slice(k)`.
 *
 *   car    → [{ kind: "index", at: 0 }]
 *   cdr    → [{ kind: "slice", from: 1 }]
 *   cadr   → [{ kind: "index", at: 1 }]
 *   cddr   → [{ kind: "slice", from: 2 }]
 *   caar   → [{ kind: "index", at: 0 }, { kind: "index", at: 0 }]
 *   cadar  → [{ kind: "index", at: 0 }, { kind: "index", at: 1 }]
 */
export type CxrStep =
  | { readonly kind: "index"; readonly at: number }
  | { readonly kind: "slice"; readonly from: number };

/** Decompose a `c[ad]+r` name into index/slice steps (operand order). null if not an accessor. */
export function decodeCxr(name: string): CxrStep[] | null {
  if (!isAccessor(name)) return null;
  const steps: CxrStep[] = [];
  let pendingDrops = 0;
  // Innermost (rightmost) letter first — same walk as phase1 `cxrCall` / Resolver.cxrUnfold.
  for (const letter of [...name.slice(1, -1)].reverse()) {
    if (letter === "d") {
      pendingDrops += 1;
    } else {
      steps.push({ kind: "index", at: pendingDrops });
      pendingDrops = 0;
    }
  }
  if (pendingDrops > 0) steps.push({ kind: "slice", from: pendingDrops });
  return steps;
}

/** Is `name` a stdlib builtin (so it is emitted as an ambient global function
 *  call via `encodeSchemeIdent`, never a free unresolved identifier)?
 *  Mirrors stdlib.ts's `isBuiltin` exactly. */
export const isBuiltin = (name: string): boolean => BUILTIN_NAMES.has(name) || isAccessor(name);
