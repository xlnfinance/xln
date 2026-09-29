// structural — paredit ops for Scheme (expand/contract, slurp/barf,
// splice, kill-sexp, strict delete, depth indent).
//
// TRUE structure comes from `parseSexprs` (spans on every node), not the
// StreamLanguage. Every edit goes through VERIFY-REPARSE: if it wouldn't parse,
// op is a no-op. Corruption is structurally impossible.
//
// Protection self-suspends on unbalanced buffers (you can always hand-repair);
// resumes when balanced. Scheme lens only — sugarcoat indentation is semantic.
//
// v1 set = community core (Calva/Cursive/etc). No wrap command (closeBrackets).

import { indentService } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type ChangeSpec,
  type Extension,
  type StateCommand,
  type TransactionSpec,
} from "@codemirror/state";
import { keymap, type KeyBinding } from "@codemirror/view";
import { parseSexprs, type Node } from "@inhuman.tools/arrival-sugarcoat";

// ── structure kernel ────────────────────────────────────────────────────────

/** Parse the doc into the sexp forest, memoized per doc (CM `Text` is
 *  immutable — a WeakMap key). `null` = no usable structure: unbalanced
 *  mid-edit text, or syntax outside the reader's vocabulary (`#\…` char
 *  literals / `#|…|#` block comments would MIS-parse rather than throw, so
 *  their mere presence disables structure — conservative by design). */
const forestCache = new WeakMap<object, Node[] | null>();
function forestOf(state: EditorState): Node[] | null {
  const key = state.doc as unknown as object;
  const hit = forestCache.get(key);
  if (hit !== undefined || forestCache.has(key)) return hit ?? null;
  const src = state.doc.toString();
  let forest: Node[] | null;
  if (/#[\\|]/.test(src)) {
    forest = null;
  } else {
    try {
      forest = parseSexprs(src);
    } catch {
      forest = null;
    }
  }
  forestCache.set(key, forest);
  return forest;
}

/** Innermost-last chain of nodes whose span contains `[from, to]`. Nodes
 *  without spans (the synthesized head of a `'x` sugar form) can't be located
 *  and end a descent. */
function pathAt(forest: readonly Node[], from: number, to: number): Node[] {
  const path: Node[] = [];
  let nodes: readonly Node[] = forest;
  for (;;) {
    const hit = nodes.find((n) => n.span !== undefined && n.span[0] <= from && to <= n.span[1]);
    if (hit === undefined) return path;
    path.push(hit);
    if (!("list" in hit)) return path;
    nodes = hit.list;
  }
}

/** The verify-reparse net: would the doc still parse after `changes`? */
function appliedParses(state: EditorState, changes: ChangeSpec): boolean {
  const next = state.changes(changes).apply(state.doc).toString();
  if (/#[\\|]/.test(next)) return false;
  try {
    parseSexprs(next);
    return true;
  } catch {
    return false;
  }
}

// ── structural selection: expand / contract ─────────────────────────────────

const pushExpand = StateEffect.define<{ from: number; to: number }>();
const popExpand = StateEffect.define<null>();

/** The contract stack: each expand pushes the PREVIOUS selection; contract
 *  pops. Any doc change or unrelated selection move invalidates the ladder. */
const expandStack = StateField.define<readonly { from: number; to: number }[]>({
  create: () => [],
  update(stack, tr) {
    if (tr.docChanged) return [];
    const ours = tr.effects.some((e) => e.is(pushExpand) || e.is(popExpand));
    if (tr.selection !== undefined && !ours) return [];
    let next = stack;
    for (const e of tr.effects) {
      if (e.is(pushExpand)) next = [...next, e.value];
      else if (e.is(popExpand)) next = next.slice(0, -1);
    }
    return next;
  },
});

/** Grow the selection to the smallest strictly-containing form. */
export const expandSelection: StateCommand = ({ state, dispatch }) => {
  const forest = forestOf(state);
  if (forest === null) return false;
  const sel = state.selection.main;
  const path = pathAt(forest, sel.from, sel.to);
  for (let i = path.length - 1; i >= 0; i--) {
    const span = path[i]!.span!;
    if (span[0] < sel.from || sel.to < span[1]) {
      dispatch(
        state.update({
          selection: EditorSelection.range(span[0], span[1]),
          effects: pushExpand.of({ from: sel.from, to: sel.to }),
          userEvent: "select.structural",
        }),
      );
      return true;
    }
  }
  return false;
};

/** Shrink the selection back down the expansion ladder. */
export const contractSelection: StateCommand = ({ state, dispatch }) => {
  const stack = state.field(expandStack, false);
  const top = stack?.at(-1);
  if (top === undefined) return false;
  dispatch(
    state.update({
      selection: EditorSelection.range(top.from, top.to),
      effects: popExpand.of(null),
      userEvent: "select.structural",
    }),
  );
  return true;
};

// ── tree ops → text edits ───────────────────────────────────────────────────

/** Locate, deepest-first, a LIST in the path plus its sibling array. */
function listsInPath(forest: readonly Node[], path: readonly Node[]): { node: Node; siblings: readonly Node[] }[] {
  const out: { node: Node; siblings: readonly Node[] }[] = [];
  for (let i = path.length - 1; i >= 0; i--) {
    const n = path[i]!;
    if (!("list" in n) || n.span === undefined) continue;
    const parent = path[i - 1];
    out.push({ node: n, siblings: parent !== undefined && "list" in parent ? parent.list : forest });
  }
  return out;
}

// `'x` is a sugar wrapper (spanless head atom). Removing the inner without
// the wrapper strands the `' and fails the reparse net. Ops must include it.
const SUGAR_HEADS = new Set(["quote", "quasiquote", "unquote", "unquote-splicing"]);
function isSugarWrapperOf(parent: Node | undefined, child: Node): boolean {
  if (parent === undefined || !("list" in parent) || parent.span === undefined) return false;
  const head = parent.list[0];
  return (
    parent.list.length === 2 &&
    parent.list[1] === child &&
    head !== undefined &&
    "atom" in head &&
    head.span === undefined &&
    SUGAR_HEADS.has(head.atom)
  );
}

/** The node's span widened to include a wrapping sugar form, if any. */
function spanWithSugar(path: readonly Node[], index: number): readonly [number, number] {
  const node = path[index]!;
  const parent = path[index - 1];
  return isSugarWrapperOf(parent, node) ? parent!.span! : node.span!;
}

function dispatchChanges(
  state: EditorState,
  dispatch: (tr: ReturnType<EditorState["update"]>) => void,
  changes: ChangeSpec,
  userEvent: string,
): boolean {
  if (!appliedParses(state, changes)) return false;
  dispatch(state.update({ changes, userEvent }));
  return true;
}

/** Pull the next sibling INTO the innermost form that has one: `(a |b) c` → `(a b c)`. */
export const slurpForward: StateCommand = ({ state, dispatch }) => {
  const forest = forestOf(state);
  if (forest === null) return false;
  const pos = state.selection.main.head;
  for (const { node, siblings } of listsInPath(forest, pathAt(forest, pos, pos))) {
    const idx = siblings.indexOf(node);
    const next = siblings[idx + 1];
    if (next?.span === undefined) continue; // nothing to slurp at this depth — try outer
    const span = node.span!;
    const closeCh = state.doc.sliceString(span[1] - 1, span[1]);
    return dispatchChanges(
      state,
      dispatch,
      [
        { from: span[1] - 1, to: span[1] },
        { from: next.span[1], insert: closeCh },
      ],
      "input.structural.slurp",
    );
  }
  return false;
};

/** Push the innermost form's LAST element out: `(a |b c)` → `(a b) c`. */
export const barfForward: StateCommand = ({ state, dispatch }) => {
  const forest = forestOf(state);
  if (forest === null) return false;
  const pos = state.selection.main.head;
  for (const { node } of listsInPath(forest, pathAt(forest, pos, pos))) {
    const kids = ("list" in node ? node.list : []).filter((k) => k.span !== undefined);
    const last = kids.at(-1);
    if (last === undefined) continue; // empty form — try outer
    const span = node.span!;
    const prev = kids.at(-2);
    // With one element the close lands right after the OPEN delimiter (which
    // may sit behind quote-sugar prefix chars — scan for it).
    const openPos = state.doc.sliceString(span[0], last.span![0]).search(/[([]/) + span[0];
    const insertAt = prev === undefined ? openPos + 1 : prev.span![1];
    const closeCh = state.doc.sliceString(span[1] - 1, span[1]);
    return dispatchChanges(
      state,
      dispatch,
      [
        { from: span[1] - 1, to: span[1] },
        { from: insertAt, insert: closeCh },
      ],
      "input.structural.barf",
    );
  }
  return false;
};

/** Dissolve the innermost enclosing form: `(a |b c)` → `a b c`. A quote-sugar
 *  wrapper (`'(…)`) dissolves WITH its parens — never a stranded `'`. */
export const spliceForm: StateCommand = ({ state, dispatch }) => {
  const forest = forestOf(state);
  if (forest === null) return false;
  const pos = state.selection.main.head;
  const path = pathAt(forest, pos, pos);
  for (let i = path.length - 1; i >= 0; i--) {
    const n = path[i]!;
    if (!("list" in n) || n.span === undefined) continue;
    const [from, to] = spanWithSugar(path, i);
    const openPos = state.doc.sliceString(from, to).search(/[([]/) + from;
    return dispatchChanges(
      state,
      dispatch,
      [
        { from, to: openPos + 1 },
        { from: to - 1, to },
      ],
      "delete.structural.splice",
    );
  }
  return false;
};

/** Delete the form under (or next after) the cursor — paredit's kill-sexp:
 *  inside an atom it kills the atom; on whitespace inside a form it kills the
 *  next element; between top-level forms it kills forward. Sugar wrappers go
 *  with their payload. */
export const killSexp: StateCommand = ({ state, dispatch }) => {
  const forest = forestOf(state);
  if (forest === null) return false;
  const pos = state.selection.main.head;
  const path = pathAt(forest, pos, pos);
  let span: readonly [number, number] | undefined;
  const inner = path.at(-1);
  if (inner !== undefined && (inner.span![0] === pos || !("list" in inner))) {
    // Right AT a form's start, or inside an atom: kill that whole form/atom
    // (`pathAt` treats a cursor touching the open delimiter as inside).
    span = spanWithSugar(path, path.length - 1);
  } else if (inner === undefined) {
    // Between top-level forms: kill FORWARD to the next one.
    span = forest.find((n) => n.span !== undefined && n.span[0] >= pos)?.span;
  } else {
    // On whitespace inside a form: kill the next CHILD after the cursor.
    span = ("list" in inner ? inner.list : []).find((k) => k.span !== undefined && k.span[0] >= pos)?.span;
  }
  if (span === undefined) return false;
  const [from, to] = span;
  if (!appliedParses(state, { from, to })) return false;
  dispatch(
    state.update({
      changes: { from, to },
      selection: EditorSelection.cursor(from),
      userEvent: "delete.structural.kill",
    }),
  );
  return true;
};

/** The strict-mode escape hatch: delete one char (or the selection) backward,
 *  bypassing protection — tagged `delete.force`. */
export const forceDeleteBackward: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (sel.empty && sel.from === 0) return false;
  const from = sel.empty ? sel.from - 1 : sel.from;
  dispatch(state.update({ changes: { from, to: sel.to }, userEvent: "delete.force" }));
  return true;
};

// ── strict delete protection ────────────────────────────────────────────────

/** Block a user deletion that would unbalance a currently-BALANCED buffer; the
 *  caret steps over the delimiter instead (paredit behavior). Self-suspends
 *  whenever the buffer already fails to parse — you can always repair by hand,
 *  and pasted-unbalanced text stays editable until it balances again. */
const strictDeleteFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent("delete") || tr.isUserEvent("delete.force")) return tr;
  if (forestOf(tr.startState) === null) return tr; // suspended on an unparseable buffer
  let touchesStructure = false;
  let firstFrom = -1;
  tr.changes.iterChanges((fromA, toA) => {
    if (firstFrom < 0) firstFrom = fromA;
    if (/[()[\]"]/.test(tr.startState.doc.sliceString(fromA, toA))) touchesStructure = true;
  });
  if (!touchesStructure) return tr;
  try {
    parseSexprs(tr.newDoc.toString());
    return tr; // still balanced (e.g. an empty pair, or a whole form) — allowed
  } catch {
    // Step over instead of deleting: backward → caret left of the delimiter,
    // forward → caret right of it. No doc change, no undo noise.
    const backward = tr.isUserEvent("delete.backward");
    return {
      selection: EditorSelection.cursor(backward ? firstFrom : firstFrom + 1),
      userEvent: "select",
    } satisfies TransactionSpec;
  }
});

// ── structural auto-indent ──────────────────────────────────────────────────

/** Indent for a line = column of the innermost unclosed opener + 2; top level
 *  = 0. Pure paren-depth over a string/comment-aware scan — no tree needed.
 *  Exported for tests. Returns null (defer to defaults) when the prefix uses
 *  syntax outside the scanner's vocabulary. */
export function schemeIndentAt(prefix: string): number | null {
  if (/#[\\|]/.test(prefix)) return null;
  const stack: number[] = [];
  let col = 0;
  let inStr = false;
  let esc = false;
  let inLine = false;
  for (const ch of prefix) {
    if (ch === "\n") {
      col = 0;
      inLine = false;
      continue;
    }
    const at = col;
    col += 1;
    if (inLine) continue;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    switch (ch) {
      case '"': {
        inStr = true;
        break;
      }
      case ";": {
        inLine = true;
        break;
      }
      case "(":
      case "[": {
        stack.push(at);
        break;
      }
      case ")":
      case "]":
        {
          stack.pop();
          // No default
        }
        break;
    }
  }
  if (inStr) return null; // inside a multi-line string: don't touch it
  const top = stack.at(-1);
  return top === undefined ? 0 : top + 2;
}

const schemeIndent = indentService.of((context, pos) => schemeIndentAt(context.state.doc.sliceString(0, pos)));

// ── keymap + bundle ─────────────────────────────────────────────────────────

/** A failed TRANSFORMATION chord must do NOTHING — falling through to the
 *  default binding would be a destructive surprise (Mod-Shift-K's default is
 *  deleteLine!). Selection chords DO fall through (Alt-↑ degrades to move-line
 *  when there's no structure) — navigation has no destructive defaults. */
const swallow =
  (cmd: StateCommand): StateCommand =>
  (target) => {
    cmd(target);
    return true;
  };

/** The palette: 5 new chords, browser-safe, zero Ctrl+Alt+char (AltGr-safe). */
export const schemeStructuralKeymap: readonly KeyBinding[] = [
  { key: "Alt-ArrowUp", run: expandSelection, preventDefault: true },
  { key: "Alt-ArrowDown", run: contractSelection, preventDefault: true },
  { key: "Mod-Shift-k", run: swallow(slurpForward), preventDefault: true },
  { key: "Mod-Shift-j", run: swallow(barfForward), preventDefault: true },
  { key: "Alt-s", run: swallow(spliceForm), preventDefault: true },
  { key: "Mod-Shift-Backspace", run: swallow(killSexp), preventDefault: true },
  // Escape hatch: mac Alt-Backspace is delete-word muscle memory — use Ctrl there.
  { key: "Alt-Backspace", mac: "Ctrl-Backspace", run: forceDeleteBackward, preventDefault: true },
];

export interface SchemeStructuralOptions {
  /** Mount the keymap (default true). */
  keys?: boolean;
  /** Strict delete protection (default true). */
  strictDelete?: boolean;
  /** Structural auto-indent (default true). */
  indent?: boolean;
}

/** Structural editing for the Scheme lens: selection ladder, slurp/
 *  barf, splice, kill-sexp, strict delete protection, depth-based indent. */
export function schemeStructural(options?: SchemeStructuralOptions): Extension {
  const ext: Extension[] = [expandStack];
  if (options?.keys !== false) ext.push(Prec.high(keymap.of([...schemeStructuralKeymap])));
  if (options?.strictDelete !== false) ext.push(strictDeleteFilter);
  if (options?.indent !== false) ext.push(schemeIndent);
  return ext;
}
