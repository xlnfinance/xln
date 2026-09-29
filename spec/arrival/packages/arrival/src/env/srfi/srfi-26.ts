// SRFI-26 — cut / cute (parameter specialization). Sole definition site (allSrfi).
//
// Placeholders `<>` / `<...>` are slot-selection SYNTAX at call sites, not variables.
// `<>` also resolves as a polyglot-stubs door elsewhere — an "expression" walk would
// either false-positive unbound or silently-wrong bound-to-door. Not formals either
// (not binder) — consumed positionally by the expander, never in the expansion body.
// → macroAttribute: "opaque" (honest: under-report call-site interior, never guess).
//
// Bake FV never walks defineSyntax bodies; opaque is consumed by validateProgram on
// PROGRAM call sites of cut/cute.
//
// deps: [equality, lists] — transformer free names (null?/pair?/symbol?/equal?,
// append/reverse) bake as closures over null-rooted bakeEnv; standalone without
// those deps fails unbound at expand. NOT deps:[core] — gensym is free because core
// is BASE_PACKS position 0; a real deps edge would force AssembleLinearizationError.
import { EnvCapability } from "../../common/capability.js";
import equality from "../r7rs/equality.js";
import lists from "../r7rs/lists.js";

export default EnvCapability.define("scheme/srfi-26", {
  deps: [equality, lists],
  symbols: (symbol) => ({
    cut: symbol.defineSyntax`cut: specialize parameters without currying (SRFI-26). \`<>\` is a positional slot, \`<...>\` a (final) rest slot — \`(cut f a <>)\` builds (lambda (g) (f a g)); \`(cut f <...>)\` builds (lambda (. g) (apply f g)). Non-slot subexpressions stay in the body and re-evaluate on every call (contrast cute). Slot params are gensym'd so a non-slot expr referencing a same-named variable can't be captured.`(
      `(lambda items
         (let loop ((items items) (params '()) (call '()) (restp #f))
           (cond
             ((null? items)
              (if restp
                  \`(lambda ,(append (reverse params) restp) (apply ,@(reverse call) ,restp))
                  \`(lambda ,(reverse params) (,@(reverse call)))))
             ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<>"))
              (let ((g (gensym))) (loop (cdr items) (cons g params) (cons g call) restp)))
             ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<...>"))
              (loop (cdr items) params call (gensym)))
             (else (loop (cdr items) params (cons (car items) call) restp)))))`,
      { macroAttribute: "opaque" },
    ),
    cute: symbol.defineSyntax`cute: like cut, but lifts every non-slot subexpression into a let so it evaluates EXACTLY ONCE at specialization time (SRFI-26's whole point: \`(cute f (expensive) <>)\` calls (expensive) once, not on every call).`(
      `(lambda items
         (let loop ((items items) (params '()) (call '()) (binds '()) (restp #f))
           (cond
             ((null? items)
              (let ((lam (if restp
                             \`(lambda ,(append (reverse params) restp) (apply ,@(reverse call) ,restp))
                             \`(lambda ,(reverse params) (,@(reverse call))))))
                (if (null? binds) lam \`(let ,(reverse binds) ,lam))))
             ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<>"))
              (let ((g (gensym))) (loop (cdr items) (cons g params) (cons g call) binds restp)))
             ((and (symbol? (car items)) (equal? (symbol->string (car items)) "<...>"))
              (loop (cdr items) params call binds (gensym)))
             (else (let ((t (gensym))) (loop (cdr items) params (cons t call) (cons (list t (car items)) binds) restp))))))`,
      { macroAttribute: "opaque" },
    ),
  }),
});
