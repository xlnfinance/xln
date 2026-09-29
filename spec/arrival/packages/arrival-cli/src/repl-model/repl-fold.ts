/**
 * The headless REPL core (arrival-awesome-repl.md D6): a pure fold over the
 * `ReplEvent` stream (repl-event.ts) into a renderer-agnostic block model — no IO, no
 * ANSI, no DOM. `foldReplEvent(model, event)` is the ENTIRE reasoning; every renderer
 * (today: arrival-cli's ANSI painter; later: a browser DOM renderer, `arrival watch`'s
 * spectator view) is a pure `view(model)` over its output. Same shape bubbletea's Elm
 * architecture uses in the terminal — the fold is stolen, not the runtime (arrival-awesome-repl.md
 * §3/§6).
 *
 * STATE MACHINE (mirrors the tint design, arrival-awesome-repl.md §5): topology paints
 * every form as `pending` except form 0, which starts `running` (inferred, never a wire
 * member — the event stream never says "running", the fold derives it). Each statement
 * event fills its slot `done` (or `error`, terminal) and — iff no error — flips the NEXT
 * still-pending slot to `running`. A terminal error flips every other not-yet-settled
 * slot to `skipped`, a distinct tint from "queued but not reached yet". Settled blocks
 * (`done`/`error`/`skipped`) never repaint on a later event — scrollback is a provenance
 * record (§5's "previous inputs keep their final tint states forever").
 *
 * PARSE-CRASH CONVENTION (repl-event.ts header): an empty topology (`total: 0, forms: []`)
 * carries no slot for the synthetic terminal statement the parse-crash convention emits at
 * index 0 — the fold APPENDS a synthetic block for it rather than dropping the event, so a
 * reader crash still renders (one red block, no source slice, the door as its content).
 *
 * R8 VALIDATION (D5 — reserved, intentional): `ReplValidationEvent` is a no-op fold arm.
 * Nothing emits it yet (repl-event.ts's own note); when R8 lands it gets a real arm —
 * amber pre-flight tints — without touching this file's other cases.
 */

import type { ContentBlock } from "./content-block.js";
import type { ReplEvent, StatementCounters } from "./repl-event.js";

export type ReplBlockState = "pending" | "running" | "done" | "error" | "skipped";

/** One form's render-ready record — the tint design's "Block" (Warp-Blocks-shaped, §5). */
export interface ReplBlock {
  readonly index: number;
  /** The exact original source slice (topology's `forms[i].source`); `""` for a
   *  synthetic parse-crash block (the reader never reached a located span). */
  readonly source: string;
  readonly state: ReplBlockState;
  /** Empty until the statement event lands; then the FULL content-block list (§5's
   *  "content blocks render inline"). */
  readonly content: readonly ContentBlock[];
  readonly counters?: StatementCounters;
  /** The door text, present iff `state === "error"`. */
  readonly error?: string;
}

export interface ReplFoldModel {
  readonly blocks: readonly ReplBlock[];
}

export const EMPTY_REPL_MODEL: ReplFoldModel = { blocks: [] };

/** Topology → the pending skeleton (§5 t0): every slot dim/pending, except slot 0,
 *  which starts `running` — inferred, never asserted by the wire event. An EMPTY
 *  topology (`total: 0`) yields an empty skeleton; the parse-crash convention's
 *  synthetic statement event (below) supplies the one block that follows it. */
function foldTopology(event: Extract<ReplEvent, { kind: "topology" }>): ReplFoldModel {
  return {
    blocks: event.forms.map(
      (form, i): ReplBlock => ({
        index: form.index,
        source: form.source,
        state: i === 0 && event.total > 0 ? "running" : "pending",
        content: [],
      }),
    ),
  };
}

/** Statement → fills slot `event.index`, and — same fold step — infers the NEXT running
 *  slot (no error) or flips every other not-yet-settled slot to `skipped` (terminal
 *  error). Runs in ONE pass so "fill this slot" and "advance/abort the rest" can never
 *  observe an inconsistent intermediate model. */
function foldStatement(model: ReplFoldModel, event: Extract<ReplEvent, { kind: "statement" }>): ReplFoldModel {
  const settledState: ReplBlockState = event.error === undefined ? "done" : "error";
  const filled: ReplBlock = {
    index: event.index,
    source: model.blocks.find((b) => b.index === event.index)?.source ?? "",
    state: settledState,
    content: event.content,
    counters: event.counters,
    error: event.error,
  };
  const hadSlot = model.blocks.some((b) => b.index === event.index);
  const rest = model.blocks
    .filter((b) => b.index !== event.index)
    .map((b): ReplBlock => {
      if (event.error !== undefined) {
        // Terminal: every not-yet-settled slot (still pending, or the one that was
        // running) is now known to never run — a DISTINCT tint from "queued" (§5).
        return b.state === "pending" || b.state === "running" ? { ...b, state: "skipped" } : b;
      }
      // No error: the slot immediately after this one becomes the running slot —
      // ONLY if it's still pending (an out-of-order re-delivery must not un-skip
      // or un-finish an already-settled block).
      return b.index === event.index + 1 && b.state === "pending" ? { ...b, state: "running" } : b;
    });
  // Parse-crash convention: the synthetic index-0 statement has no topology slot to
  // fill — APPEND it rather than drop the event, so a reader crash still renders.
  const blocks = hadSlot ? [...rest, filled].toSorted((a, b) => a.index - b.index) : [...model.blocks, filled];
  return { blocks };
}

/** The fold: `(model, event) → model`. Pure, total, no IO — every renderer (terminal
 *  painter today; DOM/watch-mode renderers later) is a `view(model)` over this alone. */
export function foldReplEvent(model: ReplFoldModel, event: ReplEvent): ReplFoldModel {
  switch (event.kind) {
    case "topology":
      return foldTopology(event);
    case "validation":
      // D5: reserved, nothing emits this arm yet — no-op fold (header, "R8 VALIDATION").
      return model;
    case "statement":
      return foldStatement(model, event);
  }
}
