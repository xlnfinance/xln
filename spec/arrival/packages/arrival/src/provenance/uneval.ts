// provenance/uneval.ts — the WIRE-EMISSION half of uneval: a wire is a closed arrival
// lambda. The wireframe builder hands `unevalWire` a surface expression, the `let`-frames it
// sat under, and the designated subterms it CUT to nodes; `unevalWire` closes the residue into
// `(lambda (p…) body)` — pure data, serializable, content-addressable (hashed by the wireframe
// hasher), applied by γ.
//
// This is a wireframe-BUILD-time production dependency (`wireframe/builder.ts`'s `emitWire`
// calls `unevalWire` directly), not analysis of a finished trace — it belongs to the static
// plane alongside the rest of `wireframe/`. The retrospective sibling (`buildUneval`/
// `Uneval`/`UnevalContainer` — reverse-slices a FINISHED trace) lives in
// `@inhuman.tools/arrival-provenance`'s `analysis/uneval.ts`; the two share no code, helpers,
// or imports.

import { WireLocalityError } from "../errors.js";

import { writeFormWith } from "./slice.js";
import { scopeId } from "./scope-id.js";
import { freeVars } from "./wireframe/free-vars.js";
import type { EmittedWire, WireFrame, WireParam } from "./wireframe/types.js";

export interface WireEmission {
  /** The wire body's surface form (reader Pairs; spans intact). */
  readonly expr: unknown;
  /** Enclosing `let`-family frames, OUTERMOST first — re-wrapped verbatim around the
   *  body so binding structure (incl. parallel-`let` scoping) survives lambda-lifting.
   *  Verbatim wrapping is sound (purity: γ recomputes); minimal pruning is a later
   *  refinement — granularity is the accepted phrasing-sensitivity LIMIT. */
  readonly frames: readonly WireFrame[];
  /** Designated subterms CUT out of wire space: surface pair → wireframe node id.
   *  Each occurrence in `expr`/frames becomes a minted param wired to that node. */
  readonly cuts: ReadonlyMap<unknown, number>;
  /** PURE program-prelude define names (the prelude-membership partition) — referenced BY NAME. */
  readonly preludeNames: ReadonlySet<string>;
  /** Port-reaching define names — must NEVER survive into a wire body as a free
   *  value reference: name indirection would smuggle sources. */
  readonly materialNames: ReadonlySet<string>;
  /** Is this name resolvable in the hermetic BASE env (natives, macros, base packs)?
   *  Base references stay by-name — the hermetic assembler provides them. */
  readonly isBaseName: (name: string) => boolean;
}

/** Every interned symbol name occurring anywhere under `n` (descends everything,
 *  including quoted data — collision avoidance wants the COARSEST view). */
function allSymbolNames(n: unknown, into: Set<string>, seen: Set<unknown>): void {
  if (n === null || typeof n !== "object" || seen.has(n)) return;
  seen.add(n);
  const kind = (n as { kind?: string }).kind;
  if (kind === "symbol") {
    const name = (n as { __name__: string | symbol }).__name__;
    if (typeof name === "string") into.add(name);
    return;
  }
  if (kind === "pair") {
    allSymbolNames((n as { car: unknown }).car, into, seen);
    allSymbolNames((n as { cdr: unknown }).cdr, into, seen);
    return;
  }
  if (kind === "vector") for (const el of (n as { __vector__: unknown[] }).__vector__) allSymbolNames(el, into, seen);
}

/** Cut pairs occurring in the wire's body space (frames' RHSs then the body expr),
 *  in deterministic first-encounter order; never descends INTO a cut. */
function collectCuts(e: WireEmission): unknown[] {
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (e.cuts.has(n)) {
      found.push(n);
      return; // the cut's interior belongs to the node's own wires
    }
    const kind = (n as { kind?: string }).kind;
    if (kind === "pair") {
      walk((n as { car: unknown }).car);
      walk((n as { cdr: unknown }).cdr);
    } else if (kind === "vector") {
      for (const el of (n as { __vector__: unknown[] }).__vector__) walk(el);
    }
  };
  for (const frame of e.frames) for (const entry of frame.entries) walk(entry.rhs);
  walk(e.expr);
  return found;
}

/** FV of the FRAMED body — `freeVars` of the expr composed backwards through the
 *  frames per each frame kind's scoping rule (let: parallel; let*: sequential;
 *  letrec/letrec*: recursive). Cuts contribute nothing (they become params). */
function framedFreeVars(e: WireEmission): Set<string> {
  const opts = { cuts: e.cuts };
  let fv = freeVars(e.expr, opts);
  for (let i = e.frames.length - 1; i >= 0; i--) {
    const frame = e.frames[i];
    const names = new Set(frame.entries.map((en) => en.name));
    if (frame.kind === "let") {
      const next = new Set<string>([...fv].filter((n) => !names.has(n)));
      for (const en of frame.entries) for (const n of freeVars(en.rhs, opts)) next.add(n);
      fv = next;
    } else if (frame.kind === "let*") {
      for (let j = frame.entries.length - 1; j >= 0; j--) {
        fv.delete(frame.entries[j].name);
        for (const n of freeVars(frame.entries[j].rhs, opts)) fv.add(n);
      }
    } else {
      // letrec / letrec*: all names bind everywhere (inits included).
      for (const en of frame.entries) for (const n of freeVars(en.rhs, opts)) fv.add(n);
      fv = new Set<string>([...fv].filter((n) => !names.has(n)));
    }
  }
  return fv;
}

/**
 * Emit ONE closed wire lambda — THE wire-locality enforcement point: checked AT
 * EMISSION, never a post-hoc audit; a wire that would violate locality is
 * unrepresentable because this door refuses to mint it.
 *
 * - Free variables resolve, in teaching order: port-reaching define → the
 *   `WireLocalityError` door (it must be a `template-ref` NODE — as a first-class
 *   value it would smuggle its ports past γ's frozen-payload rule); pure prelude
 *   name → stays by-name (captures that resolve to prelude or native names are
 *   REFERENCES, never payloads); hermetic-base name → by-name; anything else →
 *   an ingress SLOT param (env-supplied at run/replay).
 * - Cut designated subterms become minted `inN` params (collision-checked against
 *   every symbol in body space), each carrying its node id in `paramRefs`.
 * - The body re-wraps its `let` frames verbatim, so the emitted lambda equals the
 *   original phrasing with ports excised — `parse`-able Pairs-with-spans, the
 *   tagless algebra under evaluation, never a JS closure.
 */
export function unevalWire(e: WireEmission): EmittedWire {
  const span = scopeId(e.expr);

  // 1 — ingress partition of the framed body's free variables.
  const slots: string[] = [];
  for (const name of framedFreeVars(e)) {
    if (e.materialNames.has(name)) {
      throw new WireLocalityError(
        name,
        span,
        `"${name}" is a port-reaching top-level define (wireframe material) — a wire may only ` +
          `reference it as a CALL (which cuts to a template-ref node), never capture it as a value; ` +
          `carrying it by name would let γ re-invoke its ports on replay`,
      );
    }
    if (e.preludeNames.has(name)) continue; // pure prelude — reference BY NAME
    if (e.isBaseName(name)) continue; // hermetic base (native/macro/pack) — by name
    slots.push(name); // program/template ingress — the run env binds it
  }

  // 2 — mint collision-free params for the cut node egresses.
  const cutPairs = collectCuts(e);
  const used = new Set<string>(slots);
  {
    const seen = new Set<unknown>();
    for (const frame of e.frames) for (const entry of frame.entries) allSymbolNames(entry.rhs, used, seen);
    allSymbolNames(e.expr, used, seen);
  }
  const cutNames = new Map<unknown, string>();
  const cutRefs: WireParam[] = [];
  let mint = 0;
  for (const pair of cutPairs) {
    let name = `in${mint++}`;
    while (used.has(name) || e.isBaseName(name) || e.preludeNames.has(name)) name = `in${mint++}`;
    used.add(name);
    cutNames.set(pair, name);
    const node = e.cuts.get(pair);
    if (node === undefined) throw new WireLocalityError(name, span, "internal: collected cut has no node id");
    cutRefs.push({ kind: "node", name, node });
  }

  // 3 — serialize: body with cut substitution, re-wrapped in its frames, closed.
  const sub = (n: unknown): string | undefined => cutNames.get(n);
  let body = writeFormWith(e.expr, sub);
  for (let i = e.frames.length - 1; i >= 0; i--) {
    const frame = e.frames[i];
    const binds = frame.entries.map((en) => `(${en.name} ${writeFormWith(en.rhs, sub)})`).join(" ");
    body = `(${frame.kind} (${binds}) ${body})`;
  }

  const paramRefs: WireParam[] = [...slots.map((name): WireParam => ({ kind: "slot", name })), ...cutRefs];
  const params: string[] = paramRefs.map((r) => r.name);
  return { source: `(lambda (${params.join(" ")}) ${body})`, params, paramRefs, span };
}
