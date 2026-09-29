// @inhuman.tools/arrival/r7rs/exceptions — R7RS-small §6.11 exception handling:
// *current-exception-handlers*, raise, raise-continuable, with-exception-handler,
// error, and the guard derived syntax.
//
// Opposite face of the purity doors (control for dynamics, type packs for mutators):
// those name omissions; this pack supplies the exception forms kept. Owns the
// %raise / %current-handlers / %set-handlers! / make-error-object machinery;
// error-objects.ts is the R7RS predicate surface only. Sole definition site.
//
// HANDLER-STACK LAW: stack is WeakMap<RunContext, stack> — never a scheme binding
// or module mutable. RunContext is minted once per top-level exec() and threaded
// by reference through every nested frame (define-bake forwards the caller's real
// runCtx across define→define boundaries). Fresh per exec(), shared within that
// run, isolated across concurrent exec() on the same isolate.
//
// Bodies route through machinery natives (%handler-car/cdr, %with-restore, …)
// rather than bare car/cdr/try. deferred: fold onto plain forms (both bakeable).
import { EnvCapability } from "../../common/capability.js";
import type { CallCtx } from "../../run/CallCtx.js";
import { R7RSError } from "../../errors.js";
import { AString } from "../../values/primitives/AString.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { APair } from "../../values/primitives/APair.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import type { RunContext } from "../../run/RunContext.js";
import type { SchemeValue } from "../../values/types.js";
import { schemeBool as bool } from "../../values/op-helpers.js";
import { to_array } from "../pack-helpers.js";
import invariant from "tiny-invariant";

// HANDLER-STACK LAW — see preamble.
const handlersByRun = new WeakMap<RunContext, SchemeValue>();

// raise/error carry arbitrary data (§6.11), including R7RSError. z.schemeValue is
// instanceof AValue — R7RSError is a raw host Error (z.error exists because it is
// not AValue), so schemeValue alone rejects condition objects. define contracts
// enforce at the call boundary: every raised/returned slot must admit R7RSError
// explicitly (guard else-exn round-trips through raise's obj).
export default EnvCapability.define("scheme/r7rs/exceptions", {
  symbols: (symbol, z) => ({
    // Throw obj directly (preserve type for R7RS exception handling).
    "%raise": symbol.native`%raise: throw obj directly (machinery — the R7RS forms build on this)`(
      // Arbitrary data (§6.11). Output undefinedResult — always throws.
      { input: [z.schemeValue], output: [z.undefinedResult] },
      function (this: CallCtx, obj) {
        throw obj;
      },
    ),
    // Machinery push/pop — not set! of a scheme binding.
    "%current-handlers": symbol.native`%current-handlers: read the exception-handler stack (machinery)`(
      // Stack is a proper list; no typed "list of procedures" schema → z.schemeValue.
      { input: [], output: [z.schemeValue] },
      // this.runCtx is the WeakMap key. Absent ⇒ empty stack.
      function (): SchemeValue {
        return (handlersByRun.get(this.runCtx) ?? nil) as SchemeValue;
      },
    ),
    "%set-handlers!": symbol.native`%set-handlers!: replace the exception-handler stack (machinery)`(
      // Same list shape as %current-handlers; output always nil.
      { input: [z.schemeValue], output: [z.nil] },
      function (handlers) {
        handlersByRun.set(this.runCtx, handlers as SchemeValue);
        return nil;
      },
    ),
    "make-error-object": symbol.native`make-error-object: build an R7RS error object from a message and irritants`(
      // `message` is display-rendered via `.valueOf()`/`String()` regardless of scheme type
      // (see the impl) — `z.schemeValue`. `irritants` are carried through untouched (any scheme
      // values, stored as-is on the error object) — `z.schemeValue` for the rest too. Output is a
      // real validator (`instanceof R7RSError`): the impl always returns this ONE concrete
      // host `Error` subclass, never an arbitrary scheme value.
      {
        input: [z.string],
        inputRest: z.schemeValue,
        output: [z.error],
      },
      function (this: CallCtx, message, ...irritants) {
        const msg = message instanceof AString ? message.valueOf() : String(message);
        return new R7RSError(msg, ...irritants);
      },
    ),

    // ── Handler-stack machinery ──────────────────────────────────────────────────
    // car/cdr/cons, specifically — never a general-purpose accessor. Existing
    // solely so the `symbol.define` bodies below never reference bare
    // `car`/`cdr`/`cons` directly (see the file header).
    "%handlers-empty?": symbol.native`%handlers-empty?: is the exception-handler stack empty (machinery)`(
      { input: [z.schemeValue], output: [z.boolean] },
      function (this: CallCtx, stack) {
        return bool(stack instanceof ANil);
      },
    ),
    "%handler-car": symbol.native`%handler-car: the top handler of a non-empty exception-handler stack (machinery)`(
      { input: [z.schemeValue], output: [z.schemeValue] },
      function (this: CallCtx, stack) {
        invariant(stack instanceof APair, "%handler-car: the exception-handler stack is empty");
        return stack.car as SchemeValue;
      },
    ),
    "%handler-cdr": symbol.native`%handler-cdr: the exception-handler stack minus its top handler (machinery)`(
      { input: [z.schemeValue], output: [z.schemeValue] },
      function (this: CallCtx, stack) {
        invariant(stack instanceof APair, "%handler-cdr: the exception-handler stack is empty");
        return stack.cdr as SchemeValue;
      },
    ),
    "%push-handler": symbol.native`%push-handler: prepend handler onto the exception-handler stack (machinery)`(
      { input: [z.schemeValue, z.schemeValue], output: [z.schemeValue] },
      function (handler, stack) {
        return new APair(handler as SchemeValue, stack as SchemeValue);
      },
    ),
    // The finally-discipline, kept out of scheme-level `try`/`finally` (see the
    // file header): call `thunk` (0-arg), always call `restore` (0-arg) on the
    // way out — whether `thunk` returned normally or threw — and return/rethrow
    // accordingly.
    "%with-restore":
      symbol.native`%with-restore: call thunk, always calling restore afterward — even if thunk throws (machinery)`(
        { input: [z.lambda, z.lambda], output: [z.schemeValue] },
        async function (thunk, restore) {
          // `this` IS the whole CallCtx `%with-restore` was dispatched with — thread it, not
          // just `this.runCtx`.
          try {
            return await applyCallback(thunk, [], this);
          } finally {
            await applyCallback(restore, [], this);
          }
        },
      ),
    // `error`'s message+irritants forwarding needs a scheme-list → variadic-args
    // splice (i.e. `apply`) — `apply` IS a genuine `scheme/lists` export (not a
    // resolver-synthesized name like car/cdr), but depending on `scheme/lists`
    // just for this one splice would reintroduce a cross-capability ordering
    // dependency this pack's header states it has none of — so the splice moves
    // into this native instead, reusing `make-error-object`'s own construction
    // logic.
    "%error-object-from-irritants":
      symbol.native`%error-object-from-irritants: build an R7RS error object from a message and a scheme list of irritants (machinery)`(
        { input: [z.string, z.schemeValue], output: [z.error] },
        function (this: CallCtx, message, irritantsList) {
          const msg = message instanceof AString ? message.valueOf() : String(message);
          const irritants = to_array("error")(irritantsList as SchemeValue);
          return new R7RSError(msg, ...irritants);
        },
      ),

    // R7RS §6.11: raise invokes the current handler in the dynamic environment of
    // the call to raise, except that the current exception handler is the one that
    // was in place when THIS handler was installed (i.e. the rest of the stack).
    // So we POP the handler before invoking it — otherwise a raise inside the
    // handler re-reads the same car and recurs forever. If a non-continuable
    // handler returns, a secondary exception is raised in the handler's dynamic
    // environment (the popped stack still in place).
    raise:
      symbol.define`raise: invoke the current exception handler with obj (R7RS §6.11) — pops the handler first so a raise inside it can't loop on the same entry`(
        { input: [z.union([z.schemeValue, z.error])], output: [z.undefinedResult] },
        `(lambda (obj)
         (if (%handlers-empty? (%current-handlers))
             (%raise obj)
             (let ((handler (%handler-car (%current-handlers)))
                   (rest (%handler-cdr (%current-handlers))))
               (%set-handlers! rest)
               (handler obj)
               ;; handler returned for a non-continuable exception → secondary raise,
               ;; still with the popped stack (rest) in place.
               (raise (make-error-object
                        "exception handler returned for non-continuable exception")))))`,
      ),

    // raise-continuable: same pop discipline, but the handler's return value is
    // returned to the call site of raise-continuable. Restore the stack on the way
    // out so the value flows back into the original dynamic environment.
    "raise-continuable":
      symbol.define`raise-continuable: like raise, but the handler's return value flows back to raise-continuable's own call site (R7RS §6.11)`(
        { input: [z.union([z.schemeValue, z.error])], output: [z.union([z.schemeValue, z.error])] },
        `(lambda (obj)
         (if (%handlers-empty? (%current-handlers))
             (%raise obj)
             (let ((handler (%handler-car (%current-handlers)))
                   (rest (%current-handlers)))
               (%set-handlers! (%handler-cdr rest))
               (%with-restore (lambda () (handler obj))
                               (lambda () (%set-handlers! rest))))))`,
      ),

    // with-exception-handler installs handler for the duration of thunk and removes
    // it on the way out — via the %with-restore finally-discipline, which restores
    // the stack whether thunk returns normally OR escapes via a thrown exception
    // (e.g. a handler that exits through guard's catch). No catch+re-raise here:
    // re-raising would re-deliver an exception the inner handler already saw to the
    // outer handler (double delivery).
    "with-exception-handler":
      symbol.define`with-exception-handler: install handler for the dynamic extent of thunk, removed on the way out (R7RS §6.11)`(
        { input: [z.lambda, z.lambda], output: [z.schemeValue] },
        `(lambda (handler thunk)
         (let ((old-handlers (%current-handlers)))
           (%set-handlers! (%push-handler handler old-handlers))
           (%with-restore thunk
                           (lambda () (%set-handlers! old-handlers)))))`,
      ),

    error: symbol.define`error: raise a new error object built from message and irritants (R7RS §6.11)`(
      { input: [z.string], inputRest: z.union([z.schemeValue, z.error]), output: [z.undefinedResult] },
      `(lambda (message . irritants)
         (raise (%error-object-from-irritants message irritants)))`,
    ),

    guard:
      symbol.defineSyntax`guard: (guard (var clause…) body…) — evaluate body, dispatching a raised condition through clause with var bound to it (R7RS §6.11 derived syntax)`(
        // `var` is a FORMALS-position binder (bound across every clause), matching
        // `let-values`/`let*-values`'s own "binder" classification — NOT
        // "expression" (an expression-space walk would wrongly report `var`
        // unbound in every clause referencing it).
        `(lambda (clause-and-body . rest)
         (let* ((var (car clause-and-body))
                (clauses (cdr clause-and-body))
                (body rest))
           \`(try
              (begin ,@body)
              (catch (,var)
                (cond
                  ,@clauses
                  (else (raise ,var)))))))`,
        { macroAttribute: "binder" },
      ),
  }),
});
