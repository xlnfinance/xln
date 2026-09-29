// history-nav — prefix-match recall (zsh / Chrome-console style). Pure cycling logic.
import { describe, expect, it } from "vitest";

import { pushHistory, recallNext, recallPrev, type NavState } from "../history-nav.js";

const H = ["(define x 1)", "(map f xs)", "(define y 2)", "(map g ys)"];

describe("recallPrev — arrow-up prefix match", () => {
  it("empty prefix walks the whole history newest-first", () => {
    const a = recallPrev(H, null, "");
    expect(a).toEqual({ entry: "(map g ys)", nav: { prefix: "", index: 3 } });
    const b = recallPrev(H, a!.nav, "");
    expect(b!.entry).toBe("(define y 2)");
  });

  it("a typed prefix skips non-matching entries", () => {
    // typed "(map " → Up should jump past "(define y 2)" to "(map g ys)"
    const a = recallPrev(H, null, "(map ");
    expect(a!.entry).toBe("(map g ys)");
    expect(a!.nav).toEqual({ prefix: "(map ", index: 3 });
    // Up again → the older "(map f xs)", skipping both defines
    const b = recallPrev(H, a!.nav, "(map ");
    expect(b!.entry).toBe("(map f xs)");
    expect(b!.nav!.index).toBe(1);
  });

  it("no older match returns null (input stays put)", () => {
    const a = recallPrev(H, null, "(map ");
    const b = recallPrev(H, a!.nav, "(map ");
    expect(recallPrev(H, b!.nav, "(map ")).toBeNull(); // only two (map …) entries
  });

  it("prefix is locked to the start line, not re-read each step", () => {
    const a = recallPrev(H, null, "(define ");
    expect(a!.entry).toBe("(define y 2)");
    expect(a!.nav!.prefix).toBe("(define "); // locked
  });
});

describe("recallNext — arrow-down", () => {
  it("null nav is a no-op (not navigating)", () => {
    expect(recallNext(H, null)).toBeNull();
  });

  it("walks forward through matches, then restores the draft past the newest", () => {
    const nav: NavState = { prefix: "(map ", index: 1 }; // showing "(map f xs)"
    const fwd = recallNext(H, nav);
    expect(fwd!.entry).toBe("(map g ys)");
    expect(fwd!.nav!.index).toBe(3);
    // past the newest match → restore the typed draft, leave nav
    const restored = recallNext(H, fwd!.nav);
    expect(restored).toEqual({ entry: "(map ", nav: null });
  });
});

describe("pushHistory", () => {
  it("appends", () => {
    expect(pushHistory(["a"], "b")).toEqual(["a", "b"]);
  });
  it("skips a consecutive duplicate and empties", () => {
    expect(pushHistory(["a", "b"], "b")).toEqual(["a", "b"]);
    expect(pushHistory(["a"], "")).toEqual(["a"]);
  });
});
