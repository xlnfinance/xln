// Middle-elision (docs/proposals — the serializer-elision plan): a too-long array rendered as
// "head ... +N more of TOTAL" at the tail reads to a model as a near-complete dump with a
// buried footnote (the grounding failure this fixes: a 100-item array shown ~93-deep with a
// tiny marker at the very end was read as complete, and the answer was in the hidden 7).
// Middle-elision instead shows a small head + small tail around a LOUD marker, plus records an
// `ElisionRecord` for the caller (mcp-substrate's trailing `;; Note:` block) — all OPT-IN via
// `elideHead`/`elideTail` (presence = on); a caller that never sets them keeps today's
// tail-truncation byte-for-byte (see truncation.test.ts / r0 pin — untouched by this feature).

import { parse } from "@inhuman.tools/arrival";
import { describe, expect, it } from "vitest";

import { toSExprString, toSExprStringWithElisions } from "../serializer.js";

describe("middle-elision is OPT-IN — OFF path unchanged", () => {
  it("no elideHead/elideTail → today's tail-truncation, byte-for-byte", () => {
    const out = toSExprString(
      Array.from({ length: 200 }, (_, i) => i),
      { maxItems: 10 },
    );
    expect(out).toContain("#| +190 more of 200 |#");
  });
});

describe("middle-elision ON — basic shape", () => {
  it("shows head + LOUD middle marker + tail, and records one ElisionRecord", () => {
    const { text, elisions, reduced } = toSExprStringWithElisions(
      Array.from({ length: 100 }, (_, i) => i),
      { maxItems: 20, elideHead: 5, elideTail: 5 },
    );
    expect(text).toContain("#| 90 numbers were not rendered; total array length is 100 |#");
    expect(text.startsWith("[0 1 2 3 4 ")).toBe(true);
    expect(text.trimEnd().endsWith("95 96 97 98 99]")).toBe(true);
    expect(elisions).toEqual([{ total: 100, notRendered: 90, shownShape: "numbers", hiddenShape: "numbers" }]);
    expect(reduced).toBe(true);
  });
});

describe("per-array limit selection", () => {
  it("top-level array root gets topLevelArrayLimit — 80 objects fits under 100, no elision", () => {
    const sameShape = Array.from({ length: 80 }, (_, i) => ({ id: i, name: `n${i}` }));
    const { text, elisions, reduced } = toSExprStringWithElisions(sameShape, {
      maxItems: 20,
      topLevelArrayLimit: 100,
      elideHead: 5,
      elideTail: 5,
    });
    expect(text).not.toContain("were not rendered");
    expect(elisions).toEqual([]);
    expect(reduced).toBe(false);
  });

  it("top-level array root over topLevelArrayLimit elides, descriptor 'similar items'", () => {
    const sameShape = Array.from({ length: 150 }, (_, i) => ({ id: i, name: `n${i}` }));
    const { text, elisions } = toSExprStringWithElisions(sameShape, {
      maxItems: 20,
      topLevelArrayLimit: 100,
      elideHead: 5,
      elideTail: 5,
    });
    expect(text).toContain("similar items were not rendered; total array length is 150");
    expect(elisions[0]!.shownShape).toBe("similar items");
    expect(elisions[0]!.hiddenShape).toBe("similar items");
  });

  it("second-level single dominant array gets secondLevelArrayLimit — 50 strings fits under 100", () => {
    const { text, elisions } = toSExprStringWithElisions(
      { response: Array.from({ length: 50 }, (_, i) => `s${i}`) },
      { maxItems: 20, secondLevelArrayLimit: 100, elideHead: 5, elideTail: 5 },
    );
    expect(text).not.toContain("were not rendered");
    expect(elisions).toEqual([]);
  });

  it("two big arrays (ambiguous) → NOT exactly one, both elide at the plain maxItems", () => {
    const { text, elisions } = toSExprStringWithElisions(
      {
        a: Array.from({ length: 30 }, (_, i) => i),
        b: Array.from({ length: 30 }, (_, i) => i),
      },
      { maxItems: 20, secondLevelArrayLimit: 100, elideHead: 5, elideTail: 5 },
    );
    expect(elisions).toHaveLength(2);
    expect(elisions[0]!.total).toBe(30);
    expect(elisions[1]!.total).toBe(30);
  });
});

describe("shape classifier (describeElision, exercised via ElisionRecord shapes)", () => {
  it("objects with varying key sets → 'similar items of varying shape'", () => {
    const items = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? { a: i } : { a: i, b: i }));
    const { elisions } = toSExprStringWithElisions(items, { maxItems: 5, elideHead: 2, elideTail: 2 });
    expect(elisions[0]!.hiddenShape).toBe("similar items of varying shape");
  });

  it("arrays of strings → 'arrays of strings'", () => {
    const items = Array.from({ length: 20 }, (_, i) => [`x${i}`, `y${i}`]);
    const { elisions } = toSExprStringWithElisions(items, { maxItems: 5, elideHead: 2, elideTail: 2 });
    expect(elisions[0]!.hiddenShape).toBe("arrays of strings");
  });

  it("mixed primitive kinds → 'mixed items (numbers and strings)'", () => {
    const items = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? i : `s${i}`));
    const { elisions } = toSExprStringWithElisions(items, { maxItems: 5, elideHead: 2, elideTail: 2 });
    expect(elisions[0]!.hiddenShape).toBe("mixed items (numbers and strings)");
  });

  it("length > 1000 skips type identification → 'items' (the marker descriptor AND the hidden-slice shape, which is 1990 items)", () => {
    const items = Array.from({ length: 2000 }, (_, i) => i);
    const { text, elisions } = toSExprStringWithElisions(items, { maxItems: 20, elideHead: 5, elideTail: 5 });
    expect(text).toContain("items were not rendered");
    // The SHOWN slice is only head+tail (10 items) — small enough to identify normally.
    expect(elisions[0]!.shownShape).toBe("numbers");
    // The HIDDEN slice (1990 items) crosses the 1000 guard.
    expect(elisions[0]!.hiddenShape).toBe("items");
  });
});

describe("round-trip: the elided form still PARSES", () => {
  it("the marker is a #| |# block comment — arrival's reader accepts the whole form", async () => {
    const { text } = toSExprStringWithElisions(
      Array.from({ length: 100 }, (_, i) => i),
      { maxItems: 20, elideHead: 5, elideTail: 5 },
    );
    const forms = await parse(text);
    expect(forms).toHaveLength(1);
  });
});
