/**
 * Structural scope identity off an AST Pair: `headOf` + `scopeId` (`head@line:col`
 * / `head@source:line:col`). Pure leaf so snapshot, forest, and workers share
 * identity without import cycles.
 */

export function headOf(node: unknown): string {
  const car = (node as { car?: { __name__?: unknown } } | null)?.car;
  const name = (car as { __name__?: unknown } | undefined)?.__name__;
  return typeof name === "string" ? name : "?";
}

/**
 * Stable scope id: `head@source:line:col` when located with a source file,
 * `head@line:col` when sourceless, `head` if unlocated. Parser stamps
 * `__location__` (symbol key) on located Pairs.
 *
 * WHY source is part of identity: line:col alone collides across files —
 * same position in different required modules or `.prompt`-generated lambdas
 * would merge distinct call sites in every scope-keyed consumer. Identity is
 * file+line+col; sourceless main-body forms keep the short shape.
 *
 * `__location__` is symbol-keyed: survives on the live Pair, stripped by
 * `structuredClone`. Cross-worker payloads must pre-derive `scope` while the
 * live Pair is in hand (`trace-snapshot`), not call `scopeId` on a clone.
 */
export function scopeId(node: unknown): string {
  const head = headOf(node);
  if (node && typeof node === "object") {
    for (const s of Object.getOwnPropertySymbols(node)) {
      if (s.description === "__location__") {
        const loc = (node as Record<symbol, unknown>)[s] as
          | { line?: number; col?: number; source?: string }
          | undefined;
        if (loc && typeof loc.line === "number") {
          const at = typeof loc.source === "string" && loc.source !== "" ? `${loc.source}:` : "";
          return `${head}@${at}${loc.line}:${loc.col ?? 0}`;
        }
      }
    }
  }
  return head;
}

/** Marker in `.prompt` generated-lambda source (`parse(…, \`dotprompt:${path}\`)`).
 *  A scope containing this was minted on the resolver's `(infer/run …)`, not the
 *  author's call site. */
export const DOTPROMPT_SOURCE_MARKER = "@dotprompt:";

/** Minimal parent-chain shape for `userCallSite` (keeps this leaf import-free). */
export interface ScopedParented {
  readonly scope: string;
  readonly parent: ScopedParented | null;
}

/**
 * Project a `.prompt` provenance point back to the author's call site: walk
 * parents to the nearest ancestor whose scope lacks `@dotprompt:`. Returns the
 * input when it isn't a dotprompt point, or when no such ancestor exists.
 */
export function userCallSite<T extends ScopedParented>(inv: T): T {
  if (!inv.scope.includes(DOTPROMPT_SOURCE_MARKER)) return inv;
  for (let p = inv.parent; p; p = p.parent) {
    if (!p.scope.includes(DOTPROMPT_SOURCE_MARKER)) return p as T;
  }
  return inv;
}
