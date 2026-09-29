import { TF_EXPAND } from "../values/tagless-final.js";
import { INTEROP_BOUNDARY } from "../well-known/symbols.js";
import type { RunContext } from "../run/RunContext.js";
import type { SchemeValue } from "../values/types.js";
import type { APair } from "../values/primitives/APair.js";
import type { AmbientRuntime } from "../env/AmbientRuntime.js";
import type { Resolver } from "./Resolver.js";
// Type-only: `Syntax` is a sibling transformer class; importing its type here
// (it imports types from this file) does not create a runtime cycle.
import type { Syntax } from "./Syntax.js";

/**
 * Uniform result of the `TF_EXPAND` term — a transcribed FORM plus, for a
 * hygienic transformer, the scope it must evaluate in. `Syntax.expand` always
 * supplies `scope` (its MacroExpansion); a Macro fexpr never does (evaluates
 * in the use-site resolver). `expr` may be a promise at runtime — a
 * define-macro `__fn__` can be async — which the evaluator awaits before
 * evaluating (thin sync wrapper; trampoline owns the await).
 */
export interface Expansion {
  expr: SchemeValue | Promise<SchemeValue>;
  scope?: AmbientRuntime;
}

export interface MacroInvokeContext {
  /** Use-site env (REQUIRED at invoke — both `Macro.invoke` and `Syntax.expand`
   *  bind it as `this` on the transformer). NOT on the bag a transformer RECEIVES:
   *  `MacroTransformer`'s ctx param is `Omit<MacroInvokeContext, "env">` so env
   *  travels as `this`, never duplicated on the args object. */
  env: unknown;
  /** Per-run context, threaded to the macro engine's mint door
   *  (eval/syntax-rules.ts) so expander-minted values charge the allocation
   *  meter. REQUIRED: is_macro dispatch always holds a live EvalContext.runCtx;
   *  optional would reopen a `?? CONSTANT_CTX` silent-unmeter fallback. */
  runCtx: RunContext;
  /** Use-site resolver (synced to `env`). The expander uses the def-time
   *  Resolver a Syntax captures instead. Optional — define-macro fexprs ignore it. */
  resolver?: Resolver;
  [key: string]: unknown;
}

/** The args bag a macro transformer RECEIVES (its second parameter). `env` is
 *  omitted — it travels as `this`, not on the bag. Declared as its own interface
 *  (not `Omit<MacroInvokeContext, "env">`) so the named fields keep their types
 *  through destructuring — `MacroInvokeContext`'s `[key: string]: unknown` index
 *  signature would otherwise widen every field to `unknown` under `Omit`. */
export interface TransformerArgs {
  runCtx: RunContext;
  resolver?: Resolver;
  [key: string]: unknown;
}

/**
 * Expansion record a `Syntax` transformer returns: the transcribed FORM plus the
 * hygiene scope it must evaluate in. Co-defined with `Macro` (not in Syntax.ts)
 * so `MacroTransformer` below can name it without a cycle.
 */
export interface MacroExpansion {
  expr: SchemeValue | Promise<SchemeValue>;
  scope: AmbientRuntime;
}

/**
 * Duck-shape of a macro-transformer body — the function `__fn__` both `Macro`
 * (define-macro fexpr) and `Syntax` (syntax-rules) close over. Invoked via
 * `.call(env, code, ctx, name)`: `this` is bound to the use-site AmbientRuntime,
 * the first arg is the UNEVALUATED code/form, the second the invoke context, the
 * third the transformer name.
 *
 * Return is polymorphic by use site: a define-macro fexpr returns a replacement
 * `SchemeValue` FORM (the trampoline evaluates it; may be a Promise the trampoline
 * awaits); a `Syntax` transformer returns a `MacroExpansion` (form + hygiene scope);
 * the `syntax-rules` CONSTRUCTOR body returns a `Macro`/`Syntax` transformer VALUE
 * the macro engine special-cases.
 */
export type MacroTransformer = (
  this: AmbientRuntime,
  code: SchemeValue,
  ctx: TransformerArgs,
  name: string | symbol,
) => SchemeValue | Promise<SchemeValue> | MacroExpansion | Macro | Syntax;

/**
 * A define-macro fexpr: receives UNEVALUATED code and returns a replacement
 * form. `Syntax` (syntax-rules) is a sibling, not a subclass. `__defmacro__`
 * marks instances that `macroexpand` may expand.
 *
 * Lineage: fexpr — first-class operative with UNEVALUATED operands (Pitman
 * 1980; Shutt 2010).
 */
export class Macro {
  // Outside the AValue/ArrivalError families that FAMILY RULEs cover — own stamp
  // (membrane.ts is_macro_value dispatch can reach the interop read path).
  static [INTEROP_BOUNDARY] = true;
  // Value-layer downward-readable macro identity — is_macro_value (value-guards.ts)
  // with no value→eval runtime edge.
  readonly ["arrival/is-macro"] = true;

  __name__: string;
  __fn__: MacroTransformer;
  __doc__?: string;
  __defmacro__?: boolean;
  /** Ternary static-walk attribute, stamped by `symbol.defineSyntax`'s bind arm
   *  (common/symbols/define-bake.ts) from `DefineSyntaxSymbolDef.macroAttribute`.
   *  `undefined` (prelude-era / JS-authored transformers) reads as `"opaque"` —
   *  the safe under-report default the validator's firewall assumes
   *  (static-validation/vocabulary.ts). */
  macroAttribute?: "opaque" | "expression" | "binder";

  constructor(name: string, fn: MacroTransformer, doc?: string, dump?: boolean) {
    if (doc) {
      this.__doc__ = dump
        ? doc
        : doc
            .split("\n")
            .map((line) => line.trim())
            .join("\n");
    }
    this.__name__ = name;
    this.__fn__ = fn;
  }

  // Exp→Exp: returns a replacement FORM (SchemeValue), never an expansion
  // record — that is Syntax.expand's job. `env` binds as `this` on the transformer
  // (the contract is `this: AmbientRuntime`; `MacroInvokeContext.env` is `unknown`
  // because Resolver.env is duck-typed, hence the cast). Stripped from the args bag
  // so it isn't passed twice — `TransformerArgs` is `Omit<MacroInvokeContext, "env">`.
  invoke(code: unknown, ctx: MacroInvokeContext, macro_expand: boolean = false): SchemeValue | Promise<SchemeValue> {
    const { env, ...rest } = ctx;
    return this.__fn__.call(env as AmbientRuntime, code as SchemeValue, { ...rest, macro_expand }, this.__name__) as
      | SchemeValue
      | Promise<SchemeValue>;
  }

  // RAW-ARG dispatch term (head gate via is_expandable). Consumes keyword-stripped
  // operands (`code.cdr`); produces a scope-less Expansion (use-site resolver).
  // Thin sync wrapper: possibly-async invoke result rides `expr`; trampoline awaits.
  [TF_EXPAND](code: APair<SchemeValue, SchemeValue>, ctx: MacroInvokeContext): Expansion {
    return { expr: this.invoke(code.cdr, ctx, false) };
  }

  toString(): string {
    return `#<macro:${this.__name__}>`;
  }
}
