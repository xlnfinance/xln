// scheme/core — the irreducible scheme core pack: the constants true/false/NaN,
// the 20 kernel keywords, and gensym.
//
// The precedence floor of the base stdlib: assembled FIRST among the base packs
// (its sole definition site), dep-free by construction, so every other base pack
// (polyglot / r7rs / srfi / …) composes against it. gensym is the one native
// binding; true/false/NaN the only constants; no define-macro forms live here.
// The syntax-binding forms (define-syntax / let-syntax / letrec-syntax) are NOT
// here — they are guardless R7RS aliases in env/r7rs/syntax.ts.
//
// The 20 keyword entries are KEYWORD_SYNTAX_BASELINE (common/symbols/define-bake.ts):
// an unconditional allowlist member for every other capability's bake
// free-variable check, because they live on this floor.
//
// Every evaluator special form (SPECIAL_FORMS) is also a keyword, for two reasons:
// (1) first-class value-carried dispatch — `(define => lambda)` aliases the form,
// lexical shadowing un-specials it (the dual of cxr; see values/AKernelKeyword.ts);
// (2) hygiene resolves a renamed template head (`if` → `#:if`) by copying the
// original name's ENV VALUE (syntax-rules.ts rename()), and a name-only special
// form has no env value for a user macro expanding to it to resolve. cond / case /
// when / unless stay evaluator forms (TCO-correct, unlike the syntax-rules path)
// but are keyworded too, so no hygiene-renamed head ever misses dispatch.

import { EnvCapability } from "../../common/capability.js";
import { gensym } from "../../values/values-repr.js";

export default EnvCapability.define("scheme/core", {
  // gensym resolves at macro-EXPANSION time; the floor (assembled first) binds it where
  // every consumer reaches it.
  symbols: (symbol, z) => ({
    lambda: symbol.keyword`lambda: create an anonymous procedure`,
    define: symbol.keyword`define: bind a name in the current scope`,
    "define-macro": symbol.keyword`define-macro: define a fexpr-style unhygienic macro`,
    let: symbol.keyword`let: bind locals over a body`,
    "let*": symbol.keyword`let*: bind locals sequentially, each seeing the prior bindings`,
    letrec: symbol.keyword`letrec: bind locals that may reference each other (mutual recursion)`,
    "letrec*": symbol.keyword`letrec*: like letrec, but bindings are evaluated in order`,
    and: symbol.keyword`and: evaluate left to right, short-circuiting on the first false`,
    or: symbol.keyword`or: evaluate left to right, short-circuiting on the first true`,
    if: symbol.keyword`if: conditional — evaluate the consequent or the alternative`,
    begin: symbol.keyword`begin: evaluate a sequence, yield the last`,
    quote: symbol.keyword`quote: the datum, unevaluated`,
    quasiquote: symbol.keyword`quasiquote: a template datum with unquote holes`,
    cond: symbol.keyword`cond: first true test wins; its body (or => application) is the value`,
    case: symbol.keyword`case: dispatch on a key via eqv? datum lists`,
    when: symbol.keyword`when: evaluate the body when the test passes`,
    unless: symbol.keyword`unless: evaluate the body when the test fails`,
    do: symbol.keyword`do: iterate stepped bindings until the test clause is true`,
    while: symbol.keyword`while: iterate the body while the test evaluates truthy`,
    try: symbol.keyword`try: body with an optional catch/finally handler`,
    // Contract mirrors gensym's raw signature: the optional name hint is a raw symbol
    // NAME (string/symbol/number), an ASymbol, or null — never a boxed SchemeValue.
    // Output is the freshly-minted ASymbol. `type` pins the model-facing shape: an
    // optional string name in, a fresh symbol (string image) out.
    gensym: symbol.native`gensym: a fresh uninterned symbol (optional name hint)`(
      {
        input: [z.symbol.optional()],
        output: [z.symbol],
        type: "(name?: string) => string",
      },
      gensym,
    ),

    // Bare-ZodType contracts (not Contract<I,O>): z.boolean validates the literal
    // once at bake, then binds the plain value — there is no call boundary.
    true: symbol.define`true: the canonical scheme boolean truth constant`(z.boolean, `#t`),
    false: symbol.define`false: the canonical scheme boolean falsity constant`(z.boolean, `#f`),
    // z.number/z.inexact bottom out in zod's z.number(), which EXCLUDES NaN/±Infinity —
    // either would throw at bake decoding this very constant. z.looseNumber is the
    // permissive codec built for non-finite reals (+nan.0 / ±inf.0).
    NaN: symbol.define`NaN: the canonical scheme not-a-number constant (+nan.0), a non-finite inexact real`(
      z.looseNumber,
      `+nan.0`,
    ),
  }),
});
