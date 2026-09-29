// sigma.ts — Layer Σ: bound-symbol masking.
//
// Layer S (scanner.ts) reports the STRUCTURAL parse state at the end of an accepted prefix. Σ
// refines the `atom` class into the SET OF BOUND IDENTIFIERS legal at the cursor — the contract's
// "validSymbols, position-filtered" (sift/src/sampler/oracle-contract.ts OracleState.validSymbols).
//
// Σ = boundSymbols() ∪ scope-locals, position-filtered:
//   - operator position ⇒ CALLABLES only (a non-callable head is a guaranteed apply-error);
//   - argument position ⇒ any bound symbol;
//   - top / quote ⇒ no constraint (null) — a top-level datum or quoted data may be any symbol.
//
// Two symbol sources, unioned:
//   1. boundSymbols() — the live discovery env, an OracleEnv over the real AmbientRuntime
//      (enumerates __env__ up the parent chain). Grant boundary: Σ enforces the sandbox's
//      binding set for free.
//   2. scope-locals — LEXICAL binders the prefix itself introduces: let/let*/letrec/letrec*
//      bindings, lambda parameters, define'd names. Pure function of the accepted prefix
//      (scope stack threaded alongside depth/position tracking); a binder is in scope for
//      its body region and absent outside it.
//
// GRACEFUL DEGRADATION: no env ⇒ boundSymbols() is empty and callable-vs-not is undecidable, so Σ
// returns null (Layer-S behaviour preserved — "Σ not modelled, do not constrain symbols"). Σ is
// live only when given an env. This null-degradation is the Σ voice of the one conservative-
// narrowing law (NEVER DROP A LEGAL SYMBOL) — docs/static-plane.md §CONSERVATIVE NARROWING.
//
// DESIGN INVARIANT (inherited from S): the scope stack is a pure function of the prefix — no
// lookahead, no backtracking.

import type { CursorPosition, FormKind, OracleEnv } from "./contract.js";

/** The internal env surface Σ consumes: {@link OracleEnv} plus a callable predicate (operator-position
 *  filtering needs to know which bound names are applicable). A callable need not have a known
 *  signature (that's T) — `isCallable` is the cheap structural "could this be a form head" check. */
export interface OracleEnvΣ extends OracleEnv {
  /** True iff the bound value of `id` is applicable (a function / macro / syntax). Drives the
   *  operator-position filter. Unknown names (not bound) ⇒ false. */
  isCallable(id: string): boolean;
}

/** Heads that bind a lambda-list (their first operand is a parameter list, in scope for the body). */
const LAMBDA_HEADS = new Set(["lambda", "named-lambda"]);
/** Reader-macro prefixes that quote the following datum (its symbols are data, not real binders). */
const QUOTE_PREFIXES = new Set(["'", "`"]);

/**
 * The role of a scope frame — drives WHICH atoms inside it bind, and how deep `locals` is visible.
 *   - "lambda-list"      a lambda's parameter list `(a b)`: EVERY atom is a parameter.
 *   - "define-sig"       a curried define's signature `(f a b)`: EVERY atom binds (f and its params).
 *   - "let-binding-list" the `((x 1) (y 2))` list of a let-family form: its CHILDREN are pairs.
 *   - "let-pair"         one `(x 1)` pair: the FIRST atom is the bound name.
 *   - "let-form"         a `let`/`let*`/`letrec`/`letrec*` application head frame.
 *   - "lambda-form"      a `lambda`/`named-lambda` application head frame.
 *   - "define-form"      a `define` application head frame.
 *   - "plain"            an ordinary application (no binding role).
 */
type FrameKind =
  | "lambda-list"
  | "define-sig"
  | "let-binding-list"
  | "let-pair"
  | "let-form"
  | "lambda-form"
  | "define-form"
  | "plain";

/** One lexical-scope frame on the Σ stack — one per open delimiter, so a `)` pops exactly one. */
interface ScopeFrame {
  /** Names this form brings into scope (parameters / let-bound names / define names). */
  locals: string[];
  /** This frame's binding role. */
  kind: FrameKind;
  /** The form's head symbol once known (elems ≥ 1), else null. */
  head: string | null;
  /** Completed-element count (0 ⇒ next atom is the head). */
  elems: number;
}

export interface ScopeState {
  inScope: ReadonlySet<string>;
}

/**
 * Walk the accepted prefix and compute the names lexically bound at its end. Pure, single pass,
 * string/comment/quote-aware (a binder keyword inside a string or a quoted datum is not a binder).
 *
 * Visibility rule per binder: a name joins its OWNING frame's `locals` the instant its atom
 * completes, staying in scope for the rest of the frame — a conservative, decoder-sound
 * over-approximation (Σ never drops a legal symbol). Closed sibling `define`s stay visible to
 * following forms at the same or shallower depth.
 */
export function scanScope(src: string): ScopeState {
  const stack: ScopeFrame[] = [];
  // `define`d names whose form has already CLOSED but stay visible to later siblings, keyed by the
  // stack-depth at which the define lived (a top-level define is visible to all later top forms).
  const closedDefines: { depth: number; name: string }[] = [];

  let inString = false;
  let inComment = false;
  let blockComment = 0;
  let esc = false;
  let midToken = false;
  let cur = "";

  const addLocal = (frame: ScopeFrame, name: string) => {
    if (name && !QUOTE_PREFIXES.has(name) && !frame.locals.includes(name)) frame.locals.push(name);
  };

  const finishToken = () => {
    if (!midToken) return;
    midToken = false;
    const top = stack.at(-1);
    if (top) {
      // A binding frame (lambda-list / define-sig / let-pair) has NO operator head — every relevant
      // atom binds, including the first. Only an APPLICATION-shaped frame's first atom is its head.
      const isBindingFrame = top.kind === "lambda-list" || top.kind === "define-sig" || top.kind === "let-pair";
      if (top.elems === 0 && !isBindingFrame) {
        top.head = cur;
        if (LAMBDA_HEADS.has(cur)) top.kind = "lambda-form";
        else if (cur === "let" || cur === "let*" || cur === "letrec" || cur === "letrec*") top.kind = "let-form";
        else if (cur === "define") top.kind = "define-form";
      } else {
        bindAtom(top, cur);
      }
      top.elems++;
    }
    cur = "";
  };

  /** The nearest enclosing FORM frame (let-form / lambda-form / define-form) on the stack — the one
   *  whose body the binder is visible in. Binders detected inside transient inner lists (a let-pair,
   *  a lambda-list, a define-sig) must attach HERE, not to the inner frame, because the inner frame
   *  pops the instant its list closes while the form frame stays open through the whole body. */
  const owningForm = (): ScopeFrame | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const k = stack[i]!.kind;
      if (k === "let-form" || k === "lambda-form" || k === "define-form") return stack[i];
    }
    return undefined;
  };

  const bindAtom = (frame: ScopeFrame, atom: string) => {
    switch (frame.kind) {
      case "lambda-list": {
        // Every atom of a lambda's parameter list is a parameter — bound in the lambda's body.
        const form = owningForm();
        if (form) addLocal(form, atom);
        break;
      }
      case "define-sig": {
        // `(define (f a b) …)` — f and every param bind in the define's body.
        const form = owningForm();
        if (form) addLocal(form, atom);
        break;
      }
      case "let-pair": {
        // `(x 1)` — only the FIRST atom (the name) binds, in the let-form's body.
        if (frame.elems === 0) {
          const form = owningForm();
          if (form) addLocal(form, atom);
        }
        break;
      }
      case "define-form":
        // `(define name …)` — the atom right after `define` is the bound name; remember it so
        // later siblings (after this form closes) still see it.
        if (frame.elems === 1) {
          addLocal(frame, atom);
          closedDefines.push({ depth: stack.length, name: atom });
        }
        break;
      default:
        break;
    }
  };

  const childRole = (parent: ScopeFrame | undefined): FrameKind => {
    if (!parent) return "plain";
    // `(lambda (a b) …)` — first operand list = the parameter list.
    if (parent.kind === "lambda-form" && parent.elems === 1) return "lambda-list";
    // `(define (f a b) …)` — first operand list = the curried signature.
    if (parent.kind === "define-form" && parent.elems === 1) return "define-sig";
    // `(let ((x 1) (y 2)) …)` — first operand list = the binding list.
    if (parent.kind === "let-form" && parent.elems === 1) return "let-binding-list";
    // each child of the binding list is one `(name val)` pair.
    if (parent.kind === "let-binding-list") return "let-pair";
    return "plain";
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;

    if (inString) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (blockComment > 0) {
      if (c === "#" && src[i + 1] === "|") {
        blockComment++;
        i++;
      } else if (c === "|" && src[i + 1] === "#") {
        blockComment--;
        i++;
      }
      continue;
    }
    if (inComment) {
      if (c === "\n") inComment = false;
      continue;
    }

    if (c === '"') {
      finishToken();
      inString = true;
      continue;
    }
    if (c === ";") {
      finishToken();
      inComment = true;
      continue;
    }
    if (c === "#" && src[i + 1] === "|") {
      finishToken();
      blockComment = 1;
      i++;
      continue;
    }

    if (c === "(" || c === "[" || c === "{") {
      finishToken();
      const parent = stack.at(-1);
      const kind = childRole(parent);
      stack.push({ locals: [], kind, head: null, elems: 0 });
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      finishToken();
      stack.pop();
      const parent = stack.at(-1);
      if (parent) parent.elems++;
      continue;
    }
    if (/\s/.test(c)) {
      finishToken();
      continue;
    }

    midToken = true;
    cur += c;
  }

  // Union every open frame's locals, plus closed same-/shallower-depth defines still visible.
  const inScope = new Set<string>();
  for (const frame of stack) for (const n of frame.locals) inScope.add(n);
  for (const { depth, name } of closedDefines) {
    if (depth <= stack.length + 1) inScope.add(name);
  }
  return { inScope };
}

/**
 * Compute Σ — the position-filtered set of valid symbols at the cursor — or null when Σ is not
 * modelled (no env, or a quote/top context where symbols are unconstrained).
 *
 * @param prefix    the accepted source prefix (left context).
 * @param position  the Layer-S cursor position (top / operator / argument).
 * @param formKind  the Layer-S enclosing-form kind (quote disables Σ).
 * @param env       the injected discovery env, or null for graceful degradation.
 */
export function computeValidSymbols(
  prefix: string,
  position: CursorPosition,
  formKind: FormKind,
  env: OracleEnvΣ | null,
): ReadonlySet<string> | null {
  // No env ⇒ Σ not modelled (Layer-S degradation): cannot enumerate the binding set nor decide
  // callability, so do not constrain symbols.
  if (!env) return null;
  // Quoted data carries no symbol constraint (`.` and arbitrary symbols are legal there).
  if (formKind === "quote") return null;
  // Top-level: a free-standing datum's head is unconstrained by the bound set per the contract.
  if (position === "top") return null;

  const scope = scanScope(prefix).inScope;
  const bound = env.boundSymbols();

  const out = new Set<string>();
  if (position === "operator") {
    // Operator slot ⇒ callables only. Env-bound names filtered by isCallable; lexical locals included
    // unconditionally (a local CAN be a lambda — Σ must never drop a legal symbol).
    for (const id of bound) if (env.isCallable(id)) out.add(id);
    for (const id of scope) out.add(id);
  } else {
    for (const id of bound) out.add(id);
    for (const id of scope) out.add(id);
  }
  return out;
}
