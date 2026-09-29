// symbols — the `symbol` namespace: one tagged-template factory per file, re-exported here.
// `../symbol.js` does `export * as symbol from "./symbols/index.js"`. One-file-per-tag lets the
// bundler include only accessed tags. Shared machinery in ./_bake.js. Acyclic.
//
// docs/environments.md §SYMBOL-KINDS — authoritative per-kind table. Map is navigation only.
//
//   native        contour: scheme values, no validation
//   rosetta       membrane: decode → validate → encode
//   tagless       dispatch to operand's tagless-final method (throws if absent)
//   taglessGuard  tagless dispatch, #f when receiver can't answer
//   sequence      ctx-aware: scheme args + RunContext
//   notImplemented omitted verb (errors-as-doors)
//   keyword       special form first-class
//   macro         raw JS Macro/Syntax transformer
//   define        scheme-bodied value/procedure with contract
//   defineSyntax  scheme-bodied macro/expander
//   alias         duplicate binding under a new name
//   value         host data constant

export { default as native } from "./native.js";
export { rosetta } from "./rosetta.js";
export { tagless } from "./tagless.js";
export { taglessGuard } from "./taglessGuard.js";
export { sequence } from "./sequence.js";
export { notImplemented } from "./notImplemented.js";
export { keyword } from "./keyword.js";
export { macro } from "./macro.js";
export { define, defineSyntax } from "./define.js";
export { alias } from "./alias.js";
export { value } from "./value.js";
