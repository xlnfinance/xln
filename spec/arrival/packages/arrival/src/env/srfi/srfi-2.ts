// SRFI-2 — and-let*. Sole definition site (base-packs via allSrfi).
//
// Claws are FORMALS position, not expression space → `macroAttribute: "binder"`
// (honest classification; firewalled like opaque until a binding-aware walker lands).
//
// `symbol.defineSyntax` binds a Macro directly (define-bake Pass 2) — works in
// sandboxed and main env alike (no scheme define-syntax special-form parse needed).
//
// deps: [equality] — transformer body calls null?/pair? (not cxr-allowlisted). A
// buildVocabulary([this]) closure without equality fails at expansion time unbound;
// production BASE_ROSTER always includes equality. Standalone pack builds need the edge.
import { EnvCapability } from "../../common/capability.js";
import equality from "../r7rs/equality.js";

export default EnvCapability.define("scheme/srfi-2", {
  deps: [equality],
  symbols: (symbol) => ({
    "and-let*":
      symbol.defineSyntax`and-let*: sequential AND with binding (SRFI-2). Claw (var expr) binds+tests var; claw (expr) is a bare guard; a bare symbol tests itself. Any #f short-circuits the whole form to #f; otherwise the value is the body (or #t when there is no body).`(
        `(lambda (claws . body)
         (if (null? claws)
             (if (null? body) #t \`(begin ,@body))
             (let ((claw (car claws)) (rest (cdr claws)))
               (cond
                 ((and (pair? claw) (pair? (cdr claw)))
                  \`(let ((,(car claw) ,(cadr claw)))
                     (if ,(car claw) (and-let* ,rest ,@body) #f)))
                 ((pair? claw)
                  \`(if ,(car claw) (and-let* ,rest ,@body) #f))
                 (else
                  \`(if ,claw (and-let* ,rest ,@body) #f))))))`,
        { macroAttribute: "binder" },
      ),
  }),
});
