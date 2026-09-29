/**
 * The CLI's `ReplEvent` emitter — parse a buffer into top-level forms, run each in
 * sequence against the session's persistent `(runCtx, scope)` warm pair, and call
 * `onEvent` in the exact order the event-order law requires (mcp-substrate's
 * repl-event.ts header): topology FIRST, then statement events strictly ordered by
 * index, terminal-on-error.
 *
 * This mirrors arrival-mcp's `DiscoveryTool.runForms` at a deliberately smaller
 * altitude: no `RunCache`/session replay, no attachment extraction (D8: no inline
 * images), no statement cap — those are MCP-session concerns the local REPL
 * doesn't have. The ~15-line source-slicing pair (`sourceTextFor`/`nextLocatedOffset`)
 * deliberately DUPLICATES arrival-mcp's private copy in `DiscoveryTool.ts` rather than
 * reaching across that package's privacy — keep the two in step until the shared
 * emitter core (arrival-awesome-repl.md §6's lift into mcp-substrate) exists.
 */
import {
  execState,
  parse,
  toJS,
  type EnvCapability,
  type LexicalScope,
  type RunContext,
  type SchemeValue,
} from "@inhuman.tools/arrival";
import { StaticValidationError } from "@inhuman.tools/arrival/lsp-internals";
import { APair } from "@inhuman.tools/arrival/reflect-internals";
import { toSExprString } from "@inhuman.tools/arrival-serializer";
import type { ContentBlock } from "./repl-model/content-block.js";
import type { ReplEvent } from "./repl-model/repl-event.js";

import { formatDiagnostic } from "./session.js";

/** Output budget — same shape as session.ts's `printValue` (enough to see, never a
 *  flood; the serializer's shrink-to-fit machinery does the fair truncation). */
const PRINT_OPTS = { maxItems: 64, maxStringChars: 1024, maxTotalChars: 16_384 };

export interface FormEmitterOptions {
  readonly capabilities: readonly EnvCapability[];
  readonly config: Record<string, unknown>;
  readonly runCtx: RunContext;
  readonly scope: LexicalScope;
  readonly budgetMs: number;
  readonly onEvent: (event: ReplEvent) => void;
}

/** The next form (from `fromIndex` onward) that carries `[LOCATION]` metadata — a
 *  form's source slice must never cross into a later form's own located text. */
function nextLocatedOffset(forms: readonly SchemeValue[], fromIndex: number): number | undefined {
  for (let i = fromIndex; i < forms.length; i++) {
    const f = forms[i];
    if (f instanceof APair) {
      const loc = f.getLocation();
      if (loc !== undefined) return loc.offset;
    }
  }
  return undefined;
}

/** The exact original source for one parsed form — a location-anchored slice
 *  (preserving exact formatting) when the reader stamped one, else a re-rendered
 *  fallback (e.g. a macro-expanded form with no location). */
function sourceTextFor(form: SchemeValue, index: number, forms: readonly SchemeValue[], source: string): string {
  if (form instanceof APair) {
    const loc = form.getLocation();
    if (loc !== undefined) {
      const end = nextLocatedOffset(forms, index + 1) ?? source.length;
      return source.slice(loc.offset, end).trim();
    }
  }
  return toSExprString(form);
}

/** Errors as their teaching text (session.ts's `printError`, string-returning twin):
 *  a `StaticValidationError` fans out to its complete diagnostic list; everything else
 *  is its own message — doors already speak in cures, never a stack trace. */
function doorText(e: unknown): string {
  if (e instanceof StaticValidationError) return e.diagnostics.map(formatDiagnostic).join("\n");
  return e instanceof Error ? e.message : String(e);
}

/** Runs `source` to completion (or its first crash) against the session's `(runCtx, scope)`
 *  warm pair, calling `onEvent` in event-order-law order. Never throws — a parse crash
 *  or a form's runtime error both resolve as a terminal statement event, matching the
 *  aggregate law (the block model IS the result). */
export async function emitForms(source: string, opts: FormEmitterOptions): Promise<void> {
  const { capabilities, config, runCtx, scope, budgetMs, onEvent } = opts;
  const started = Date.now();
  const remaining = (): number => Math.max(0, budgetMs - (Date.now() - started));

  let forms: readonly SchemeValue[];
  try {
    forms = await parse(source);
  } catch (error) {
    const message = doorText(error);
    const door = `(error ${JSON.stringify(message)})`;
    // Parse-crash convention (repl-event.ts): empty topology + one synthetic terminal
    // statement at index 0 carrying the reader's door.
    onEvent({ kind: "topology", total: 0, forms: [] });
    onEvent({
      kind: "statement",
      index: 0,
      content: [{ type: "text", text: door }],
      counters: { elapsedMs: Date.now() - started, budgetMsRemaining: remaining() },
      error: message,
    });
    return;
  }

  const sources = forms.map((form, index) => sourceTextFor(form, index, forms, source));
  onEvent({ kind: "topology", total: forms.length, forms: sources.map((s, index) => ({ index, source: s })) });

  for (const [index, form] of forms.entries()) {
    const formStarted = Date.now();
    try {
      const state = await execState(form, { capabilities, config, runCtx, scope, budgetMs });
      const texts: string[] = [];
      for (const boxed of state.values) {
        const value = toJS(boxed);
        if (value === undefined) continue; // defines print nothing — REPL norm (session.ts's printValue)
        texts.push(toSExprString(value, PRINT_OPTS));
      }
      const content: ContentBlock[] = texts.map((text) => ({ type: "text", text }));
      onEvent({
        kind: "statement",
        index,
        content,
        counters: {
          elapsedMs: Date.now() - formStarted,
          budgetMsRemaining: remaining(),
        },
      });
    } catch (error) {
      const message = doorText(error);
      onEvent({
        kind: "statement",
        index,
        content: [{ type: "text", text: `(error ${JSON.stringify(message)})` }],
        counters: {
          elapsedMs: Date.now() - formStarted,
          budgetMsRemaining: remaining(),
        },
        error: message,
      });
      return; // terminal — no statement follows an errored one (event-order law)
    }
  }
}
