// A MEMBRANE WARNING IS BOUNDED BY ITS SHAPES, NOT BY THE DATA.
//
// Found the hard way (2026-07-14). A benchmark facade died mid-run:
//
//     FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
//
// and its log held ~400k copies of ONE line:
//
//     [arrival membrane] a JS `undefined` crossed into Scheme and materialized to #void — …
//
// A tool had returned a large JSON array whose objects carried nulls. Every null crossing the
// membrane logged a full paragraph. 8 benchmark tasks were lost to the crash ("facade unavailable").
//
// The warning is RIGHT to exist — "a JS `undefined` has no portable Scheme representation" is worth
// saying. It is worth saying ONCE. Said per value, an O(1) diagnostic becomes an O(n) cost on the
// hot path, and the one useful line becomes unfindable among 400k identical ones.
//
// Same law as the note sink: a fact ABOUT the crossing belongs to the RUN, not to each value that
// makes it. This test pins the bound.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setMembraneWarnings, warnMembrane } from "../membrane-warn.js";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Toggling OFF→ON clears the dedupe table, so each test starts from a clean slate without
  // exporting a test-only reset (the toggle already had to exist).
  setMembraneWarnings(false);
  setMembraneWarnings(true);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  setMembraneWarnings(false);
  setMembraneWarnings(true);
});

describe("POSITIVE — the warning still teaches", () => {
  it("the first crossing of a shape is reported, in full", () => {
    warnMembrane("a JS `undefined`");
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]![0]);
    expect(text).toContain("[arrival membrane]");
    expect(text).toContain("a JS `undefined`");
    expect(text).toContain("no portable"); // the teaching clause survives
  });

  it("DISTINCT shapes each get their own report — the bound is per-shape, not global", () => {
    warnMembrane("a JS `undefined`");
    warnMembrane("a JS function");
    warnMembrane("a unique symbol");
    const texts = warn.mock.calls.map((c) => String(c[0]));
    expect(texts.some((t) => t.includes("undefined"))).toBe(true);
    expect(texts.some((t) => t.includes("function"))).toBe(true);
    expect(texts.some((t) => t.includes("unique symbol"))).toBe(true);
  });

  it("a custom outcome is a distinct shape and is not swallowed by the default one", () => {
    warnMembrane("a class instance", "crossed to a borrowed wrapper");
    const text = String(warn.mock.calls[0]![0]);
    expect(text).toContain("borrowed wrapper");
  });
});

// ─── THE NEGATIVE SIDE — the part that actually killed a process ────────────────────────────────
describe("NEGATIVE — the warning cannot scale with the data", () => {
  it("400_000 identical crossings do NOT produce 400_000 lines", () => {
    for (let i = 0; i < 400_000; i++) warnMembrane("a JS `undefined`");
    // 3 reports + 1 suppression notice. NOT 400k. This is the whole point of the file: the number
    // below must not be a function of the loop bound above.
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("the suppression is ANNOUNCED — silence must never be mistaken for absence", () => {
    for (let i = 0; i < 50; i++) warnMembrane("a JS `undefined`");
    const texts = warn.mock.calls.map((c) => String(c[0]));
    // Errors-as-doors: a truncation that is not signaled is a lie. The reader must be able to tell
    // "it happened three times" from "it happened three times and then we stopped counting."
    expect(texts.some((t) => t.includes("further identical crossings will not be reported"))).toBe(true);
  });

  it("the suppression notice itself is emitted ONCE, not once per suppressed crossing", () => {
    for (let i = 0; i < 1000; i++) warnMembrane("a JS `undefined`");
    const notices = warn.mock.calls.map((c) => String(c[0])).filter((t) => t.includes("further identical crossings"));
    expect(notices).toHaveLength(1);
  });

  it("disabled means SILENT — the bound is not a backdoor around the toggle", () => {
    setMembraneWarnings(false);
    for (let i = 0; i < 10; i++) warnMembrane("a JS `undefined`");
    expect(warn).not.toHaveBeenCalled();
  });
});
