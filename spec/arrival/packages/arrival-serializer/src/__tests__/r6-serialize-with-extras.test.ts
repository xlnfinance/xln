// `serializeWithExtras` — the additive {core, extras} sibling of `toSExprString`. Laws exercised
// here:
//
//   • EXTRACTION — a binary leaf (Blob, or an AValue-duck whose toJS projection is a Blob)
//     collects into `extras` and renders in core as `#attachment "att-N (mime, size)"`.
//   • BYTE-IDENTITY — `toSExprString` itself never extracts (the R0 pins hold; re-asserted
//     here on the exact same value).
//   • ROUND-TRIP — the core text still PARSES through arrival's own reader (the same law as
//     the truncation markers).
//   • TEXT-BUDGET — an extracted blob charges the text budget only its ~40-char tag, never
//     its byte size.
//   • QUOTA — consulted DURING the walk via the shared `ExtrasState`: past quota, leaves
//     render tag-only (`over-quota`), are NEVER collected, and the count rides `overflow`.
//   • SHARED STATE — ids continue across renders of one call (att-1, att-2, …).
//   • SHRINK-SAFETY — the shrink-to-fit re-render loop neither duplicates extras nor burns
//     quota per pass; only the final pass's collection stands.

import { parse } from "@inhuman.tools/arrival";
import { describe, expect, it } from "vitest";

import { initialExtrasState, serializeWithExtras, toSExprString } from "../serializer.js";

const png = (bytes = 64): Blob => new Blob([new Uint8Array(bytes)], { type: "image/png" });

describe("R6 — extraction: binary leaves become tagged literals + extras", () => {
  it("a raw Blob leaf renders as #attachment and lands in extras", () => {
    const blob = png(2048);
    const { core, extras, overflow } = serializeWithExtras({ img: blob, n: 1 });
    expect(core).toBe('{:img #attachment "att-1 (image/png, 2kB)" :n 1}');
    expect(extras).toEqual([{ id: "att-1", blob }]);
    expect(overflow).toBe(0);
  });

  it("an AValue-duck whose toJS projection is a Blob is intercepted whole (provenance-blind)", () => {
    const blob = png(100);
    const avalue = { "arrival/toJS": () => blob, kind: "blob", provenance: new Set() };
    const { core, extras } = serializeWithExtras({ shot: avalue });
    expect(core).toBe('{:shot #attachment "att-1 (image/png, 100B)"}');
    expect(extras).toEqual([{ id: "att-1", blob }]);
  });

  it("multiple leaves collect in encounter order with sequential ids", () => {
    const a = png(10);
    const b = new Blob([new Uint8Array(20)], { type: "audio/wav" });
    const { core, extras } = serializeWithExtras([a, { deep: b }]);
    expect(core).toContain('#attachment "att-1 (image/png, 10B)"');
    expect(core).toContain('#attachment "att-2 (audio/wav, 20B)"');
    expect(extras.map((e) => e.id)).toEqual(["att-1", "att-2"]);
    expect(extras[1]!.blob).toBe(b);
  });

  it("a typeless Blob descriptor falls back to application/octet-stream", () => {
    const { core } = serializeWithExtras(new Blob([new Uint8Array(5)]));
    expect(core).toBe('#attachment "att-1 (application/octet-stream, 5B)"');
  });
});

describe("R6 — byte-identity: toSExprString never extracts (the R0 pin, re-stated on this value)", () => {
  it("the same Blob-bearing value renders through toSExprString exactly as before (no tag, no collection)", () => {
    const value = { img: png(2048), n: 1 };
    // A Blob has no enumerable own entries — today's plain-object walk renders it as `{}`.
    expect(toSExprString(value)).toBe("{:img {} :n 1}");
  });
});

describe("R6 — round-trip law: core parses through arrival's own reader", () => {
  it("a core with attachment tags is a single parseable form", async () => {
    const { core } = serializeWithExtras({ img: png(34_816), list: [1, 2, 3] });
    const forms = await parse(core);
    expect(forms).toHaveLength(1);
  });

  it("an over-quota tag-only core parses too", async () => {
    const state = initialExtrasState(0);
    const { core } = serializeWithExtras({ img: png() }, { extrasState: state });
    const forms = await parse(core);
    expect(forms).toHaveLength(1);
  });
});

describe("R6 — text budget is charged tag-only (~40 chars), never the byte size", () => {
  it("a 1MB blob costs the core only its tag", () => {
    const { core } = serializeWithExtras({ img: png(1024 * 1024) }, { maxTotalChars: 500 });
    expect(core).toBe('{:img #attachment "att-1 (image/png, 1.0MB)"}');
    expect(core.length).toBeLessThan(80);
  });
});

describe("R6 — quota consulted DURING the walk (the AttachmentSink shape)", () => {
  it("past quota: tag-only render, NOT collected, overflow counted", () => {
    const state = initialExtrasState(1);
    const first = png(10);
    const second = png(20);
    const { core, extras, overflow } = serializeWithExtras([first, second], { extrasState: state });
    expect(core).toContain('#attachment "att-1 (image/png, 10B)"');
    expect(core).toContain('#attachment "over-quota (image/png, 20B)"');
    expect(extras).toEqual([{ id: "att-1", blob: first }]); // the second blob is NEVER collected
    expect(overflow).toBe(1);
    expect(state.overflow).toBe(1);
  });

  it("quota 0 collects nothing — every leaf is tag-only", () => {
    const state = initialExtrasState(0);
    const { extras, overflow } = serializeWithExtras([png(), png()], { extrasState: state });
    expect(extras).toEqual([]);
    expect(overflow).toBe(2);
  });
});

describe("R6 — shared ExtrasState across renders of one call", () => {
  it("ids continue and quota depletes across two renders", () => {
    const state = initialExtrasState(2);
    const one = serializeWithExtras(png(10), { extrasState: state });
    const two = serializeWithExtras(png(20), { extrasState: state });
    const three = serializeWithExtras(png(30), { extrasState: state });
    expect(one.extras.map((e) => e.id)).toEqual(["att-1"]);
    expect(two.extras.map((e) => e.id)).toEqual(["att-2"]);
    expect(three.extras).toEqual([]); // quota exhausted by the first two renders
    expect(three.core).toContain("over-quota");
    expect(state.overflow).toBe(1);
  });
});

describe("R6 — shrink-to-fit re-renders never duplicate extras or re-burn quota", () => {
  it("a value whose render shrinks still yields exactly one extra per leaf, with stable ids", () => {
    const blob = png(50);
    const heavy = {
      img: blob,
      rows: Array.from({ length: 200 }, (_, i) => ({ idx: i, label: `row-${i}-${"x".repeat(50)}` })),
    };
    const state = initialExtrasState(5);
    // A tight total budget forces multiple shrink passes over the SAME value.
    const { core, extras, overflow } = serializeWithExtras(heavy, { extrasState: state, maxTotalChars: 1_500 });
    expect(core.length).toBeLessThanOrEqual(1_500 + 100);
    expect(extras).toEqual([{ id: "att-1", blob }]); // ONE extra — not one per shrink pass
    expect(overflow).toBe(0);
    expect(state.next).toBe(2); // numbering advanced exactly once
    expect(state.remaining).toBe(4); // quota burned exactly once
  });
});
