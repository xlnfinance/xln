// ghost — inline Σ∩T preview (Tab accepts one symbol at a time).
//
// Shows the best candidate as dim italic after cursor when insertion is
// provably safe (end-of-line or only closers/whitespace). Tab ladder:
// snippet > popup > ghost > default. Ghost hides while popup is open.
//
// pickGhost: fits > local > builtin; prefix-extend only. Empty prefix only at
// narrowed argument slots (never heads — that would be guessing).

import { acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

import type { SchemeIdeBackend, SchemeIdeRichCompletion } from "./ide.js";

// Same atom-character class as the completion source's SYMBOL_BEFORE. A single
// character class under `*` cannot backtrack — the slow-regex flag is a false
// positive on the `$` anchor (same verdict as ide.ts's SYMBOL_BEFORE).

const ATOM_TAIL = /[\w\-!$%&*+./<=>?@^~]*$/;

/** Insertion is safe iff nothing but whitespace and closers follows on the line
 *  (exported for tests). The cursor mid-expression must never grow a ghost —
 *  accepting it would splice a symbol into existing text. */
export function lineTailIsSafe(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return /^[\s)\]]*$/.test(state.doc.sliceString(pos, line.to));
}

/** Best prefix-extending candidate (exported for tests).
 *  Empty prefix: only fits + argument slot (same gate as unprompted popup).
 *  Score: fits(4) + local(1) + callable-op(2). Codepoint tiebreak. */
export function pickGhost(
  entries: readonly SchemeIdeRichCompletion[],
  prefix: string,
  position: "operator" | "argument" | "top",
): string | null {
  const pool = entries.filter((e) =>
    prefix === ""
      ? e.fits === true && position === "argument"
      : e.name.startsWith(prefix) && e.name !== prefix && e.fits !== false,
  );
  const score = (e: SchemeIdeRichCompletion): number =>
    (e.fits === true ? 4 : 0) +
    (e.kind === "method" ? 0 : 1) +
    (position === "operator" && e.callable === true ? 2 : 0);
  return (
    pool.reduce<SchemeIdeRichCompletion | null>(
      (best, e) => (!best || score(e) > score(best) || (score(e) === score(best) && e.name < best.name) ? e : best),
      null,
    )?.name ?? null
  );
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-scheme-ghost";
    el.textContent = this.text;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

interface GhostValue {
  /** Cursor position the ghost was computed for. */
  pos: number;
  /** The REMAINDER to insert (the symbol minus the typed prefix). */
  remainder: string;
}

const setGhost = StateEffect.define<GhostValue | null>();

const ghostField = StateField.define<GhostValue | null>({
  create: () => null,
  update(value, tr) {
    // Any document or selection movement invalidates the ghost — the plugin
    // recomputes for the new state (Escape sets null explicitly).
    let next = tr.docChanged || tr.selection !== undefined ? null : value;
    for (const e of tr.effects) if (e.is(setGhost)) next = e.value;
    return next;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (value) =>
      value === null
        ? Decoration.none
        : Decoration.set([Decoration.widget({ widget: new GhostWidget(value.remainder), side: 1 }).range(value.pos)]),
    ),
});

const ghostTheme = EditorView.baseTheme({
  ".cm-scheme-ghost": {
    opacity: "0.4",
    fontStyle: "italic",
    pointerEvents: "none",
  },
});

/** Accept ghost: insert remainder only (one symbol). */
const acceptGhost = (view: EditorView): boolean => {
  const ghost = view.state.field(ghostField, false);
  if (ghost === null || ghost === undefined) return false;
  if (view.state.selection.main.head !== ghost.pos) return false;
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.remainder },
    selection: { anchor: ghost.pos + ghost.remainder.length },
    effects: setGhost.of(null),
    userEvent: "input.complete.ghost",
  });
  return true;
};

const dismissGhost = (view: EditorView): boolean => {
  const ghost = view.state.field(ghostField, false);
  if (ghost === null || ghost === undefined) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
};

export interface SchemeGhostOptions {
  /** Debounce after the last edit before computing a ghost (ms). Default 250. */
  delay?: number;
}

/** The ghost extension: inline Σ∩T-best preview + the Tab ladder. */
export function schemeGhost(backend: SchemeIdeBackend, options?: SchemeGhostOptions): Extension {
  const rich = backend.getCompletionContext?.bind(backend);
  if (rich === undefined) return [];

  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private generation = 0;
      constructor(private readonly view: EditorView) {}
      update(u: ViewUpdate): void {
        if (u.docChanged || u.selectionSet) this.schedule();
      }
      destroy(): void {
        this.generation += 1;
        if (this.timer !== null) clearTimeout(this.timer);
      }
      private schedule(): void {
        const gen = ++this.generation;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.run(gen), options?.delay ?? 250);
      }
      private async run(gen: number): Promise<void> {
        const state = this.view.state;
        const sel = state.selection.main;
        // Only at a lone cursor, in safe tail position, with the popup closed.
        if (!sel.empty || !lineTailIsSafe(state, sel.head) || completionStatus(state) !== null) return;
        const head = sel.head;
        const prefix = ATOM_TAIL.exec(state.doc.sliceString(state.doc.lineAt(head).from, head))?.[0] ?? "";
        let ghostName: string | null = null;
        try {
          const context = await rich(state.doc.toString(), head);
          ghostName = pickGhost(context.entries, prefix, context.position);
        } catch {
          return; // mid-edit parse trouble — no ghost
        }
        if (gen !== this.generation || this.view.state.selection.main.head !== head) return; // stale
        if (ghostName === null) return;
        this.view.dispatch({
          effects: setGhost.of({ pos: head, remainder: ghostName.slice(prefix.length) }),
        });
      }
    },
  );

  return [
    ghostField,
    plugin,
    ghostTheme,
    Prec.high(
      keymap.of([
        {
          key: "Tab",
          run: (view) => {
            // Popup open → Tab accepts the popup's selection; else the ghost.
            if (completionStatus(view.state) === "active") return acceptCompletion(view);
            return acceptGhost(view);
          },
        },
        { key: "Escape", run: dismissGhost },
      ]),
    ),
  ];
}
