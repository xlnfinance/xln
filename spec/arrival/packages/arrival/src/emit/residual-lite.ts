// emit/residual-lite — pure-data residual BUILDER surface so a Contract-carried `emit`
// rule can construct residual shapes without arrival core importing the compiler.
//
// WHY. Arrival core must not import the compiler's residual constructors
// (arrival-mercury's residual/types.ts): dependency runs compiler → arrival-core only
// (layering rule; canonical in ./index.ts). An emit rule still has to BUILD
// `Bin`/`Lit`/`Method`/`Ref`/`Un`/`Call`/`Member`/`ArrayLit`/`Spread`/`Arrow`/`Index`.
// This module declares those shapes locally.
//
// STRUCTURAL, NOT NOMINAL. Nothing here is imported BY the compiler; this module never
// imports the compiler's `R`. The two `R` types are independently declared, field-for-
// field identical; structural typing plus `EmitRule`'s bivariant method-parameter check
// (./emit-rule.ts) let a rule built from THESE constructors satisfy the compiler's real
// `EmitRule<R>`, and let the compiler's renderer accept the returned object with zero
// adaptation. Shape drift surfaces as a compile error at the CONSUMING (compiler) site —
// never a silent drift here. `EmitCtx<R>.runtime(sym): R` is generic over THIS file's
// `R`, so a mint of a runtime reference is already typed `R` by the signature alone.
//
// MIRROR RULE. Every type below is field-for-field identical to residual/types.ts's
// alias of the same name; every union is the FULL union (all operators, all literal
// kinds), not the subset current rules use. Three deliberate departures, marked at
// declaration: `Param` is NARROWED to a Binding pattern; `RuntimeRef` and `ChunkExpr`
// are TYPE ARMS with no constructor (inspected or returned, never minted here).
//
// GROWTH DISCIPLINE. Seed only shapes a rule actually constructs; add a constructor in
// the change whose rule needs it, never speculatively.

/** Opaque node-id carrier (mirror rule). Never constructed or inspected here; kept for
 *  origin-field shape parity. */
export type NodeId = unknown;

/** Opaque carrier for a verbatim `ts.Node` subtree (mirror rule). Only the compiler's
 *  residual/chunk.ts constructs one — it is the sole module importing `typescript`. */
export type OpaqueTsNode = unknown;

export type SlotId = string;

interface Base {
  readonly origin?: NodeId;
}

export type BinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "==="
  | "!=="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"
  | "??"
  | "&"
  | "|"
  | "^"
  | "<<"
  | ">>"
  | ">>>"
  | "in"
  | "instanceof";

export type UnOp = "!" | "-" | "+" | "~" | "typeof" | "void";

export type LitValue =
  | { readonly k: "string"; readonly value: string }
  | { readonly k: "number"; readonly value: number }
  | { readonly k: "bigint"; readonly value: bigint }
  | { readonly k: "boolean"; readonly value: boolean }
  | { readonly k: "null" }
  | { readonly k: "undefined" };

/** The namer-resolved identifier handle `Ref(binding)` wraps. Merges with the constructor
 *  of the same name below — one name, type + value. */
export interface Binding extends Base {
  readonly t: "Binding";
  readonly text: string;
}

/** NARROWED departure from the mirror rule: `pattern: Binding` only — no rule mints an
 *  `ArrayPattern`/`RestBinding` or annotates a slot `type`. Omitting the optional `type`
 *  stays structurally assignable to the real `Param` (`{ pattern: Pattern; type?: TsType }`
 *  — a missing OPTIONAL field is not a mismatch). Widen only when a rule needs it. */
export interface Param {
  readonly pattern: Binding;
}

/** Residual shapes an emit rule constructs — plus two type-only arms (`RuntimeRef`,
 *  `ChunkExpr`) it may inspect or return but never mints. */
export type R =
  | (Base & { readonly t: "Ref"; readonly binding: Binding })
  | (Base & { readonly t: "Lit"; readonly value: LitValue })
  | (Base & { readonly t: "Call"; readonly callee: R; readonly args: readonly R[] })
  | (Base & { readonly t: "Method"; readonly recv: R; readonly name: string; readonly args: readonly R[] })
  | (Base & { readonly t: "Index"; readonly recv: R; readonly index: R })
  | (Base & { readonly t: "Member"; readonly recv: R; readonly name: string })
  | (Base & { readonly t: "Bin"; readonly op: BinOp; readonly left: R; readonly right: R })
  | (Base & { readonly t: "Un"; readonly op: UnOp; readonly arg: R })
  | (Base & { readonly t: "Arrow"; readonly params: readonly Param[]; readonly body: R; readonly async?: boolean })
  | (Base & { readonly t: "ArrayLit"; readonly elements: readonly R[] })
  | (Base & { readonly t: "Spread"; readonly value: R })
  /** TYPE ARM, no constructor. Rules MINT runtime refs via `ctx.runtime(sym): R`; `apply`'s
   *  rule instead INSPECTS an already-lowered argument (`f.t === "RuntimeRef"`, then reads
   *  `f.symbol`) to recognize the `+`/`*` shim value its fold identity depends on
   *  (`(apply + xs)` → a reduce with the correct identity). That value is minted by the
   *  walker engine (residual/types.ts's `RuntimeRef`), never here. Without this arm,
   *  `f.t === "RuntimeRef"` is a TS2367 (no tag overlap) once `apply` is typed against this
   *  file's `R`. */
  | (Base & { readonly t: "RuntimeRef"; readonly symbol: string })
  /** TYPE ARM, no constructor. A rule may return the compiler's hard chunk; the only mint
   *  site anywhere is the compiler's `ChunkExpr(...)` (residual/types.ts, the sole
   *  `typescript`-importing constructor). Field-for-field identical here so that
   *  externally-minted value is structurally assignable through `EmitRule<R>.call`.
   *  `ChunkStmt` does NOT join: `call` only returns expression-position residuals. */
  | (Base & { readonly t: "ChunkExpr"; readonly ast: OpaqueTsNode; readonly slots?: ReadonlyMap<SlotId, R> });

// ─── Constructors — the ONLY sanctioned way to build a residual-lite value (no raw object
// literals at rule sites), field order matching residual/types.ts. ───

/** Namer-adapter seam. A rule needing a fresh local goes through `EmitCtx.fresh`; this is
 *  for the rare minted-GLOBAL case (quotient's `Math`). */
export function Binding(text: string): Binding {
  return { t: "Binding", text };
}

export function Ref(binding: Binding): R {
  return { t: "Ref", binding };
}

/** Smart constructor: infers the `LitValue` tag from the JS value, so call sites write
 *  bare `Lit(0)` / `Lit(false)`. */
export function Lit(value: string | number | bigint | boolean | null | undefined): R {
  const v: LitValue =
    value === null
      ? { k: "null" }
      : value === undefined
        ? { k: "undefined" }
        : typeof value === "string"
          ? { k: "string", value }
          : typeof value === "number"
            ? { k: "number", value }
            : typeof value === "bigint"
              ? { k: "bigint", value }
              : { k: "boolean", value };
  return { t: "Lit", value: v };
}

export function Call(callee: R, args: readonly R[]): R {
  return { t: "Call", callee, args };
}

export function Method(recv: R, name: string, args: readonly R[]): R {
  return { t: "Method", recv, name, args };
}

export function Index(recv: R, index: R): R {
  return { t: "Index", recv, index };
}

export function Member(recv: R, name: string): R {
  return { t: "Member", recv, name };
}

export function Bin(op: BinOp, left: R, right: R): R {
  return { t: "Bin", op, left, right };
}

export function Un(op: UnOp, arg: R): R {
  return { t: "Un", op, arg };
}

/** Mirrors residual/types.ts's `Arrow`/`toParam` sugar, narrowed to Binding params (see
 *  `Param`). Widen alongside `Param` if a rule needs destructured/typed params. */
export function Arrow(params: readonly Binding[], body: R, async?: boolean): R {
  return { t: "Arrow", params: params.map((pattern) => ({ pattern })), body, async };
}

export function ArrayLit(elements: readonly R[]): R {
  return { t: "ArrayLit", elements };
}

export function Spread(value: R): R {
  return { t: "Spread", value };
}
