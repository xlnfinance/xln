// ─────────────────────────────────────────────────────────────────────────────
// PRE — the SHARED PRELUDE for the Scheme→TS type lens.
//
// Declares:
//   1. structural carriers: `List` / `Tuple` / `null` + scalar-compat aliases
//   2. keyword-accessor helpers (`Field` / `HasField` / `FieldKeys`)
//   3. typed-apply HOF fallback `sexpr<F>`
// Builtin leaves (`prelude/builtins/<slug>.d.ts`) each `declare function` with
// an `encodeSchemeIdent` name (`car`, `string$dash$append`, `null$qmark$`, …)
// into this same ambient global scope — no `__arr` / `ArrShape` bag.
//
// Condition coerce is inline `(expr === true)` in type-emit — no ambient truth helper.
//
// CONSUMABILITY: pure ambient `.d.ts` (no `import`/`export`); emitted virtual
// TS is checked against this text + the leaf declares.
// ─────────────────────────────────────────────────────────────────────────────

// ── Structural carriers ──────────────────────────────────────────────────────
// A Scheme list is modeled as a plain array (`T[]`). Runtime is immutable; we
// do NOT mark lists `readonly` in PRE — TS's readonly/mutable split is pure
// friction (rest params, apply, reduce) with no Scheme semantics to protect.
// One array dialect; immutability is the env's job.
// Empty is `null` (or `List<never>` / `[]` where a list shape is required).
type List<T> = T[];

// Fixed-arity product. Replaces the old `Pair<H,T> = [head, tail]` brand for
// cases that are genuinely 2-products (cons of a non-list tail, entry tuples
// for `dict`, alists as `List<Tuple<K, V>>`). Native TS tuple — no phantom.
type Tuple<A = unknown, B = unknown> = [A, B];

// Non-empty list — the honest target of `pair?` (a cons cell / non-empty list).
// Empty list is a list but not a pair; `null` is neither.
type NonEmptyList<T> = [T, ...T[]];

// Scalar-compat aliases (each ≡ its primitive). Leaves write the primitive
// directly now; these are retained ONLY so older rosetta `type:` strings and
// `.cases.ts` bite-guards keep resolving. `Unit` is Scheme's unspecified (`void`).
type Unit = void;
type SNum = number;
type SStr = string;
type SBool = boolean;

// ── Keyword accessor types (`@` / `@?` / `:k`) ───────────────────────────────
// The sift moat over ordinary JS records (no `Dict<>` wrapper).
//
// Field<O, K>          — `(@ obj key)` / `(:key obj)` → the value at K, precise.
// HasField<O, K>       — `(@? obj key)` → a boolean presence check (open key).
// FieldKeys<O>         — `(@keys obj)` → the literal key union as a string[].
type Field<O, K extends keyof O> = O[K];
type HasField<_O extends object, _K extends string> = boolean;
type FieldKeys<O extends object> = (keyof O & string)[];

// ── Typed-apply HOF fallback ─────────────────────────────────────────────────
// `sexpr<F>(f, ...args)` — only when the head is an opaque/computed function
// value the emitter cannot name directly.
declare function sexpr<F extends (...a: any[]) => any>(f: F, ...args: Parameters<F>): ReturnType<F>;

// Builtin leaves: ambient `declare function <encodeSchemeIdent(name)>…` in
// `prelude/builtins/*.d.ts` — no ArrShape / __arr namespace object.
