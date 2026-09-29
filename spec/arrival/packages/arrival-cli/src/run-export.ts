/**
 * The run-introspection CONTRACT: the outline data as a stable, versioned JSON object.
 *
 * The outline (`--outline`) and drill-down (`--form`) are the human surfaces; this is the
 * MACHINE one — arrival's first audience is agents (the MCP/actor thesis), and an agent
 * that ran a program wants to know structurally what happened: which forms executed, how
 * many times each, what state, where in source. That is exactly `runView`, so the export
 * is a thin, documented envelope around it — no second projection to drift out of sync.
 *
 * `version` is the compatibility handle: a consumer (a `--diff` later, a web viewer, an
 * MCP tool) pins it. Kept deliberately at the outline altitude — forms + counts + states +
 * locations + the invocation total — not per-invocation detail, which stays a `--form`
 * query (a full-fidelity dump would reopen the pruning leak at fib scale, and no agent
 * wants 796 rows by default).
 */
import type { EvalTrace } from "@inhuman.tools/arrival/provenance";

import { runView, type TemplateNode } from "./run-view.js";

/** Bump when the shape changes incompatibly. Consumers pin this. */
export const RUN_EXPORT_VERSION = 1;

export interface RunExport {
  readonly version: number;
  /** Total dynamic invocations across the whole run — the "it did all that" number. */
  readonly invocations: number;
  /** Source-ordered forms with aggregated state + `×count` multiplicity. */
  readonly forms: readonly TemplateNode[];
}

/** Project a trace into the export envelope. Pure — a plain JSON-serializable object. */
export function exportRun(trace: EvalTrace): RunExport {
  return {
    version: RUN_EXPORT_VERSION,
    invocations: trace.invocationLog.length,
    forms: runView(trace),
  };
}
