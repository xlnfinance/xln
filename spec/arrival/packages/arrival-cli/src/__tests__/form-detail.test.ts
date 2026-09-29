// form-detail — the drill-down. `formDetail` computes over real traces; the render is
// asserted on stripped lines. Both the pruned path (arithmetic scaffolding → structure
// only) and the retained path (a root form's value, a rejection's error) are exercised.
import { describe, expect, it } from "vitest";

import { execState } from "@inhuman.tools/arrival";
import { EvalTrace } from "@inhuman.tools/arrival/provenance";

import { formDetail, renderFormDetail } from "../form-detail.js";
import { stripAnsi } from "./ansi-strip.js";

async function traced(src: string, { allowReject = false }: { allowReject?: boolean } = {}): Promise<EvalTrace> {
  const trace = new EvalTrace();
  const run = execState(src, { tap: trace, budgetMs: 30_000 });
  if (allowReject) await run.catch(() => {});
  else await run;
  return trace;
}

describe("formDetail — aggregate, not dump", () => {
  it("fib's `if` (×177): callers show the recursion structure, samples capped", async () => {
    const trace = await traced("(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))\n(fib 10)");
    const d = formDetail(trace, "if@1:16");
    expect(d.found).toBe(true);
    expect(d.count).toBe(177);
    expect(d.states.resolved).toBe(177);
    // the two recursive call sites each drove 88 invocations — the recursion shape
    const callerMap = new Map(d.callers);
    expect(callerMap.get("fib@1:33")).toBe(88);
    expect(callerMap.get("fib@1:47")).toBe(88);
    // a 177-invocation form must not dump 177 rows
    expect(d.samples.length).toBeLessThanOrEqual(6);
    expect(d.moreSamples).toBe(177 - d.samples.length);
    // arithmetic scaffolding: values pruned
    expect(d.samples.every((s) => s.value === null)).toBe(true);
  });

  it("a root form retains its value (the retained-value path)", async () => {
    const d = formDetail(await traced("(+ 40 2)"), "+@1:0");
    expect(d.found).toBe(true);
    expect(d.samples[0]!.value).toContain("42");
  });

  it("a rejected invocation carries its error message as the sample value", async () => {
    const d = formDetail(await traced("(/ 1 0)", { allowReject: true }), "/@1:0");
    expect(d.states.rejected).toBe(1);
    expect(d.samples[0]!.state).toBe("rejected");
    expect(d.samples[0]!.value ?? "").toMatch(/division by zero/i);
  });

  it("an unknown scope is not found (and teaches, not throws)", async () => {
    const d = formDetail(await traced("(+ 1 2)"), "bogus@9:9");
    expect(d.found).toBe(false);
    const lines = renderFormDetail(d).map(stripAnsi);
    expect(lines[0]).toContain("no form bogus@9:9");
  });
});

describe("renderFormDetail", () => {
  it("all-pruned samples collapse to a compact depth-ladder line (no wall of «elided»)", async () => {
    const trace = await traced("(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))\n(fib 10)");
    const lines = renderFormDetail(formDetail(trace, "if@1:16")).map(stripAnsi);
    expect(lines.join("\n")).toContain("×177");
    expect(lines.join("\n")).toContain("called from:");
    expect(lines.some((l) => l.includes("values pruned"))).toBe(true);
    // exactly one values line, not six elided rows
    expect(lines.filter((l) => l.includes("«elided»"))).toHaveLength(0);
  });

  it("retained values render per-row", async () => {
    const lines = renderFormDetail(formDetail(await traced("(+ 40 2)"), "+@1:0")).map(stripAnsi);
    expect(lines.some((l) => l.includes("samples:"))).toBe(true);
    expect(lines.some((l) => l.includes("42"))).toBe(true);
  });

  it("with a file and a colored mode, the head is an OSC 8 hyperlink to its source location", async () => {
    const d = formDetail(await traced("(+ 40 2)"), "+@1:0");
    const lines = renderFormDetail(d, "truecolor", "/abs/fib.scm");
    expect(lines.join("\n")).toContain("file:///abs/fib.scm:1");
    // the head text still reads fine once stripped — the hyperlink wraps, doesn't mangle.
    expect(lines.map(stripAnsi).join("\n")).toContain("+");
  });

  it("caller locations become hyperlinks too (the recursion's call sites)", async () => {
    const trace = await traced("(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))\n(fib 10)");
    const d = formDetail(trace, "if@1:16");
    const lines = renderFormDetail(d, "truecolor", "/abs/fib.scm");
    const calledFrom = lines.filter((l) => l.includes("fib@1:33") || l.includes("fib@1:47"));
    expect(calledFrom.length).toBeGreaterThan(0);
    expect(calledFrom.every((l) => l.includes("file:///abs/fib.scm:1"))).toBe(true);
  });

  it('`mode: "none"` stays byte-identical even when a file is given — no OSC 8 leaks', async () => {
    const d = formDetail(await traced("(+ 40 2)"), "+@1:0");
    const plain = renderFormDetail(d, "none");
    const withFile = renderFormDetail(d, "none", "/abs/fib.scm");
    expect(withFile).toEqual(plain);
  });
});
