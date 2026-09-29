/**
 * COPY-AS-CHUNK (constitution §4.5 — greenfield package, never shared imports).
 * Source: arrival/packages/mercury/src/scheme-scope.ts (verbatim logic; only
 * the import homes changed — sibling `./names.js` / `./nodes.js` copies. The
 * `@here.build/lexical-namer` import STAYS a real dependency: the constitution's
 * pipeline keeps the "scope/naming — lexical-namer adapter" [§3.1, keep], and
 * lexical-namer is a foundations library, not surviving-mercury material).
 *
 * Scope-aware identifier naming via `@here.build/lexical-namer` (the system Mercury's
 * var-namer uses; #76). `cleanName` is position-independent, so two bindings that clean
 * to the same JS name in overlapping scopes collide — the gepa-full bug where a named-let
 * loop var `picked` shadows the `picked?` predicate (both → `picked`, emitting the broken
 * `picked(ex, picked)`).
 *
 * This walks the parse forest into a `ScopeSpec` tree — top-level `define`s are root
 * entities; each `lambda` / `let` / `let*` / named-`let` / define-with-params body is a
 * child scope (so sibling scopes reuse names freely: `c` in three lambdas stays `c`) —
 * feeds each binding the `nameCandidates` ladder, and resolves. Returns `nameOf`: every
 * BOUND identifier occurrence (binding site + reference) → its assigned JS name. Free
 * refs / stdlib / globals are absent; the caller falls back to `cleanName`.
 *
 * Collision-free programs resolve every binding to tier-1 (`cleanName`), so output is
 * unchanged. When a named-let loop var `picked` shadows a top-level `picked?` predicate,
 * the predicate yields the contested bare name (it takes `isPicked`) so the data binding
 * keeps `picked` — see {@link ladder} for the content-aware bare-name ordering that makes
 * this work cross-scope despite parent-first resolution.
 */
import { type Candidate, resolveLexicalNames, type ScopedEntity, type ScopeSpec } from "@here.build/lexical-namer";

import { nameCandidates } from "./names.js";
import { type Atom, head, isAtom, isKeyword, isList, type ListNode, type Node } from "./nodes.js";

/**
 * `nameCandidates` ladder → priority-keyed candidates. A PREDICATE bids at a LOWER
 * base than a plain binding (90 vs 100), so a same-scope clash resolves by
 * non-overlapping PRECEDENCE — the plain binding wins the bare name and the predicate
 * falls to its `isFoo` rung — rather than a tie (which would `_postfix` both).
 *
 * The bare-name ordering is CONTENT-AWARE (`plainPrimaries` = the bare names every
 * PLAIN binding wants): a predicate whose bare name no plain binding wants keeps it on
 * top (`dominates?` → `dominates`). But when some plain binding wants that same name —
 * even in a DIFFERENT scope — the predicate yields it, putting `isFoo` on top so the
 * data binding keeps the clean name. This is what lets a top-level `picked?` resolve to
 * `isPicked` while a nested loop var `picked` keeps `picked`: parent-first ordering
 * would otherwise let the predicate grab the bare name before the descendant is reached.
 *   plain `picked`   → {100:"picked"}
 *   pred  `picked?`  (plain `picked` exists) → {90:"isPicked", 80:"picked"}
 *   pred  `dominates?` (no plain `dominates`) → {90:"dominates", 80:"isDominates"}
 */
function ladder(scheme: string, plainPrimaries: ReadonlySet<string>): Record<number, Candidate> {
  const rec: Record<number, Candidate> = {};
  const isPred = scheme.endsWith("?");
  const base = isPred ? 90 : 100;
  let cands = nameCandidates(scheme);
  if (isPred && cands.length > 1 && plainPrimaries.has(cands[0]!)) {
    cands = [cands[1]!, cands[0]!, ...cands.slice(2)]; // yield the contested bare name; isFoo on top
  }
  for (const [i, name] of cands.entries()) {
    rec[base - i * 10] = name;
  }
  return rec;
}

/** Heads that introduce a value/function binding the namer must see. `define/overridable`
 *  is `define`'s macro sibling (the `arrival/overridable` capability,
 *  `foundations/arrival/arrival/src/env/overridable.ts`) — it only expands to a real
 *  `define` at eval time, and this scanner never expands macros, so it has to recognize
 *  the head literally, same as `define` itself. */
const isDefineHead = (hn: string | undefined): boolean => hn === "define" || hn === "define/overridable";

/** The value/default expression of a define-shaped form: index 2 for `(define name
 *  value)`, index 3 for `(define/overridable name type default)` (the extra `type` arg
 *  shifts it over one). */
const defineValueOf = (form: ListNode): Node | undefined =>
  head(form) === "define/overridable" ? form.list[3] : form.list[2];

/**
 * Every binding site in the forest, flattened (define names + params, lambda params,
 * let / let* / named-let vars). Used to pre-compute `plainPrimaries` so {@link ladder} can
 * decide whether a predicate must yield its bare name. Mirrors the binding sites the
 * scope walk in {@link resolveNames} visits, but order-free and scope-free — we only
 * need the SET of names plain bindings want, not their scoping.
 */
function collectBindingAtoms(n: Node, out: Atom[]): void {
  if (!isList(n) || n.list.length === 0) return;
  const h = n.list[0];
  const hn = isAtom(h) && !h.str ? h.atom : undefined;
  if (isDefineHead(hn)) {
    const sig = n.list[1];
    if (isList(sig) && isAtom(sig.list[0])) {
      out.push(sig.list[0]); // fn name
      out.push(...bindingAtoms({ list: sig.list.slice(1) })); // params
    } else if (isAtom(sig)) {
      out.push(sig); // value name
    }
    for (const c of n.list.slice(2)) collectBindingAtoms(c, out);
    return;
  }
  if (hn === "lambda") {
    out.push(...bindingAtoms(n.list[1]));
    for (const c of n.list.slice(2)) collectBindingAtoms(c, out);
    return;
  }
  if (hn === "let" || hn === "let*") {
    const named = isAtom(n.list[1]);
    if (named) out.push(n.list[1] as Atom);
    const bindings = named ? n.list[2] : n.list[1];
    out.push(...bindingAtoms(bindings));
    if (isList(bindings))
      for (const b of bindings.list) if (isList(b) && b.list[1]) collectBindingAtoms(b.list[1], out);
    for (const c of n.list.slice(named ? 3 : 2)) collectBindingAtoms(c, out);
    return;
  }
  for (const c of n.list) collectBindingAtoms(c, out);
}

/** Binding atoms of a param list `(a b . rest)` or let-bindings `((x i) (y j))`. */
function bindingAtoms(node: Node | undefined): Atom[] {
  if (!isList(node)) return [];
  const out: Atom[] = [];
  for (let i = 0; i < node.list.length; i++) {
    const p = node.list[i]!;
    if (isAtom(p) && p.atom === ".") {
      const rest = node.list[i + 1];
      if (isAtom(rest)) out.push(rest);
      break;
    }
    if (isAtom(p))
      out.push(p); // param atom
    else if (isList(p) && isAtom(p.list[0])) out.push(p.list[0]); // (x init) → x
  }
  return out;
}

/** Resolve every bound identifier occurrence (binding + reference) to its JS name. */
export function resolveNames(forest: readonly Node[], reserved: readonly string[]): Map<Atom, string> {
  // Pre-pass: the bare name every PLAIN (non-`?`) binding wants. A predicate whose bare
  // name is in here yields it (see {@link ladder}) so the data binding keeps it.
  const plainPrimaries = new Set<string>();
  const allBindings: Atom[] = [];
  for (const form of forest) collectBindingAtoms(form, allBindings);
  for (const a of allBindings) if (!a.atom.endsWith("?")) plainPrimaries.add(nameCandidates(a.atom)[0]!);

  const postfix = new Map<Atom, string>();
  let counter = 0;
  const entity = (atom: Atom): ScopedEntity<Atom> => {
    postfix.set(atom, String(counter++));
    return { key: atom, candidates: ladder(atom.atom, plainPrimaries) };
  };

  const refToBinding = new Map<Atom, Atom>();
  const stack: Map<string, Atom>[] = [];
  const lookup = (name: string): Atom | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const hit = stack[i]!.get(name);
      if (hit) return hit;
    }
    return undefined;
  };

  /** The bound name of a `define`: `(define (f …) …)` → `f`, `(define x v)` → `x`. */
  const defineNameAtom = (form: ListNode): Atom | undefined => {
    const sig = form.list[1];
    if (isList(sig) && isAtom(sig.list[0])) return sig.list[0];
    if (isAtom(sig)) return sig;
    return undefined;
  };

  // Walk an expression, recording references and collecting nested binding scopes.
  function scanInto(n: Node, children: ScopeSpec<Atom>[]): void {
    if (isAtom(n)) {
      // a plain identifier ref (not a string, `:keyword`, or `<>` slot)
      if (!n.str && !(n.atom.length > 1 && n.atom.startsWith(":")) && n.atom !== "<>") {
        const b = lookup(n.atom);
        if (b) refToBinding.set(n, b);
      }
      return;
    }
    if (!isList(n) || n.list.length === 0) return;
    const h = n.list[0];
    if (isKeyword(h)) {
      if (n.list[1]) scanInto(n.list[1], children); // accessor (:field obj)
      return;
    }
    const hn = isAtom(h) && !h.str ? h.atom : undefined;
    if (hn === "lambda") return void children.push(lambdaScope(n));
    if (hn === "let" || hn === "let*") return void children.push(letScope(n));
    for (const c of n.list) scanInto(c, children); // call / special form — walk all parts
  }

  /**
   * A child scope: the frame bindings (params / let-vars / loop name) PLUS any internal
   * `define`s at the body head — Scheme allows local defines there, with letrec* semantics, so
   * every body define's NAME is pre-registered in the frame (forward + mutual refs resolve) and
   * a function-form define gets its own child scope. This is the same pre-register-then-process
   * the root scope does for top-level defines, applied at every body — without it, an internal
   * `(define (loop …) …)` is invisible to the namer (its refs fall back to `cleanName`).
   */
  function fnScope(frameAtoms: Atom[], bodyForms: Node[]): ScopeSpec<Atom> {
    const defNames = bodyForms
      .filter((f): f is ListNode => isList(f) && isDefineHead(head(f)))
      .map(defineNameAtom)
      .filter((a): a is Atom => a !== undefined);
    const entities = [...frameAtoms.map(entity), ...defNames.map(entity)];
    const children: ScopeSpec<Atom>[] = [];
    const frame = new Map<string, Atom>();
    for (const a of frameAtoms) frame.set(a.atom, a);
    for (const a of defNames) frame.set(a.atom, a);
    stack.push(frame);
    for (const f of bodyForms) {
      if (isList(f) && isDefineHead(head(f))) {
        const sig = f.list[1];
        if (isList(sig)) children.push(fnScope(bindingAtoms({ list: sig.list.slice(1) }), f.list.slice(2)));
        else {
          const value = defineValueOf(f);
          if (value) scanInto(value, children); // (define x val) / (define/overridable x type default) — value in this scope
        }
      } else {
        scanInto(f, children);
      }
    }
    stack.pop();
    return { entities, children };
  }

  function lambdaScope(n: ListNode): ScopeSpec<Atom> {
    return fnScope(bindingAtoms(n.list[1]), n.list.slice(2));
  }

  /** `(let ((x i)…) body)` / `let*` and named `(let loop ((x i)…) body)`. `let` inits are
   *  scanned in the PARENT (their child scopes over-reserve against the let vars — safe);
   *  `let*` inits are scanned sequentially — init `i` additionally sees bindings `0..i-1`
   *  of the SAME let* (R7RS let* semantics: each init is evaluated in a scope extended by
   *  all preceding bindings), so a ref to an earlier sibling (`(let* ((a 5) (b (+ a 1))) …)`)
   *  must resolve to that sibling's binding atom, not fall through to the enclosing scope
   *  (where it's either unbound or shadows a same-named outer binding). Mirrors the
   *  `extendForLet`/`let*` chain in `../extract/arm-atoms.ts` and `../wire/derive.ts`. The
   *  body is an ordinary scope (loop name + vars as the frame) either way, so internal
   *  defines work there too. */
  function letScope(n: ListNode): ScopeSpec<Atom> {
    const isStar = head(n) === "let*";
    const named = isAtom(n.list[1]);
    const loopAtom = named ? (n.list[1] as Atom) : undefined;
    const bindings = named ? n.list[2] : n.list[1];
    const bodyForms = n.list.slice(named ? 3 : 2);
    const vars = bindingAtoms(bindings);
    const initChildren: ScopeSpec<Atom>[] = [];
    if (isList(bindings)) {
      // let*: push a running frame of already-scanned bindings so each subsequent init's
      // refs resolve against them (same atom objects `vars`/`entity()` will bind later).
      const seenSoFar = new Map<string, Atom>();
      if (isStar) stack.push(seenSoFar);
      for (const b of bindings.list) {
        if (isList(b) && b.list[1]) scanInto(b.list[1], initChildren);
        if (isStar && isList(b) && isAtom(b.list[0])) seenSoFar.set(b.list[0].atom, b.list[0]);
      }
      if (isStar) stack.pop();
    }
    const inner = fnScope([...(loopAtom ? [loopAtom] : []), ...vars], bodyForms);
    return { entities: inner.entities, children: [...initChildren, ...(inner.children ?? [])] };
  }

  // ── root scope: top-level defines are entities; their bodies are child scopes ──
  const rootEntities: ScopedEntity<Atom>[] = [];
  const rootChildren: ScopeSpec<Atom>[] = [];
  const rootBindings = new Map<string, Atom>();
  // Pre-register all top-level names so forward references resolve.
  for (const form of forest) {
    if (isList(form) && isDefineHead(head(form))) {
      const a = defineNameAtom(form);
      if (a) rootBindings.set(a.atom, a);
    }
  }
  stack.push(rootBindings);
  for (const form of forest) {
    if (isList(form) && isDefineHead(head(form))) {
      const a = defineNameAtom(form);
      if (a) rootEntities.push(entity(a));
      const sig = form.list[1];
      if (isList(sig)) rootChildren.push(fnScope(bindingAtoms({ list: sig.list.slice(1) }), form.list.slice(2)));
      else {
        const value = defineValueOf(form);
        if (value) scanInto(value, rootChildren); // (define x val) / (define/overridable x type default)
      }
    } else {
      scanInto(form, rootChildren); // a top-level expression
    }
  }
  stack.pop();

  const root: ScopeSpec<Atom> = {
    id: "root",
    reservations: [...reserved],
    entities: rootEntities,
    children: rootChildren,
  };
  const { assignments } = resolveLexicalNames(root, {
    postfixFor: (atom) => postfix.get(atom) ?? "0",
    resolveTie: (name, p) => `${name}_${p}`, // JS idents: no hyphens
    onTie: "free",
  });

  // nameOf: binding atoms (direct) + reference atoms (via their binding).
  const nameOf = new Map<Atom, string>(assignments);
  for (const [ref, binding] of refToBinding) {
    const name = assignments.get(binding);
    if (name !== undefined) nameOf.set(ref, name);
  }
  return nameOf;
}
