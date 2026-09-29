import { TF_EXPAND } from "../values/tagless-final.js";
import { INTEROP_BOUNDARY, MERGE } from "../well-known/symbols.js";
import type { AmbientRuntime } from "../env/AmbientRuntime.js";
import type { SchemeValue } from "../values/types.js";
import type { Expansion, MacroExpansion, MacroInvokeContext, MacroTransformer } from "./Macro.js";
import type { APair } from "../values/primitives/APair.js";
import type { Resolver } from "./Resolver.js";

type SyntaxLike = Syntax | MacroTransformer;

/**
 * A `syntax-rules` transformer. NOT a Macro: Macro is a runtime fexpr value;
 * Syntax is an EXPAND-TIME rewriter that captures its definition env
 * (`__env__`) for hygiene and returns an already-quoted expansion
 * (evaluatePair forwards Syntax results without re-evaluating). They share a
 * duck shape (`__name__`/`__fn__`/`__defmacro__`/`invoke`) treated uniformly
 * via `is_macro`, but neither is-a the other — hence no `extends`.
 *
 * Lineage: hygienic macro transformer (Kohlbecker et al. 1986; Clinger & Rees
 * 1991); nested Parameter is SRFI-139 syntax parameters.
 */
export class Syntax {
  // Outside AValue/ArrivalError families — own interop stamp (same as Macro).
  static [INTEROP_BOUNDARY] = true;
  // Value-layer macro identity — is_macro_value treats Syntax as a macro too.
  readonly ["arrival/is-macro"] = true;
  static __merge_env__ = MERGE;
  // SRFI-139
  static Parameter = class SyntaxParameter {
    static [INTEROP_BOUNDARY] = true;
    // is_macro_value must answer true for syntax parameters.
    readonly ["arrival/is-macro"] = true;

    _syntax!: SyntaxLike; // Definite assignment - set via Object.defineProperty
    constructor(syntax: SyntaxLike) {
      Object.defineProperty(this, "_syntax", {
        value: syntax,
        configurable: true,
        enumerable: false,
      });
      Object.defineProperty(syntax, "_param", {
        value: true,
        configurable: true,
        enumerable: false,
      });
    }
  };

  __name__: string = "";
  __fn__: MacroTransformer;
  __defmacro__: boolean;
  __env__: unknown;
  /**
   * Original macro FORM this transformer was built from (`(syntax-rules …)`
   * operands), stashed by the syntax-rules constructor for inspection/printing.
   * Held on the transformer object, outside the value channel.
   */
  __code__?: SchemeValue;
  /**
   * Def-time Resolver wrapping `__env__` — the hygiene identity root. Captured
   * here and closed over by the transformer in env/macros/macros.ts.
   */
  __resolver__: Resolver | undefined;

  constructor(fn: MacroTransformer, env: unknown, resolver?: Resolver) {
    this.__fn__ = fn;
    this.__env__ = env;
    this.__resolver__ = resolver;
    this.__defmacro__ = true;
  }

  // Exp→Exp: always returns transcribed form + hygiene scope (MacroExpansion).
  // macro_expand pinned true; transformer ignores it — kept for fexpr-arg parity.
  expand(code: unknown, { env, runCtx, resolver }: MacroInvokeContext): MacroExpansion {
    const args = {
      env,
      macro_expand: true,
      runCtx,
      resolver,
      defResolver: this.__resolver__,
    };
    return this.__fn__.call(
      env as AmbientRuntime,
      code as SchemeValue,
      args,
      this.__name__ || "syntax",
    ) as MacroExpansion;
  }

  // RAW-ARG dispatch term. Matches against the FULL form (`code` — keyword
  // occupies the pattern's first slot), so unlike Macro it forwards `code`
  // intact, not `code.cdr`. Returns `{ expr, scope }`.
  [TF_EXPAND](code: APair<SchemeValue, SchemeValue>, ctx: MacroInvokeContext): Expansion {
    return this.expand(code, ctx);
  }

  toString(): string {
    if (this.__name__) {
      return `#<syntax:${this.__name__}>`;
    }
    return "#<syntax>";
  }
}
