/**
 * ReplEvent — the per-statement REPL event stream.
 *
 * SDK-free, beside {@link ContentBlock}: the union mirrors nothing from
 * `@modelcontextprotocol/sdk` — a transport adapter (arrival-mcp's sdk-adapter)
 * lowers these onto its own notification frames at its own boundary.
 *
 * The stream is WIREFRAME-THEN-RECORD (the same two-layer shape as the provenance
 * design, at REPL altitude): parse-first means every form and its exact source span
 * is known before anything executes, so ONE topology event — the future trace, an
 * n-slot skeleton with sources visible — is emitted before index 0 ever runs, and
 * statement events fill the slots as they land. Clients render pending slots
 * immediately; perceived latency collapses before any output exists.
 *
 * THE EVENT-ORDER LAW (pinned in arrival-mcp's law suite):
 *   topology FIRST (always, exactly once) → (validation, when the pre-flight is
 *   enabled) → statement events strictly ordered by `index` — and TERMINAL-ON-ERROR:
 *   a statement event carrying `error` is the LAST event of the call.
 *
 * THE AGGREGATE LAW: the final CallToolResult ≡ the ordered concatenation of the
 * statement events' FULL `ContentBlock` lists — text AND binary blocks. A client
 * that ignores notifications sees the complete result; streaming is additive
 * observation, never the only carrier.
 *
 * SAME-PRINCIPAL: every event echoes program source and results the SAME client
 * sent, on that call's OWN response stream — events are same-principal,
 * per-session; no new exposure surface exists here.
 *
 * PARSE-CRASH CONVENTION: a reader error has no forms, so the topology event is
 * EMPTY (`total: 0, forms: []`) and ONE synthetic terminal statement event at
 * `index: 0` carries the `(error …)` door — the aggregate law still holds
 * mechanically (that door is the call's whole output).
 */

import type { Diagnostic } from "@inhuman.tools/arrival/lsp-internals";

import type { ContentBlock } from "./content-block.js";

/**
 * Per-form execution counters, riding every statement event. At HEAD each
 * top-level form runs under its own fresh runCtx, so `elapsedMs` is that form's
 * wall-clock and `budgetMsRemaining` is what remained of THAT form's own
 * wall-clock budget at that point.
 */
export interface StatementCounters {
  elapsedMs: number;
  /** What remained of this form's wall-clock budget at the meter read (clamped ≥ 0). */
  budgetMsRemaining?: number;
}

/** The future trace — emitted FIRST, before index 0 ever runs. `forms` carries the
 *  exact LOCATION slices of the program's top-level forms (the reader's spans, so
 *  multi-form slices are exact), `total` their count. */
export type ReplTopologyEvent = {
  kind: "topology";
  /** `forms.length` — the statement-event count a fully-successful call will emit. */
  total: number;
  /** The skeleton: one slot per top-level form, exact original source per slice. */
  forms: readonly { index: number; source: string }[];
};

/** RESERVED: the static-validation pre-flight — the COMPLETE `Diagnostic[]` streams
 *  here after topology, before index 0; an error-tier list stops the call with zero
 *  side effects fired. The event-order law above already accounts for this arm;
 *  nothing emits it yet. */
export type ReplValidationEvent = {
  kind: "validation";
  diagnostics: readonly Diagnostic[];
};

/** One executed top-level form — fills the skeleton slot `index`. */
export type ReplStatementEvent = {
  kind: "statement";
  /** The topology slot this record fills. */
  index: number;
  /** The form's FULL output blocks — core text now; R6's extracted extras (per-extra
   *  label + binary blocks) APPEND here, and the aggregate law carries them along. */
  content: readonly ContentBlock[];
  counters: StatementCounters;
  /** REPL-crash text (the same text inside the `(error …)` door in `content`).
   *  TERMINAL: no event follows a statement event carrying this. */
  error?: string;
};

export type ReplEvent = ReplTopologyEvent | ReplValidationEvent | ReplStatementEvent;
