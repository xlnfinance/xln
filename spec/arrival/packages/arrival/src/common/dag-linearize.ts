// dag-linearize.ts — pure C3 (Python MRO) linearization core. Both capability-shaped DAGs
// in this package share ONE algorithm:
//
//   • `common/kernel.ts`'s `createRuntimeAssembler` — the EnvPack DAG.
//   • `env/vocabulary.ts`'s `buildVocabulary` — the EnvCapability DAG.
//
// Structural, not domain-specific: operates on the abstract `{name, deps}` shape (`DagNode`)
// and never imports `EnvPack`/`EnvCapability`/any error class — a caller supplies its OWN
// "what does a name collision mean" / "how do I report a cycle" behavior via
// `DagLinearizeHooks`, so kernel.ts keeps throwing `AssembleConfigConflictError` /
// `AssembleCycleError` / `AssembleLinearizationError` and vocabulary.ts throws its own
// capability-domain errors, from the SAME walk.
//
// docs/environments.md §ASSEMBLY states the model (why C3, the dep-edge-is-grant law); this
// file is the shared enforcement mechanism both call sites' errors sit on top of.

/** The abstract DAG-node shape both `EnvPack` and `EnvCapability` satisfy structurally —
 *  nothing here imports either concrete type. */
export interface DagNode<N> {
  readonly name: string;
  readonly deps?: readonly N[];
}

export interface DagLinearizeHooks<N> {
  /** Called EVERY time a name is seen again during the closure walk (regardless of the
   *  node's current color) — `existing` is the FIRST node registered under this name,
   *  `candidate` the one just encountered. A caller checks whatever "same identity" means
   *  in its own domain (EnvPack: config equality; EnvCapability: object identity) and throws
   *  its OWN domain error when it disagrees. Omit to allow silent same-name dedup. */
  onRevisit?(existing: N, candidate: N): void;
  /** A cycle was detected in the dep graph — `path` is the cycle, from where it re-enters
   *  back to itself. Must throw (typed `never` so callers get the narrowing for free). */
  onCycle(path: readonly string[]): never;
  /** The C3 merge produced no "good head" for `owner` — an inconsistent precedence
   *  hierarchy (Python's own C3 would raise here too). Must throw. */
  onInconsistent(owner: string): never;
}

/** DFS the dep DAG from `roots`: collect nodes by name (3-color cycle detection), calling
 *  `hooks.onRevisit` on every repeat name and `hooks.onCycle` on a real cycle. */
export function closureWalk<N extends DagNode<N>>(
  roots: readonly N[],
  hooks: Pick<DagLinearizeHooks<N>, "onRevisit" | "onCycle">,
): Map<string, N> {
  const byName = new Map<string, N>();
  const GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (node: N): void => {
    const seen = byName.get(node.name);
    if (seen !== undefined) hooks.onRevisit?.(seen, node);
    if (color.get(node.name) === BLACK) return;
    if (color.get(node.name) === GRAY) {
      const from = stack.indexOf(node.name);
      hooks.onCycle([...stack.slice(from), node.name]);
    }
    color.set(node.name, GRAY);
    stack.push(node.name);
    byName.set(node.name, node);
    for (const dep of node.deps ?? []) visit(dep);
    stack.pop();
    color.set(node.name, BLACK);
  };

  for (const r of roots) visit(r);
  return byName;
}

/** A "good head" for C3 merge: the first list-head that appears in no list's TAIL (non-head
 *  position). Returns undefined when none exists (an inconsistent hierarchy). */
function findGoodHead(work: string[][]): string | undefined {
  for (const list of work) {
    const candidate = list[0];
    const inSomeTail = work.some((l) => l.slice(1).includes(candidate));
    if (!inSomeTail) return candidate;
  }
  return undefined;
}

function merge(lists: string[][], owner: string, onInconsistent: (owner: string) => never): string[] {
  const out: string[] = [];
  const work = lists.map((l) => [...l]).filter((l) => l.length > 0);
  while (work.length > 0) {
    const head = findGoodHead(work);
    if (head === undefined) onInconsistent(owner);
    out.push(head);
    for (let i = work.length - 1; i >= 0; i--) {
      if (work[i][0] === head) work[i].shift();
      if (work[i].length === 0) work.splice(i, 1);
    }
  }
  return out;
}

function dedupeStable(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names)
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  return out;
}

/** C3 linearization (Python MRO) over the deduped node graph. Returns names, highest
 *  precedence first. `merge` repeatedly takes a "good head" (a head appearing in no
 *  list's tail). */
export function c3Order<N extends DagNode<N>>(
  roots: readonly N[],
  byName: Map<string, N>,
  onInconsistent: (owner: string) => never,
): string[] {
  const memo = new Map<string, string[]>();

  const lin = (name: string): string[] => {
    const cached = memo.get(name);
    if (cached) return cached;
    const node = byName.get(name)!;
    // Dedupe dep NAMES: two same-name deps (or a node listing one dep twice) are one node
    // after identity-dedup, so the linearization lists must carry it once — else the
    // [deps] list holds a duplicate that has no valid C3 "good head" (it appears in its
    // own tail).
    const deps = [...new Set((node.deps ?? []).map((d) => d.name))];
    const lists: string[][] = [...deps.map((d) => lin(d)), [...deps]];
    const merged = merge(lists, name, onInconsistent);
    const result = [name, ...merged];
    memo.set(name, result);
    return result;
  };

  // A synthetic top depending on all roots gives the total order; drop the synthetic head.
  const rootNames = [...new Set(roots.map((r) => r.name))];
  const top = merge([...rootNames.map((n) => lin(n)), [...rootNames]], "<dag-root>", onInconsistent);
  return dedupeStable(top);
}

/** Shared core: closure + cycle-detect + dedup + C3 linearization. Returns the apply order
 *  (highest precedence first) and the deduped nodes by name. Both `common/kernel.ts` (EnvPack
 *  DAG) and `env/vocabulary.ts` (EnvCapability DAG) call this — see the module header. */
export function linearizeDag<N extends DagNode<N>>(
  roots: readonly N[],
  hooks: DagLinearizeHooks<N>,
): { order: string[]; byName: Map<string, N> } {
  const byName = closureWalk(roots, hooks);
  const order = c3Order(roots, byName, hooks.onInconsistent);
  return { order, byName };
}
