/**
 * THE PROGRAM PRELUDE LAYER, membership half. Partitions a program's top-level
 * `(define …)` forms into PURE (prelude-eligible — the body transitively reaches NO
 * port) vs WIREFRAME-MATERIAL (a port-reaching define — its ports are designated
 * wireframe nodes; its call sites reference its template subgraph).
 *
 * THE CHECK (per define): run the declaration-driven classifier (`provenance/lineage.ts`'s
 * `classify`) over the define's body directly. classify()'s bare-symbol arm already
 * treats any unbound name as a `leaf` (`subst.get(slot) ?? {kind:"leaf", slot}` over the
 * empty top-level substitution) — so a function's formal params need no special
 * leaf-binding here; calling `classify(body, classifier)` on the raw parsed body is
 * already exactly `classifyFanTemplate`'s per-element leaf substitution, for free.
 *
 * "Reaches a port" reads the THREE graph-layer crossing kinds (`source`/`sink`/
 * `transparent`) anywhere in the classified tree, a `fan` whose mapped function itself
 * mints (`introduces`), or an `opaque` black box — conservative: an unauditable node
 * MAY reach a port. Transitive port-reachability through first-class HOFs is exactly
 * the case this conservative rejection protects (it falls to wireframe material rather
 * than risk a false PURE). `reachesPort` is an EXHAUSTIVE structural walk (not a
 * demand-pruned cone), mirroring `countOpaqueNodes`'s traversal shape.
 *
 * TRANSITIVITY — the gap classify() cannot see through: an application `(helper x)`
 * where `helper` is a plain top-level Scheme define (no declared `.provenanceRole`)
 * classifies via the default arm as an ordinary pipe/merge over its ARGUMENTS —
 * `classify()` has no notion of "what helper's own body does" (it classifies ONE
 * expression, structurally, never expanding a call site into its callee). So a caller
 * of a port-reaching helper looks pure to `classify()` alone. This module closes that
 * gap with its OWN fixpoint over the top-level CALL GRAPH, reusing `slice.ts`'s
 * `referencedSymbols` (the same coarse, over-approximating reference
 * closure the reverse-chain slicer already uses — ANY reference to a name, called or
 * merely passed as a first-class value, counts as an edge, which is the conservative
 * treatment the first-class-HOF risk calls for): a define referencing a port-reaching
 * define is ITSELF port-reaching, to a fixpoint.
 */
import type { SchemeValue } from "../values/types.js";
import { assertNever, classify, type Classifier, type LineageNode } from "./lineage.js";
import { defineNameOf, referencedSymbols, writeForm } from "./slice.js";
import { PreludeMembershipError } from "../errors.js";

// Kind-discriminated duck typing over the reader's Pair/Symbol — mirrors slice.ts's
// private `isPair`/`isSymbol`/`symName` (same package, same convention; not exported
// there, so a tiny local copy — every provenance/ file that walks raw forms writes its
// own, see extract-defines.ts). The concrete APair/ASymbol instances still flow into
// `classify()` unchanged; this file's own traversal never needs their static types.
type DuckPair = { car: unknown; cdr: unknown };
type DuckSymbol = { __name__: string | symbol };
const kindOf = (v: unknown): string | undefined =>
  v !== null && typeof v === "object" ? (v as { kind?: string }).kind : undefined;
const isPair = (v: unknown): v is DuckPair => kindOf(v) === "pair";
const isSymbol = (v: unknown): v is DuckSymbol => kindOf(v) === "symbol";
const symName = (s: DuckSymbol): string =>
  typeof s.__name__ === "string" ? s.__name__ : (s.__name__.description ?? String(s.__name__));

/** The LAST element of a Pair chain — matches `classifyBegin`'s (lineage.ts) own
 *  pass-through convention: only the final body expression carries the define's return
 *  value's lineage. */
function lastOf(chain: unknown): unknown {
  let last: unknown;
  let n = chain;
  while (isPair(n)) {
    last = n.car;
    n = n.cdr;
  }
  return last;
}

/** The classifiable BODY of a top-level `(define …)` form — the last function-body
 *  expression, or a constant's sole RHS. `undefined` for a malformed/bodyless define
 *  (`(define (f))`). Name extraction is `slice.ts`'s `defineNameOf` (reused, not
 *  duplicated); this only adds the body half `defineNameOf` doesn't carry. */
function defineBodyOf(form: unknown): unknown {
  if (!isPair(form) || !isSymbol(form.car) || symName(form.car) !== "define") return undefined;
  const cdr1 = form.cdr;
  if (!isPair(cdr1)) return undefined;
  const head = cdr1.car;
  const tail = cdr1.cdr;
  if (isPair(head) && isSymbol(head.car)) return lastOf(tail);
  if (isSymbol(head)) return isPair(tail) ? tail.car : undefined;
  return undefined;
}

/**
 * Does a classified body tree reach a PORT anywhere? Exhaustive structural walk (every
 * arm `classify()` can produce is visited — mirrors `countOpaqueNodes`'s traversal
 * shape), not a demand-pruned cone: membership needs "anywhere in the tree", not "in
 * some binding's reachable set".
 */
export function reachesPort(n: LineageNode): boolean {
  switch (n.kind) {
    case "literal":
    case "leaf":
      return false;
    case "source":
    case "sink":
    case "transparent":
      return true; // the three graph-layer crossing kinds
    case "opaque":
      return true; // conservative: an unauditable black box MAY reach a port
    case "pipe":
    case "field":
      return reachesPort(n.child);
    case "merge":
    case "binder":
      return n.children.some(reachesPort);
    case "mux":
      return reachesPort(n.selector) || n.arms.some(reachesPort);
    case "fan":
      return n.introduces || reachesPort(n.source) || (n.template !== undefined && reachesPort(n.template));
    default:
      // Exhaustiveness guard, same contract as walk()/countOpaqueNodes: a new
      // LineageNode kind added without an arm here fails to compile, not silently
      // under-reports.
      return assertNever(n);
  }
}

export interface PreludeMembership {
  /** Top-level define names classified PURE — transitively reach no port. Prelude-eligible. */
  readonly pure: ReadonlySet<string>;
  /** Top-level define names classified WIREFRAME-MATERIAL — reach a port, directly or
   *  transitively through a reference to another wireframe-material define. */
  readonly wireframe: ReadonlySet<string>;
  /** A teaching reason for every WIREFRAME-MATERIAL name (errors-as-doors) — why it was
   *  rejected. Absent for `pure` names (nothing to explain). */
  readonly reasons: ReadonlyMap<string, string>;
}

/**
 * Partition a program's top-level defines into PURE vs WIREFRAME-MATERIAL. `classifier`
 * is the declaration-driven `Classifier` (`provenance/lineage-classifier-from-env.ts`'s
 * `classifierFromEnv(env)` in production; a synthetic `Classifier` in tests). Non-define
 * top-level forms are ignored (same scope as `extract-defines.ts` — this module
 * partitions DEFINES, not general forms).
 */
export function classifyProgramPrelude(forms: readonly SchemeValue[], classifier: Classifier): PreludeMembership {
  const refsOf = new Map<string, ReadonlySet<string>>();
  const bodyOf = new Map<string, unknown>();
  for (const form of forms) {
    const name = defineNameOf(form);
    if (name === null) continue;
    // A later redefinition of the same name overwrites the earlier entry — matches
    // ordinary top-level `define` rebinding semantics (the last one wins at runtime).
    bodyOf.set(name, defineBodyOf(form));
    refsOf.set(name, referencedSymbols(form));
  }
  const names = new Set(bodyOf.keys());

  const wireframe = new Set<string>();
  const reasons = new Map<string, string>();

  // Pass 0 — DIRECT port reach: classify() sees only THIS define's own body.
  for (const name of names) {
    const body = bodyOf.get(name);
    const tree: LineageNode = body === undefined ? { kind: "literal" } : classify(body as SchemeValue, classifier);
    if (reachesPort(tree)) {
      wireframe.add(name);
      reasons.set(
        name,
        `its own body crosses a port directly (a source/sink/transparent membrane crossing, ` +
          `or an opaque black box) — port-reaching defines are wireframe material, never prelude`,
      );
    }
  }

  // Pass 1..N — TRANSITIVE closure over the top-level call graph (fixpoint): a define
  // REFERENCING (called or merely passed as a value — `referencedSymbols`' coarse
  // over-approximation) a port-reaching define is itself port-reaching.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of names) {
      if (wireframe.has(name)) continue;
      for (const ref of refsOf.get(name) ?? []) {
        if (ref === name || !wireframe.has(ref)) continue;
        wireframe.add(name);
        reasons.set(
          name,
          `it references "${ref}", which is wireframe material (${reasons.get(ref)}) — a define ` +
            `referencing a port-reaching define is itself port-reaching (transitive closure)`,
        );
        changed = true;
        break;
      }
    }
  }

  const pure = new Set<string>();
  for (const name of names) if (!wireframe.has(name)) pure.add(name);
  return { pure, wireframe, reasons };
}

/**
 * errors-as-doors: assert `name` is prelude-eligible per `membership`, else throw
 * `PreludeMembershipError` naming exactly WHY (the port it reaches, direct or
 * transitive) — the REJECTED half of the membership gate (e.g. a fetch-wrapping
 * helper MUST be rejected). A no-op for a name `classifyProgramPrelude` never saw
 * (not a top-level define at all) — this door only guards MEMBERSHIP, not existence.
 */
export function assertPreludeEligible(name: string, membership: PreludeMembership): void {
  if (!membership.wireframe.has(name)) return;
  throw new PreludeMembershipError(name, membership.reasons.get(name) ?? "it reaches a port");
}

/**
 * Build the joined PRELUDE SOURCE — the re-parseable Scheme text of every top-level
 * define `membership` classified PURE, in program order (`writeForm`, `slice.ts` — the
 * same re-serializer the reverse-chain slicer emits its runnable slice with). This is
 * the `prelude` argument `hermetic-env.ts`'s `hermeticEnv` evaluates as a bootstrap;
 * a WIREFRAME-MATERIAL define is silently excluded (never carried into the prelude —
 * its ports are wireframe nodes, not prelude content).
 */
export function buildPreludeSource(forms: readonly SchemeValue[], membership: PreludeMembership): string {
  const kept: string[] = [];
  for (const form of forms) {
    const name = defineNameOf(form);
    if (name !== null && membership.pure.has(name)) kept.push(writeForm(form));
  }
  return kept.join("\n");
}
