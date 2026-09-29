// @inhuman.tools/arrival/r7rs/syntax — R7RS §4.3.1 / §5.3 macro-binding forms.
//
// Traditional Scheme: macros live in a separate expansion-time namespace → three
// forms for top / local / recursive-local placement. Arrival collapsed that split:
// a transformer is a first-class VALUE; evaluator dispatches is_macro after ordinary
// lexical resolve. The three forms are exact aliases:
//   define-syntax ≡ define · let-syntax ≡ let · letrec-syntax ≡ letrec
// Recursive-vs-not falls out of let/letrec scoping. Kept so portable R7RS macro
// source loads unchanged; no early syntaxhood guard (use-site not-callable suffices).
//
// macroAttribute: "binder" on all three — the FIRST arg is a bound name (or binding
// list), not a free reference. An "expression" walk would report every legal
// (define-syntax my-macro …) / (let-syntax ((n t) …) body) as unbound. Firewalled
// like opaque until a binding-aware walker lands — honest classification, not behavior.

import { EnvCapability } from "../../common/capability.js";

// Library / inclusion / feature-expand forms (§4.1.7 / §4.2.1 / §4.3.3 / §5.2 / §5.6.1)
// are doored: file inclusion and library reification are ambient I/O + module-plane
// state outside the closed sandbox; feature expand and syntax-error are not yet built.
const INCLUDE =
  "file inclusion is omitted from this sandbox — source arrives through tools, not ambient include paths; inline the text or pass it in via a bound filesystem tool instead";
const LIBRARY =
  "library forms are omitted from arrival by design — define-library / import reify a module plane as ambient state outside the closed capability surface; assemble EnvCapability packs instead";
const COND_EXPAND =
  "cond-expand is not yet implemented — feature-based conditional expansion needs a declared features set arrival does not reify (features itself is a host door); pick one branch at authoring time instead";
const SYNTAX_ERROR =
  "syntax-error is not yet implemented — raise a static/teaching failure via error / raise at expansion or run time, or fail the capability bake, instead of a dedicated expand-time form";

export default EnvCapability.define("scheme/r7rs/syntax", {
  symbols: (symbol) => ({
    "define-syntax":
      symbol.defineSyntax`define-syntax: (define-syntax name expr) — R7RS §5.3, bind a transformer at top scope. Exact alias of \`define\` — arrival's transformers are first-class values, not a separate namespace.`(
        `(lambda (name expr)
         \`(define ,name ,expr))`,
        { macroAttribute: "binder" },
      ),

    "let-syntax":
      symbol.defineSyntax`let-syntax: (let-syntax ((name transformer) …) body …) — R7RS §4.3.1, bind transformers locally, non-recursively. Exact alias of \`let\` — non-recursive scoping falls out of let's own scoping math.`(
        `(lambda (vars . body)
         \`(let ,vars ,@body))`,
        { macroAttribute: "binder" },
      ),

    "letrec-syntax":
      symbol.defineSyntax`letrec-syntax: (letrec-syntax ((name transformer) …) body …) — R7RS §4.3.1, bind transformers locally, allowing mutual self-reference. Exact alias of \`letrec\` — recursive scoping falls out of letrec's own scoping math.`(
        `(lambda (vars . body)
         \`(letrec ,vars ,@body))`,
        { macroAttribute: "binder" },
      ),

    include: symbol.notImplemented`include: ${INCLUDE}`,
    "include-ci": symbol.notImplemented`include-ci: ${INCLUDE}`,
    "cond-expand": symbol.notImplemented`cond-expand: ${COND_EXPAND}`,
    "define-library": symbol.notImplemented`define-library: ${LIBRARY}`,
    import: symbol.notImplemented`import: ${LIBRARY}`,
    "syntax-error": symbol.notImplemented`syntax-error: ${SYNTAX_ERROR}`,
  }),
});
