// structural — paredit ops over the REAL reader, headless.
//
// Commands are StateCommands, so the harness is `{state, dispatch}` — no DOM.
// Every op must (a) do the documented transformation on balanced text, and
// (b) DEGRADE TO NO-OP (return false / pass-through) on unbalanced text —
// the verify-reparse net's contract: corruption is structurally impossible.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { EditorSelection, EditorState, type StateCommand, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  barfForward,
  contractSelection,
  expandSelection,
  forceDeleteBackward,
  killSexp,
  schemeIndentAt,
  schemeStructural,
  slurpForward,
  spliceForm,
} from "../structural.js";

/** Build a state from a doc with `|` marking the cursor (or `«…»` a selection). */
function stateOf(marked: string): EditorState {
  const cursor = marked.indexOf("|");
  let doc = marked;
  let selection;
  if (cursor !== -1) {
    doc = marked.slice(0, cursor) + marked.slice(cursor + 1);
    selection = EditorSelection.cursor(cursor);
  }
  const from = marked.indexOf("«");
  const to = marked.indexOf("»");
  if (from !== -1 && to > from) {
    doc = marked.replaceAll("«", "").replaceAll("»", "");
    selection = EditorSelection.range(from, to - 1);
  }
  return EditorState.create({ doc, selection, extensions: [schemeStructural()] });
}

/** Run a StateCommand; return the resulting state (or null if it refused). */
function run(state: EditorState, cmd: StateCommand): EditorState | null {
  let next: EditorState | null = null;
  const ok = cmd({ state, dispatch: (tr: Transaction) => (next = tr.state) });
  return ok ? next : null;
}

describe("expand / contract — the selection ladder", () => {
  it("cursor → atom → call form → whole define, then back down", () => {
    const s0 = stateOf(`(define greeting (string-append "hi " na|me))`);
    const s1 = run(s0, expandSelection)!;
    expect(s1.sliceDoc(s1.selection.main.from, s1.selection.main.to)).toBe("name");
    const s2 = run(s1, expandSelection)!;
    expect(s2.sliceDoc(s2.selection.main.from, s2.selection.main.to)).toBe(`(string-append "hi " name)`);
    const s3 = run(s2, expandSelection)!;
    expect(s3.sliceDoc(s3.selection.main.from, s3.selection.main.to)).toBe(s3.doc.toString());
    // contract walks back down the same ladder
    const s4 = run(s3, contractSelection)!;
    expect(s4.sliceDoc(s4.selection.main.from, s4.selection.main.to)).toBe(`(string-append "hi " name)`);
    const s5 = run(s4, contractSelection)!;
    expect(s5.sliceDoc(s5.selection.main.from, s5.selection.main.to)).toBe("name");
  });

  it("expands through quote sugar: atom → list → sugar form including the '", () => {
    const s0 = stateOf(`(define xs '(1 2 th|ree))`);
    const s1 = run(s0, expandSelection)!; // atom
    const s2 = run(s1, expandSelection)!; // the inner (1 2 three)
    expect(s2.sliceDoc(s2.selection.main.from, s2.selection.main.to)).toBe(`(1 2 three)`);
    const s3 = run(s2, expandSelection)!; // the sugar wrapper INCLUDING the '
    expect(s3.sliceDoc(s3.selection.main.from, s3.selection.main.to)).toBe(`'(1 2 three)`);
  });

  it("no structure (unbalanced) → false, chord falls through", () => {
    expect(run(stateOf(`(define x| (car`), expandSelection)).toBeNull();
  });
});

describe("slurp / barf forward", () => {
  it("slurp pulls the next sibling in: (a |b) c → (a b c)", () => {
    const next = run(stateOf(`(foo b|ar) baz`), slurpForward)!;
    expect(next.doc.toString()).toBe(`(foo bar baz)`);
  });

  it("slurp climbs out when the inner form has no sibling", () => {
    const next = run(stateOf(`(outer (inner a|)) tail`), slurpForward)!;
    expect(next.doc.toString()).toBe(`(outer (inner a) tail)`);
  });

  it("slurp takes a quoted sibling as one unit (prefix included)", () => {
    const next = run(stateOf(`(foo b|ar) 'baz`), slurpForward)!;
    expect(next.doc.toString()).toBe(`(foo bar 'baz)`);
  });

  it("barf pushes the last element out: (a |b c) → (a b) c", () => {
    const next = run(stateOf(`(foo b|ar baz)`), barfForward)!;
    expect(next.doc.toString()).toBe(`(foo bar) baz`);
  });

  it("barf on a single-element form empties it", () => {
    const next = run(stateOf(`(|baz)`), barfForward)!;
    expect(next.doc.toString()).toBe(`()baz`);
  });

  it("nothing to slurp at any depth → false", () => {
    expect(run(stateOf(`(foo b|ar)`), slurpForward)).toBeNull();
  });
});

describe("splice / kill", () => {
  it("splice dissolves the enclosing form", () => {
    const next = run(stateOf(`(a (b c|) d)`), spliceForm)!;
    expect(next.doc.toString()).toBe(`(a b c d)`);
  });

  it("splice on quote sugar drops the prefix with the parens", () => {
    const next = run(stateOf(`(define xs '(1 |2))`), spliceForm)!;
    expect(next.doc.toString()).toBe(`(define xs 1 2)`);
  });

  it("kill inside an atom kills the atom (paredit kill-sexp)", () => {
    const next = run(stateOf(`(a (b |c) d)`), killSexp)!;
    expect(next.doc.toString()).toBe(`(a (b ) d)`);
  });

  it("kill on whitespace inside a form kills the next element", () => {
    const next = run(stateOf(`(a |(b c) d)`), killSexp)!;
    expect(next.doc.toString()).toBe(`(a  d)`);
  });

  it("kill takes a sugar wrapper with its payload (no dangling ')", () => {
    const next = run(stateOf(`(define xs '(1 |2))`), killSexp)!;
    expect(next.doc.toString()).toBe(`(define xs '(1 ))`);
    // and killing the next element when it's quoted takes the quote too
    const next2 = run(stateOf(`(f |'(a b) c)`), killSexp)!;
    expect(next2.doc.toString()).toBe(`(f  c)`);
  });

  it("kill between top-level forms kills FORWARD", () => {
    const next = run(stateOf(`(a b) |(c d)`), killSexp)!;
    expect(next.doc.toString()).toBe(`(a b) `);
  });
});

const del = (state: EditorState, from: number, to: number, dir = "delete.backward"): EditorState =>
  state.update({ changes: { from, to }, userEvent: dir }).state;

describe("strict delete protection", () => {
  it("blocks deleting a paren that would unbalance; caret steps over", () => {
    const doc = `(foo bar)`;
    const s = EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [schemeStructural()],
    });
    const next = del(s, doc.length - 1, doc.length); // backspace on the `)`
    expect(next.doc.toString()).toBe(doc); // unchanged
    expect(next.selection.main.head).toBe(doc.length - 1); // stepped over
  });

  it("allows deleting a whole balanced selection", () => {
    const doc = `(foo) (bar)`;
    const s = EditorState.create({ doc, extensions: [schemeStructural()] });
    expect(del(s, 0, 5, "delete.selection").doc.toString()).toBe(` (bar)`);
  });

  it("allows plain character deletes", () => {
    const doc = `(foo bar)`;
    const s = EditorState.create({ doc, extensions: [schemeStructural()] });
    expect(del(s, 5, 8).doc.toString()).toBe(`(foo )`);
  });

  it("SELF-SUSPENDS on an already-unbalanced buffer (paste repair stays possible)", () => {
    const doc = `(foo (bar`;
    const s = EditorState.create({ doc, extensions: [schemeStructural()] });
    expect(del(s, 5, 6).doc.toString()).toBe(`(foo bar`); // the `(` deleted freely
  });

  it("force-delete bypasses protection", () => {
    const doc = `(foo bar)`;
    const s = EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [schemeStructural()],
    });
    const next = run(s, forceDeleteBackward)!;
    expect(next.doc.toString()).toBe(`(foo bar`);
  });

  it("non-delete input is untouched (typing a paren works)", () => {
    const s = EditorState.create({ doc: ``, extensions: [schemeStructural()] });
    const next = s.update({ changes: { from: 0, insert: "(" }, userEvent: "input.type" }).state;
    expect(next.doc.toString()).toBe(`(`);
  });
});

describe("structural auto-indent", () => {
  it("indents to opener column + 2, top level to 0", () => {
    expect(schemeIndentAt(`(define (f x)\n`)).toBe(2);
    expect(schemeIndentAt(`(let ((n 5))\n  (when n\n`)).toBe(4);
    expect(schemeIndentAt(`(a b)\n`)).toBe(0);
  });

  it("ignores parens inside strings and comments", () => {
    expect(schemeIndentAt(`(f "((((" ; (((\n`)).toBe(2);
  });

  it("defers inside a multi-line string", () => {
    expect(schemeIndentAt(`(f "open\n`)).toBeNull();
  });
});
