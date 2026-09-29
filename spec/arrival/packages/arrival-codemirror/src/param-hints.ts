import { type Extension, RangeSetBuilder, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { paramHints, paramHintsSugarcoat, type ParamHint } from "@inhuman.tools/arrival-sugarcoat";

/**
 * Parameter inlay hints (view-only widgets, no doc range).
 * `param:foo` before args of local defines. Pure analysis (arrival-sugarcoat).
 * Per-lens: "scheme" or "sugarcoat". Never in buffer text.
 *
 * **Hanging labels.** A hint may pull left into free whitespace so the *value*
 * stays put when there's room:
 * - Line-leading indent (arg starts a line of pure indent): hang into the full
 *   indent run — values keep their column when the label fits.
 * - Mid-line gaps: hang into surplus spaces only (keep one separator space so
 *   the label never glues the previous token to the value).
 * - No free space: full push (previous behavior).
 *
 * Hang is `min(labelCh, freeCh)` applied as `margin-left: -Nch`. Net layout
 * width is the unhangable remainder; the glyph still draws leftward into the
 * free run. Approximation: 1ch per name letter + the `:` from CSS `::after`.
 */

/** Estimated width of the painted hint in `ch` (name + trailing `:`). */
export function estimateHintCh(name: string): number {
  return name.length + 1;
}

/**
 * How many `ch` of free whitespace left of `pos` a hint may hang into.
 * Mid-line: reserve one separator space. Line-leading indent: the whole run.
 */
export function hangableCh(doc: Text, pos: number): number {
  if (pos <= 0) return 0;
  const line = doc.lineAt(pos);
  let i = pos;
  while (i > line.from) {
    const ch = doc.sliceString(i - 1, i);
    if (ch !== " " && ch !== "\t") break;
    i--;
  }
  const free = pos - i;
  if (free === 0) return 0;
  const leading = i === line.from; // whole prefix of the line is whitespace
  return leading ? free : Math.max(0, free - 1);
}

/** Actual hang applied: never more than the free run or the label itself. */
export function hangCh(name: string, free: number): number {
  return Math.min(estimateHintCh(name), Math.max(0, free));
}

class HintWidget extends WidgetType {
  constructor(
    readonly name: string,
    /** How many `ch` to pull left into free space (0 = full push). */
    readonly hang: number,
  ) {
    super();
  }
  eq(other: HintWidget): boolean {
    return other.name === this.name && other.hang === this.hang;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-param-hint";
    el.textContent = this.name; // brackets + dimming + `:` are CSS
    el.setAttribute("aria-hidden", "true");
    if (this.hang > 0) el.style.marginLeft = `-${this.hang}ch`;
    return el;
  }
  ignoreEvent(): boolean {
    return true; // non-interactive
  }
}

function buildDecorations(view: EditorView, resolve: (src: string) => ParamHint[]): DecorationSet {
  let hints: ParamHint[] = [];
  try {
    hints = resolve(view.state.doc.toString());
  } catch {
    // A malformed / unsupported buffer yields no hints — never break the editor.
  }
  const doc = view.state.doc;
  const builder = new RangeSetBuilder<Decoration>();
  // RangeSetBuilder wants ascending `from`; the resolver emits in walk order.
  for (const h of hints.toSorted((a, b) => a.pos - b.pos)) {
    const hang = hangCh(h.name, hangableCh(doc, h.pos));
    builder.add(h.pos, h.pos, Decoration.widget({ widget: new HintWidget(h.name, hang), side: -1 }));
  }
  return builder.finish();
}

const hintTheme = EditorView.theme({
  ".cm-param-hint": {
    opacity: "0.4",
    fontVariant: "all-petite-caps",
    fontSize: "1em",
    padding: "0",
    userSelect: "none",
    pointerEvents: "none",
    // Right gap before the value; left hang is per-widget via marginLeft style.
    margin: "0 0.5ch 0 0",
    display: "inline-block",
    // Hang draws left of the insertion point; don't clip the overhang.
    overflow: "visible",
    whiteSpace: "nowrap",
  },
  ".cm-param-hint::before": { content: '""' },
  ".cm-param-hint::after": { content: '":"' },
});

/** The CodeMirror extension: a ViewPlugin that recomputes the hint widgets when the
 *  document changes, plus their styling. `lens` selects the resolver — `"scheme"`
 *  reads the Scheme buffer, `"sugarcoat"` the sugarcoat buffer. */
export function paramHintsExtension(lens: "scheme" | "sugarcoat" = "scheme"): Extension {
  const resolve = lens === "sugarcoat" ? paramHintsSugarcoat : paramHints;
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = buildDecorations(view, resolve);
        }
        update(u: ViewUpdate): void {
          // Hang amount is doc-text-derived (`ch`), not geometry — only recompute on edits.
          if (u.docChanged) this.decorations = buildDecorations(u.view, resolve);
        }
      },
      { decorations: (v) => v.decorations },
    ),
    hintTheme,
  ];
}
