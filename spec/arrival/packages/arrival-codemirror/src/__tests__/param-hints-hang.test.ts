import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { estimateHintCh, hangableCh, hangCh } from "../param-hints.js";

/** Build a bare doc Text for hangableCh. */
const doc = (src: string) => EditorState.create({ doc: src }).doc;

describe("param-hint hanging", () => {
  it("estimateHintCh counts name + colon", () => {
    expect(estimateHintCh("name")).toBe(5);
    expect(estimateHintCh("a")).toBe(2);
    expect(estimateHintCh("")).toBe(1);
  });

  it("hangCh never exceeds free space or label width", () => {
    expect(hangCh("name", 10)).toBe(5); // full hang when free ≥ label
    expect(hangCh("name", 3)).toBe(3); // partial
    expect(hangCh("name", 0)).toBe(0);
    expect(hangCh("name", -1)).toBe(0);
  });

  it("mid-line single separator space: no hang (keep the separator)", () => {
    //               0123456789...
    const src = `(greet "world")`;
    // pos of `"` is 7; one space before it
    const pos = src.indexOf('"');
    expect(hangableCh(doc(src), pos)).toBe(0);
    expect(hangCh("name", hangableCh(doc(src), pos))).toBe(0);
  });

  it("mid-line surplus spaces: hang into the extra only", () => {
    // one reserved + two hangable
    const src = `(greet   "world")`;
    const pos = src.indexOf('"');
    expect(hangableCh(doc(src), pos)).toBe(2);
    expect(hangCh("name", hangableCh(doc(src), pos))).toBe(2);
  });

  it("line-leading indent: full run is hangable (no separator reserve)", () => {
    const src = `(greet\n    "world")`;
    const pos = src.indexOf('"');
    expect(hangableCh(doc(src), pos)).toBe(4);
    // label "name:" is 5ch → hang all 4 free, push the remaining 1
    expect(hangCh("name", hangableCh(doc(src), pos))).toBe(4);
  });

  it("line-leading indent that fits the label: full hang, zero push", () => {
    const src = `(greet\n      "world")`; // 6 spaces
    const pos = src.indexOf('"');
    expect(hangableCh(doc(src), pos)).toBe(6);
    expect(hangCh("name", hangableCh(doc(src), pos))).toBe(5); // full label
  });

  it("no free space: zero hang", () => {
    // unlikely but legal — arg flush against previous token
    const src = `(greet"world")`;
    const pos = src.indexOf('"');
    expect(hangableCh(doc(src), pos)).toBe(0);
  });

  it("tabs count as hangable free space like spaces", () => {
    const src = `(greet\n\t\t"world")`;
    const pos = src.indexOf('"');
    expect(hangableCh(doc(src), pos)).toBe(2);
  });
});
