// painter — the ANSI renderer over the headless core's block model (D6). Verdicts here
// stay at "does the block model render legible, correctly-shaped lines" — the fold's
// STATE TRANSITIONS are mcp-substrate's own suite (repl-fold.test.ts); this suite never
// re-derives state, it only feeds hand-built `ReplBlock`s (every state, per §5's tint
// vocabulary) through `renderBlock`/`renderTurn` and checks the stripped output.
import type { ReplBlock } from "../repl-model/repl-fold.js";
import { describe, expect, it } from "vitest";

import { paintRegion, renderBlock, renderTurn, type Writer } from "../painter.js";
import { stripAnsi } from "./ansi-strip.js";

const counters = { elapsedMs: 3 };

describe("renderBlock", () => {
  it("pending: source line only, no content, no gutter", () => {
    const block: ReplBlock = { index: 0, source: "(define x 1)", state: "pending", content: [] };
    const lines = renderBlock(block, "scheme").map(stripAnsi);
    expect(lines).toEqual(["· (define x 1)"]);
  });

  it("running: same shape as pending (the tint differs, the TEXT glyph is shared — pending/skipped and running only diverge by color)", () => {
    const block: ReplBlock = { index: 0, source: "(slow-thing)", state: "running", content: [] };
    expect(renderBlock(block, "scheme").map(stripAnsi)).toEqual(["▸ (slow-thing)"]);
  });

  it("done: source, value content, and the elapsed gutter", () => {
    const block: ReplBlock = {
      index: 1,
      source: "(+ x 1)",
      state: "done",
      content: [{ type: "text", text: "2" }],
      counters,
    };
    expect(renderBlock(block, "scheme").map(stripAnsi)).toEqual(["✓ (+ x 1)", "  2", "  3ms"]);
  });

  it("error: source, the door text as body, gutter — same shape as done, distinct tint", () => {
    const block: ReplBlock = {
      index: 2,
      source: "(nope)",
      state: "error",
      content: [{ type: "text", text: '(error "unbound symbol nope")' }],
      counters: { elapsedMs: 0 },
      error: "unbound symbol nope",
    };
    expect(renderBlock(block, "scheme").map(stripAnsi)).toEqual([
      "✗ (nope)",
      '  (error "unbound symbol nope")',
      "  0ms",
    ]);
  });

  it("skipped: distinct body text, no gutter — 'queued but never reached' vs 'still queued'", () => {
    const block: ReplBlock = { index: 3, source: "(+ x 2)", state: "skipped", content: [] };
    expect(renderBlock(block, "scheme").map(stripAnsi)).toEqual([
      "· (+ x 2)",
      "  (skipped — an earlier form in this submission crashed)",
    ]);
  });

  it("renders through the sugarcoat lens when active — same block, different surface", () => {
    const block: ReplBlock = {
      index: 0,
      source: "(define (f x) (* x 2))",
      state: "done",
      content: [{ type: "text", text: "(define (f x) (* x 2))" }],
    };
    const lines = renderBlock(block, "sugarcoat").map(stripAnsi);
    expect(lines[0]).toBe("✓ define (f x)");
    expect(lines).toContain("    {x * 2}"); // the multi-line sugarcoat render indents under the 2-space content prefix
  });
});

describe("renderTurn", () => {
  it("blank-line-separates multiple blocks in submission order", () => {
    const blocks: ReplBlock[] = [
      { index: 0, source: "(define x 1)", state: "done", content: [] },
      { index: 1, source: "(+ x 1)", state: "done", content: [{ type: "text", text: "2" }], counters },
    ];
    const lines = renderTurn(blocks, "scheme").map(stripAnsi);
    expect(lines).toEqual(["✓ (define x 1)", "", "✓ (+ x 1)", "  2", "  3ms"]);
  });
});

describe("paintRegion", () => {
  it("writes cursor-up + clear-to-end + the new lines, and returns the new line count", () => {
    const writes: string[] = [];
    const fakeOut: Writer = { write: (s: string) => writes.push(s) };
    const n = paintRegion(["a", "b", "c"], 2, fakeOut);
    expect(n).toBe(3);
    expect(writes[0]).toContain("\x1b[2A"); // cursor up 2 (the PREVIOUS line count)
    expect(writes[1]).toBe("a\nb\nc\n");
  });

  it("prevLineCount: 0 emits no cursor-up motion (nothing painted yet)", () => {
    const writes: string[] = [];
    const fakeOut: Writer = { write: (s: string) => writes.push(s) };
    paintRegion(["only"], 0, fakeOut);
    expect(writes[0]).not.toContain("A"); // no `\x1b[NA` cursor-up code
  });
});
