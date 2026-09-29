// run-export — the versioned JSON run-introspection contract. It's a thin envelope over
// runView, so the test pins the shape, the version, and JSON-round-trippability (an agent
// / jq / future --diff consumes it).
import { describe, expect, it } from "vitest";

import { execState } from "@inhuman.tools/arrival";
import { EvalTrace } from "@inhuman.tools/arrival/provenance";

import { exportRun, RUN_EXPORT_VERSION } from "../run-export.js";

async function traced(src: string): Promise<EvalTrace> {
  const trace = new EvalTrace();
  await execState(src, { tap: trace, budgetMs: 30_000 });
  return trace;
}

describe("exportRun", () => {
  it("carries version, total invocations, and the source-ordered forms", async () => {
    const out = exportRun(await traced("(map (lambda (n) (* n n)) (iota 6))"));
    expect(out.version).toBe(RUN_EXPORT_VERSION);
    expect(out.invocations).toBe(9); // matches the probe: 9 total invocations
    const star = out.forms.find((f) => f.head === "*");
    expect(star?.count).toBe(6);
    expect(star?.state).toBe("done");
  });

  it("is plain JSON — round-trips through stringify/parse unchanged", async () => {
    const out = exportRun(await traced("(+ 40 2)"));
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("fib: the whole-run invocation total is the headline number", async () => {
    const out = exportRun(await traced("(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))\n(fib 10)"));
    expect(out.invocations).toBe(796);
    expect(out.forms.find((f) => f.head === "if")?.count).toBe(177);
  });
});
