/**
 * buildUneval closed-loop e2e (stream M3 / W3d).
 *
 * Flagship path: execState + tap → buildUneval({ scope, result, trace, source, forms })
 *   → uneval(selector).program re-exec on a FRESH LexicalScope with the same capabilities
 *   → value matches; unrelated defines pruned; points cover ports in the cone.
 *
 * Showcase model (README dual-source, live deterministic Rosetta — not frozen-ingress):
 *   (define chatter (string-append (chatter-feed) "!"))
 *   (define verdict (string-append "malware: " (scan-output)))
 *   (list verdict "benign")
 * selector `(car result)` → scan path only; chatter pruned; re-exec matches.
 *
 * API truth (README drift is separate W1):
 *   - import from `@inhuman.tools/arrival-provenance/analysis`
 *   - opts: `{ scope, result, trace, source, forms }` — NOT `env`
 *   - `forms: []` → output form is `lastTopLevelForm(trace)` (identity-safe)
 *   - re-parse of `source` for forms is an identity pitfall (points/outputNode ===)
 *   - `uneval` mutates scope via `scope.env.bind("result", …)` — never re-exec on that scope
 *
 * Residual honesty: re-exec re-invokes live Rosetta ports. Deterministic fixtures match;
 * non-deterministic sources would diverge without frozen-ingress (Phase 3, out of scope).
 */
import { EnvCapability, exec, execState, LexicalScope } from "@inhuman.tools/arrival";
import { describe, expect, it } from "vitest";
import { buildUneval, lastTopLevelForm } from "../analysis.js";
import { EvalTrace } from "../index.js";

let seq = 0;

/** Dual live-deterministic Rosetta-IN sources (README scanner showcase). */
const scannerCapability = EnvCapability.define("test/scanner-showcase", {
  symbols: (symbol, z) => ({
    "chatter-feed": symbol.rosetta`chatter-feed: noise source, must prune`(
      { input: [], output: [z.string] },
      () => "noise",
    ),
    "scan-output": symbol.rosetta`scan-output: malware verdict source`(
      { input: [], output: [z.string] },
      () => "evil.exe",
    ),
  }),
});

/** Single port for multi-define cases that still want a grounded read. */
const evidenceReadCapability = EnvCapability.define("test/uneval-evidence-read", {
  symbols: (symbol, z) => ({
    "evidence-read": symbol.rosetta`evidence-read: deterministic Rosetta-IN`(
      { input: [z.string], output: [z.string] },
      (q) => `SRC:${q}`,
    ),
  }),
});

type Cap = typeof scannerCapability;

async function runTraced(source: string, capabilities: readonly Cap[] = []) {
  const scope = LexicalScope.fresh(`build-uneval-e2e-${seq++}`);
  const trace = new EvalTrace();
  const { values, scope: runScope } = await execState(source, {
    scope,
    tap: trace,
    capabilities: [...capabilities],
  });
  const result = values.at(-1);
  if (result === undefined) throw new Error("fixture ran zero forms");
  return { scope: runScope, result, trace, source };
}

/** Re-exec uneval program on a FRESH scope (never the post-uneval polluted one). */
async function reExecValue(program: string, capabilities: readonly Cap[] = []): Promise<unknown> {
  const scope = LexicalScope.fresh(`build-uneval-reexec-${seq++}`);
  const values = await exec(program, { scope, capabilities: [...capabilities] });
  const last = values.at(-1);
  if (last === undefined) throw new Error("re-exec ran zero forms");
  return last;
}

describe("buildUneval e2e — pure multi-define prune + re-exec", () => {
  it("prunes unrelated defines; re-exec of the slice matches the selector value", async () => {
    const source = `
      (define unused 1)
      (define used 2)
      (define out (list used 99))
      out
    `;
    const bag = await runTraced(source);
    const container = buildUneval({
      scope: bag.scope,
      result: bag.result,
      trace: bag.trace,
      source: bag.source,
      forms: [],
    });
    const head = await container.uneval("(car result)");

    expect(head.value).toBe(2);
    expect(head.program).toMatch(/\(define used /);
    expect(head.program).toMatch(/\(define out \(list used /);
    expect(head.program).not.toMatch(/unused/);
    expect(head.program).toMatch(/\(let \(\(result /);
    expect(head.program).toMatch(/\(car result\)/);

    expect(await reExecValue(head.program)).toBe(2);
  });
});

describe("buildUneval e2e — README dual-source Rosetta showcase", () => {
  const showcase = `
    (define chatter (string-append (chatter-feed) "!"))
    (define verdict (string-append "malware: " (scan-output)))
    (list verdict "benign")
  `;

  it("prunes chatter, keeps verdict, re-exec matches under same live caps", async () => {
    const bag = await runTraced(showcase, [scannerCapability]);
    const container = buildUneval({
      scope: bag.scope,
      result: bag.result,
      trace: bag.trace,
      source: bag.source,
      forms: [],
    });
    const head = await container.uneval("(car result)");

    expect(head.value).toBe("malware: evil.exe");
    // Slice is top-level defines in the dependence cone + let/selector terminator.
    expect(head.program).toMatch(/\(define verdict \(string-append "malware: " \(scan-output\)\)\)/);
    expect(head.program).not.toMatch(/chatter/);
    expect(head.program).not.toMatch(/chatter-feed/);
    expect(head.program).toMatch(/\(let \(\(result \(list verdict "benign"\)\)\) \(car result\)\)/);

    // Provenance + points: scan-output is a Rosetta-IN port in the cone.
    expect(head.provenance.length).toBeGreaterThan(0);
    expect(head.points.length).toBeGreaterThan(0);

    // Re-exec with FRESH scope + same live deterministic caps (not frozen-ingress).
    expect(await reExecValue(head.program, [scannerCapability])).toBe("malware: evil.exe");
  });

  it("points non-empty when ports sit in the dependence cone", async () => {
    const bag = await runTraced(showcase, [scannerCapability]);
    const container = buildUneval({
      scope: bag.scope,
      result: bag.result,
      trace: bag.trace,
      source: bag.source,
      forms: [],
    });
    const head = await container.uneval("(car result)");
    expect(head.points.length).toBeGreaterThan(0);
    expect(head.provenance.length).toBeGreaterThan(0);
    // Every provenance id the selector value carries is covered by slice points
    // (under forward mint, provenance ids ARE evidence-read ids).
    const pointSet = new Set(head.points);
    expect(head.provenance.every((id) => pointSet.has(id))).toBe(true);
  });
});

describe("buildUneval e2e — empty forms / lastTopLevelForm path", () => {
  it("forms: [] anchors on lastTopLevelForm(trace), not a re-parse", async () => {
    const source = `
      (define a (evidence-read "a"))
      (define b (string-append a "-suffix"))
      (list b "noise")
    `;
    const bag = await runTraced(source, [evidenceReadCapability]);
    expect(lastTopLevelForm(bag.trace)).toBeDefined();

    const container = buildUneval({
      scope: bag.scope,
      result: bag.result,
      trace: bag.trace,
      source: bag.source,
      forms: [], // forces lastTopLevelForm path
    });
    expect(container.meta.forms).toBe(0);

    const head = await container.uneval("(car result)");
    expect(head.value).toBe("SRC:a-suffix");
    expect(head.program).toMatch(/\(define a /);
    expect(head.program).toMatch(/\(define b /);
    expect(head.program).toMatch(/\(let \(\(result \(list b "noise"\)\)\) \(car result\)\)/);
    expect(head.points.length).toBeGreaterThan(0);

    expect(await reExecValue(head.program, [evidenceReadCapability])).toBe("SRC:a-suffix");
  });

  it("non-empty forms with identity-matched last form (not a re-parse) still slices", async () => {
    const source = `
      (define keep (evidence-read "k"))
      (define drop (evidence-read "d"))
      (list keep)
    `;
    const bag = await runTraced(source, [evidenceReadCapability]);
    // Identity-safe non-empty forms: the actual trace output node, not a re-parse of source.
    const output = lastTopLevelForm(bag.trace);
    const container = buildUneval({
      scope: bag.scope,
      result: bag.result,
      trace: bag.trace,
      source: bag.source,
      forms: [output],
    });
    expect(container.meta.forms).toBe(1);
    const head = await container.uneval("(car result)");
    expect(head.value).toBe("SRC:k");
    expect(head.program).toMatch(/keep/);
    expect(head.program).not.toMatch(/drop/);
  });
});

describe("buildUneval e2e — scope pollution honesty", () => {
  it("uneval binds result into the run scope; re-exec must use a fresh scope", async () => {
    const source = `(define x 7) (list x)`;
    const bag = await runTraced(source);
    const container = buildUneval({
      scope: bag.scope,
      result: bag.result,
      trace: bag.trace,
      source: bag.source,
      forms: [],
    });
    // First uneval binds `result` on bag.scope; a second uneval still works (overwrite).
    await container.uneval("(car result)");
    const head = await container.uneval("(car result)");
    expect(head.value).toBe(7);

    // Supported path: re-exec only on a FRESH scope (not bag.scope).
    expect(await reExecValue(head.program)).toBe(7);
  });
});
