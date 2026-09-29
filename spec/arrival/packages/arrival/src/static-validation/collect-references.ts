// collect-references — validator's SITE-COLLECTING, scope-correct reference walk.
// One `ReferenceOccurrence` per lexically-FREE symbol occurrence, in program order, each
// carrying the span of its innermost enclosing located Pair — raw material for a
// `ReferenceNode` graph.
//
// WHY NOT `provenance/wireframe/free-vars.ts` directly: that walker answers the
// wire-locality LAW — a *set* of names, no spans, deliberately conservative in the
// OVER-approximating direction (an unmodeled head walks as a plain application, so a
// missed binder yields an extra "free" name — harmless for locality, poison for an
// error-tier diagnostic). This walker shares free-vars' binder arms 1:1 (same local-copy
// convention prelude.ts/slice.ts/free-vars.ts each document) and extends them with what
// an error-tier soundness contract demands and a set-shaped FV cannot carry:
//
//   • SITES — every occurrence is (name × span), not a deduplicated name;
//   • MACRO FIREWALL — a call head resolving to a macro walks its interior by ternary
//     `macroAttribute`: "expression" ⇒ ordinary expression space; "opaque"/"binder" ⇒
//     interior contributes NOTHING — under-report, never lie. Binder-macro formals are
//     NOT expression space; walking them as such would be a false positive;
//   • `try` scope-correctness — `(try body (catch (var) handler…) (finally …))` binds
//     the catch variable for its handlers; `catch`/`finally` are structural literals;
//   • `define-macro`/`define-syntax` interiors SKIPPED — a macro body's free variables
//     name the EXPANSION env, outside this pass;
//   • INTERNAL-DEFINE letrec* scoping — every body SEQUENCE pre-collects its
//     define/define-macro/define-syntax names before walking any form, so
//     `(define (a) (b)) (define (b) 1)` sibling references bind both ways. Pre-pass
//     collects defines ANYWHERE in the sequence (not only R7RS §5.3.2's leading run) —
//     over-binding relative to the spec, which UNDER-reports: safe for the error tier.
//
// Non-variables excluded (mirrors free-vars): keyword symbols (`:foo`), gensyms,
// quoted/vector datum. LIMIT (shared with free-vars): reader collection literals
// (`[…]`/`{…}`) evaluate elements in code position but walk as datum here — under-
// report, never a false positive.

import { APair } from "../values/primitives/APair.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import type { SourceLocation } from "../errors.js";
import type { SchemeValue } from "../values/types.js";

/** The macro-firewall ternary walk attribute (mirrors `DefineSyntaxSymbolDef["macroAttribute"]`). */
export type MacroWalkAttribute = "opaque" | "expression" | "binder";

/** One lexically-free symbol occurrence — the raw material of a `ReferenceNode`.
 *  `span` is the innermost enclosing located Pair's location (symbols themselves carry
 *  no `__location__`; only Pairs do — reader/Parser.ts) — `undefined` only for a form
 *  with no located enclosing Pair (a bare top-level symbol, or synthetic input). */
export interface ReferenceOccurrence {
  readonly name: string;
  readonly span: SourceLocation | undefined;
}

export interface CollectReferencesOptions {
  /** Names bound OUTSIDE the walked form that must not report — the program's own
   *  top-level VALUE definition names (the macro-aware first sweep's `define`
   *  arm; its macro names travel through `macroPolicyOf` instead, so their call-site
   *  interiors keep the firewall). */
  readonly initialBound?: ReadonlySet<string>;
  /** The macro-firewall ternary policy for a call head that is not lexically shadowed:
   *  `"expression"` walks arguments normally, `"opaque"`/`"binder"` firewall the
   *  interior, `undefined` means "not a macro" (ordinary application walk). */
  readonly macroPolicyOf?: (name: string) => MacroWalkAttribute | undefined;
}

const DEFINE_HEADS: ReadonlySet<string> = new Set(["define", "define-macro", "define-syntax"]);

/** Interned symbol's string name; null for a gensym (never a lexical variable). */
function nameOf(s: ASymbol): string | null {
  return typeof s.__name__ === "string" ? s.__name__ : null;
}

/** Keyword-shaped names (`:foo`) are self-typed accessors, not env lookups. */
const isKeywordName = (name: string): boolean => name.length > 1 && name.startsWith(":");

/** Elements of a (possibly improper) pair chain; the dotted tail appended last. */
function chainOf(n: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = n;
  while (cur instanceof APair) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  if (cur instanceof ASymbol) out.push(cur);
  return out;
}

/** Formal-parameter names of a lambda formals datum (proper/improper/bare-rest). */
function formalNames(formals: unknown): string[] {
  const out: string[] = [];
  if (formals instanceof ASymbol) {
    const n = nameOf(formals);
    if (n !== null) out.push(n);
    return out;
  }
  let cur: unknown = formals;
  while (cur instanceof APair) {
    if (cur.car instanceof ASymbol) {
      const n = nameOf(cur.car);
      if (n !== null) out.push(n);
    }
    cur = cur.cdr;
  }
  if (cur instanceof ASymbol) {
    const n = nameOf(cur);
    if (n !== null) out.push(n); // dotted rest formal
  }
  return out;
}

/** The name a top-level-shaped `define`/`define-macro`/`define-syntax` form binds —
 *  `(define (f . a) …)` / `(define f …)` / `(define-macro (m . a) …)` /
 *  `(define-syntax s …)` — with WHICH head bound it (the first sweep needs the
 *  kind split: `define` names are values, the other two are macros). Null for
 *  anything else. The same recognizer shape as define-bake.ts's private
 *  `defineHeadNameOf` (the local-copy convention — each file re-derives its tiny
 *  walker; that one reads reader duck-shapes, this one the real classes). */
export function definitionOf(form: unknown): { readonly name: string; readonly head: string } | null {
  if (!(form instanceof APair) || !(form.car instanceof ASymbol)) return null;
  const head = nameOf(form.car);
  if (head === null || !DEFINE_HEADS.has(head)) return null;
  if (!(form.cdr instanceof APair)) return null;
  const target = form.cdr.car;
  if (target instanceof APair && target.car instanceof ASymbol) {
    const n = nameOf(target.car);
    return n === null ? null : { name: n, head };
  }
  if (target instanceof ASymbol) {
    const n = nameOf(target);
    return n === null ? null : { name: n, head };
  }
  return null;
}

/**
 * Every lexically-free symbol occurrence of `form`, in first-encounter (program)
 * order, each with the innermost enclosing located Pair's span. Bound occurrences
 * against the LEXICAL scope only — resolution against the program vocabulary is the
 * graph builder's job (a free occurrence of a chain-bound name IS emitted here; it
 * resolves to a BindingNode/DoorNode there).
 */
export function collectReferences(form: SchemeValue, opts: CollectReferencesOptions = {}): ReferenceOccurrence[] {
  const out: ReferenceOccurrence[] = [];
  const seen = new Set<unknown>(); // cyclic-datum guard (mirrors free-vars)
  const initial = opts.initialBound ?? new Set<string>();
  const macroPolicyOf = opts.macroPolicyOf ?? ((): undefined => undefined);

  const emit = (name: string, span: SourceLocation | undefined): void => {
    out.push({ name, span });
  };

  /** Walk a BODY SEQUENCE with the internal-define letrec* pre-pass: the
   *  sequence's own definition names bind for EVERY form in it, both directions. */
  const walkBody = (body: unknown, bound: ReadonlySet<string>, span: SourceLocation | undefined): void => {
    const forms = chainOf(body);
    const names: string[] = [];
    for (const f of forms) {
      const def = definitionOf(f);
      if (def !== null) names.push(def.name);
    }
    const inner = names.length === 0 ? bound : new Set([...bound, ...names]);
    for (const f of forms) walk(f, inner, span);
  };

  const walk = (n: unknown, bound: ReadonlySet<string>, span: SourceLocation | undefined): void => {
    if (n instanceof ASymbol) {
      const name = nameOf(n);
      if (name === null || isKeywordName(name)) return;
      if (!bound.has(name) && !initial.has(name)) emit(name, span);
      return;
    }
    if (!(n instanceof APair)) return;
    if (seen.has(n)) return;
    seen.add(n);
    const loc = n.location ?? span;

    const head = n.car;
    if (head instanceof ASymbol) {
      const form_ = nameOf(head);
      // Special-form / macro dispatch only when the head is not locally shadowed.
      // `initialBound` deliberately does NOT suppress dispatch: a program-level
      // `(define lambda 5)` is out of the modeled grammar either way.
      if (form_ !== null && !bound.has(form_)) {
        switch (form_) {
          case "quote":
            return;
          case "quasiquote": {
            const arg = n.cdr instanceof APair ? n.cdr.car : undefined;
            walkQuasi(arg, 1, bound, loc);
            return;
          }
          case "lambda": {
            if (!(n.cdr instanceof APair)) return;
            const params = formalNames(n.cdr.car);
            walkBody(n.cdr.cdr, new Set([...bound, ...params]), loc);
            return;
          }
          case "let": {
            if (!(n.cdr instanceof APair)) return;
            // Named let: (let loop ((v init)…) body…) — loop + vars bound in body;
            // inits evaluate in the OUTER scope.
            if (n.cdr.car instanceof ASymbol) {
              const loopName = nameOf(n.cdr.car);
              const afterName = n.cdr.cdr;
              if (!(afterName instanceof APair)) return;
              const names: string[] = loopName === null ? [] : [loopName];
              for (const b of chainOf(afterName.car)) {
                if (b instanceof APair && b.car instanceof ASymbol) {
                  const bn = nameOf(b.car);
                  if (bn !== null) names.push(bn);
                  if (b.cdr instanceof APair) walk(b.cdr.car, bound, loc);
                }
              }
              walkBody(afterName.cdr, new Set([...bound, ...names]), loc);
              return;
            }
            const names: string[] = [];
            for (const b of chainOf(n.cdr.car)) {
              if (b instanceof APair && b.car instanceof ASymbol) {
                const bn = nameOf(b.car);
                if (bn !== null) names.push(bn);
                if (b.cdr instanceof APair) walk(b.cdr.car, bound, loc); // parallel: inits see outer
              }
            }
            walkBody(n.cdr.cdr, new Set([...bound, ...names]), loc);
            return;
          }
          case "let*": {
            if (!(n.cdr instanceof APair)) return;
            let cur: ReadonlySet<string> = bound;
            for (const b of chainOf(n.cdr.car)) {
              if (b instanceof APair && b.car instanceof ASymbol) {
                if (b.cdr instanceof APair) walk(b.cdr.car, cur, loc); // sequential: init sees priors
                const bn = nameOf(b.car);
                if (bn !== null) cur = new Set([...cur, bn]);
              }
            }
            walkBody(n.cdr.cdr, cur, loc);
            return;
          }
          case "letrec":
          case "letrec*": {
            if (!(n.cdr instanceof APair)) return;
            const names: string[] = [];
            const inits: unknown[] = [];
            for (const b of chainOf(n.cdr.car)) {
              if (b instanceof APair && b.car instanceof ASymbol) {
                const bn = nameOf(b.car);
                if (bn !== null) names.push(bn);
                if (b.cdr instanceof APair) inits.push(b.cdr.car);
              }
            }
            const all = new Set([...bound, ...names]); // recursive: all names bind everywhere
            for (const init of inits) walk(init, all, loc);
            walkBody(n.cdr.cdr, all, loc);
            return;
          }
          case "do": {
            // (do ((var init step…)…) (test result…) body…) — inits outer; vars
            // bound for steps/test/results/body.
            if (!(n.cdr instanceof APair)) return;
            const names: string[] = [];
            const laters: unknown[] = [];
            for (const b of chainOf(n.cdr.car)) {
              if (b instanceof APair && b.car instanceof ASymbol) {
                const bn = nameOf(b.car);
                if (bn !== null) names.push(bn);
                const rest = chainOf(b.cdr);
                if (rest.length > 0) walk(rest[0], bound, loc); // init: outer scope
                for (const step of rest.slice(1)) laters.push(step);
              }
            }
            const inner = new Set([...bound, ...names]);
            for (const step of laters) walk(step, inner, loc);
            walkBody(n.cdr.cdr, inner, loc); // (test result…) clause + body commands
            return;
          }
          case "define": {
            if (!(n.cdr instanceof APair)) return;
            const target = n.cdr.car;
            if (target instanceof APair) {
              // (define (f . formals) body…)
              const fnName = target.car instanceof ASymbol ? nameOf(target.car) : null;
              const params = formalNames(target.cdr);
              const inner = new Set([
                ...bound,
                // eslint-disable-next-line unicorn/no-negated-condition -- include the define name only when it is a symbol
                ...(fnName !== null ? [fnName] : []),
                ...params,
              ]);
              walkBody(n.cdr.cdr, inner, loc);
              return;
            }
            if (target instanceof ASymbol) {
              const dn = nameOf(target);
              const inner = dn === null ? bound : new Set([...bound, dn]);
              walkBody(n.cdr.cdr, inner, loc);
              return;
            }
            break; // malformed — fall through to application walk
          }
          case "define-macro":
          case "define-syntax":
            // A macro body's "free variables" name the EXPANSION env —
            // categorically outside this pass. The bound NAME is collected by the
            // first sweep / body pre-pass; the interior contributes nothing.
            return;
          case "try": {
            // (try body (catch (var) handler…) [(finally expr…)]) — evalTry's exact
            // shape (evaluator.ts): ONE body form, then clauses. `catch`/`finally`
            // markers are structural literals; the catch VARIABLE binds for its
            // handlers. Unrecognized clauses are ignored by the evaluator — skipped
            // here too (walking them would claim crash sites the runtime never runs).
            if (!(n.cdr instanceof APair)) return;
            walk(n.cdr.car, bound, loc);
            for (const clause of chainOf(n.cdr.cdr)) {
              if (!(clause instanceof APair) || !(clause.car instanceof ASymbol)) continue;
              const marker = nameOf(clause.car);
              if (marker === "catch") {
                const rest = clause.cdr;
                if (!(rest instanceof APair)) continue;
                const varSpec = rest.car; // (var)
                const varName = varSpec instanceof APair && varSpec.car instanceof ASymbol ? nameOf(varSpec.car) : null;
                const inner = varName === null ? bound : new Set([...bound, varName]);
                walkBody(rest.cdr, inner, loc);
              } else if (marker === "finally") {
                walkBody(clause.cdr, bound, loc);
              }
            }
            return;
          }
          case "cond": {
            for (const clause of chainOf(n.cdr)) {
              if (!(clause instanceof APair)) continue;
              const test = clause.car;
              if (!(test instanceof ASymbol && nameOf(test) === "else")) walk(test, bound, loc);
              for (const bodyForm of chainOf(clause.cdr)) {
                if (bodyForm instanceof ASymbol && nameOf(bodyForm) === "=>") continue;
                walk(bodyForm, bound, loc);
              }
            }
            return;
          }
          case "case": {
            const parts = chainOf(n.cdr);
            if (parts.length > 0) walk(parts[0], bound, loc);
            for (const clause of parts.slice(1)) {
              if (!(clause instanceof APair)) continue;
              // clause.car is a datum list (or `else`) — data, skipped.
              walkBody(clause.cdr, bound, loc);
            }
            return;
          }
          case "begin":
          case "if":
          case "when":
          case "unless":
          case "and":
          case "or":
          case "while":
          case "set!": {
            // Non-binding special forms: the head is evaluator syntax, never a
            // variable — walk operands only. `begin` bodies get the internal-define
            // pre-pass (R7RS splicing).
            if (form_ === "begin") {
              walkBody(n.cdr, bound, loc);
              return;
            }
            for (const el of chainOf(n.cdr)) walk(el, bound, loc);
            return;
          }
          default: {
            // The macro firewall. The head ITSELF is still a reference (a
            // doored macro name must reach the graph), emitted through the ordinary
            // symbol walk below when unbound-at-this-scope... except it IS by
            // construction resolvable (the policy came from the vocabulary), so
            // emit it explicitly and dispatch the interior by attribute.
            const policy = macroPolicyOf(form_);
            if (policy !== undefined) {
              if (!initial.has(form_)) emit(form_, loc);
              if (policy === "expression") {
                for (const el of chainOf(n.cdr)) walk(el, bound, loc);
              }
              // "opaque" | "binder": interior contributes NOTHING (under-report,
              // never lie) — binder walks need per-macro binding metadata a
              // one-of-three enum cannot carry.
              return;
            }
            break; // unknown head → application walk below
          }
        }
      }
    }
    // Application (or unmodeled form): every element is expression space — head
    // included (an op name IS a variable reference).
    for (const el of chainOf(n)) walk(el, bound, loc);
  };

  /** Quasiquote space: symbols are data except under `unquote`/`unquote-splicing`
   *  at depth 1; nested quasiquote increments depth (R7RS nesting). */
  const walkQuasi = (n: unknown, depth: number, bound: ReadonlySet<string>, span: SourceLocation | undefined): void => {
    if (!(n instanceof APair)) return;
    if (seen.has(n)) return;
    seen.add(n);
    const loc = n.location ?? span;
    const head = n.car;
    if (head instanceof ASymbol) {
      const hn = nameOf(head);
      if (hn === "unquote" || hn === "unquote-splicing") {
        const arg = n.cdr instanceof APair ? n.cdr.car : undefined;
        if (depth === 1) walk(arg, bound, loc);
        else walkQuasi(arg, depth - 1, bound, loc);
        return;
      }
      if (hn === "quasiquote") {
        const arg = n.cdr instanceof APair ? n.cdr.car : undefined;
        walkQuasi(arg, depth + 1, bound, loc);
        return;
      }
    }
    for (const el of chainOf(n)) walkQuasi(el, depth, bound, loc);
  };

  walk(form, new Set<string>(), form instanceof APair ? form.location : undefined);
  return out;
}
