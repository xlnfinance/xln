// AKernelKeyword — the first-class marker a kernel special-form name resolves to.
//
// `lambda` / `define` / `let` / … are bound (on the scheme/core pack) to an AKernelKeyword
// carrying the special-form's dispatch name. The evaluator resolves a call's HEAD
// through the env and, when it resolves to an AKernelKeyword, dispatches the kernel handler
// `SPECIAL_FORMS[kw.name]` instead of applying it. So special-ness travels with the
// VALUE, not the spelling of the head:
//
//   (define => lambda)            ; => now holds the lambda keyword marker…
//   (=> (x) x)                    ; …and is lambda — aliasing falls out for free
//   (let ((lambda 5)) (lambda))   ; lexically shadowed → NOT special, just a call
//
// The dual of cxr: kernel-direct, yet still an ordinary, resolvable, shadowable
// symbol value. Built by `symbol.keyword` (bound as `new AKernelKeyword(name)` in
// the capability bake loop); detected by the evaluator via `instanceof AKernelKeyword`.
//
// It is an AValue (not a bare class) so it survives the JS↔scheme membrane intact:
// `AValue.fromJs` returns an already-AValue as-is, where a plain object would be
// boxed to AJSObject (losing the marker identity, and with it the dispatch). A
// constant syntactic marker — CONSTANT_CTX, provenance-free, identity equality.
//
// Named `AKernelKeyword`, not `Keyword`: it is the KERNEL special-form marker, distinct
// from `AKeywordSymbol` (the `:foo` SRFI-88 keyword datum). The `kind: "keyword"` def-tag
// string is unchanged.
import { AValue } from "./primitives/AValue.js";

export class AKernelKeyword extends AValue {
  readonly kind = "keyword" as const;

  constructor(readonly name: string) {
    super();
  }

  ["arrival/toJS"](): unknown {
    return `#<keyword:${this.name}>`;
  }

  // A constant syntactic marker carries no provenance lineage — stamping is a no-op,
  // returning the receiver unchanged.
  withProvenance(): this {
    return this;
  }

  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AKernelKeyword && other.name === this.name;
  }

  toString(): string {
    return `#<keyword:${this.name}>`;
  }

  // The printer renders this via its generic constructor-name branch (`#<AKernelKeyword>`),
  // NOT this toString (`#<keyword:name>`): the printer's own-toString shortcut needs
  // `hasOwnProperty("toString")`, false for a prototype method.
  ["arrival/print"](): string {
    return `#<${this.constructor.name}>`;
  }
}
