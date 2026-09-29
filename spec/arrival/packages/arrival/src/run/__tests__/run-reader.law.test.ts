/**
 * LAW — THE RUN-READER DOOR (V's DI ruling, docs/plans/rework-zone-guidelines.md
 * §"run-reader door": "discovery takes run context, extracts each symbol whose owning
 * capability is an mcp capability, renders it in prelude"). The cross-cutting prerequisite
 * the MCP DI rework (§2 of the same doc) builds on: `ownerOf`/`symbolsOwnedBy`
 * (`run/CallCtx.ts`, surfaced on `/host-internals`).
 *
 * Rows pinned here:
 *   1. owned-symbol filtering across a run with TWO capabilities — each capability's
 *      `symbolsOwnedBy` answers exactly its own verbs, never the other's, never the base
 *      roster's.
 *   2. a root-scope `(define ...)` value is owner-less — `ownerOf` on it is `undefined`, and
 *      neither capability's `symbolsOwnedBy` ever lists it (it never even reaches the
 *      vocabulary walk — Stage B1's own define/vocabulary split).
 *   3. reuse across REPL passes: the SAME `runCtx` threaded through two `execState` calls
 *      answers `symbolsOwnedBy` consistently (the underlying vocabulary is one frozen map,
 *      never rebuilt mid-run).
 */
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../../common/capability.js";
import { execState } from "../../eval/generator-exec.js";
import { ownerOf, symbolsOwnedBy } from "../CallCtx.js";

describe("run-reader door — symbolsOwnedBy / ownerOf", () => {
  it("filters a TWO-capability run to exactly each capability's own verbs", async () => {
    const capA = EnvCapability.define("test/run-reader-a", {
      symbols: (symbol, z) => ({
        "run-reader-a-verb": symbol.rosetta`run-reader-a-verb: adds one`(
          { input: [z.number], output: [z.number] },
          (n: number) => n + 1,
        ),
      }),
    });
    const capB = EnvCapability.define("test/run-reader-b", {
      symbols: (symbol, z) => ({
        "run-reader-b-verb": symbol.rosetta`run-reader-b-verb: doubles`(
          { input: [z.number], output: [z.number] },
          (n: number) => n * 2,
        ),
      }),
    });

    const { runCtx } = await execState("(run-reader-a-verb 1)", { capabilities: [capA, capB] });

    const ownedByA = symbolsOwnedBy(runCtx, capA);
    const ownedByB = symbolsOwnedBy(runCtx, capB);

    expect([...ownedByA.keys()]).toEqual(["run-reader-a-verb"]);
    expect([...ownedByB.keys()]).toEqual(["run-reader-b-verb"]);

    // Not the OTHER capability's verb...
    expect(ownedByA.has("run-reader-b-verb")).toBe(false);
    expect(ownedByB.has("run-reader-a-verb")).toBe(false);
    // ...and not the base roster's (folded into every run's vocabulary, `+` is always present).
    expect(ownedByA.has("+")).toBe(false);
    expect(ownedByB.has("+")).toBe(false);
  });

  it("a root-scope define is owner-less — never listed by any capability", async () => {
    const capA = EnvCapability.define("test/run-reader-rootscope-a", {
      symbols: (symbol, z) => ({
        "rootscope-a-verb": symbol.rosetta`rootscope-a-verb: identity`(
          { input: [z.number], output: [z.number] },
          (n: number) => n,
        ),
      }),
    });
    const capB = EnvCapability.define("test/run-reader-rootscope-b", {
      symbols: (symbol, z) => ({
        "rootscope-b-verb": symbol.rosetta`rootscope-b-verb: identity`(
          { input: [z.number], output: [z.number] },
          (n: number) => n,
        ),
      }),
    });

    const { runCtx, values } = await execState(
      "(define run-reader-root-witness (lambda (n) n)) run-reader-root-witness",
      { capabilities: [capA, capB] },
    );
    const rootValue = values[1];

    // The value itself carries no owner...
    expect(ownerOf(rootValue)).toBeUndefined();
    // ...and its NAME never surfaces under either capability's owned-symbol map, because a
    // root-scope define lands in the run's lexical `scope`, never in `runCtx.vocabulary`.
    expect(symbolsOwnedBy(runCtx, capA).has("run-reader-root-witness")).toBe(false);
    expect(symbolsOwnedBy(runCtx, capB).has("run-reader-root-witness")).toBe(false);
  });

  it("reuse across REPL passes: the SAME runCtx answers symbolsOwnedBy consistently", async () => {
    const cap = EnvCapability.define("test/run-reader-repl", {
      symbols: (symbol, z) => ({
        "repl-verb": symbol.rosetta`repl-verb: adds one`(
          { input: [z.number], output: [z.number] },
          (n: number) => n + 1,
        ),
      }),
    });

    const first = await execState("(define run-reader-repl-witness 1)", { capabilities: [cap] });
    const ownedFirst = symbolsOwnedBy(first.runCtx, cap);

    // Second pass over the SAME tuple, threading BOTH `scope` (lexical continuity) and
    // `runCtx` (REUSED verbatim by `assembleRun` — the tuple-identity check passes since the
    // capability set is unchanged, so the prelude is not re-run and the returned runCtx IS
    // `first.runCtx` by reference).
    const second = await execState("(repl-verb run-reader-repl-witness)", {
      capabilities: [cap],
      scope: first.scope,
      runCtx: first.runCtx,
    });
    expect(second.runCtx).toBe(first.runCtx);

    const ownedSecond = symbolsOwnedBy(second.runCtx, cap);
    expect([...ownedSecond.keys()]).toEqual([...ownedFirst.keys()]);
    // Same underlying vocabulary map ⇒ the SAME bound value by reference, not just by name.
    expect(ownedSecond.get("repl-verb")).toBe(ownedFirst.get("repl-verb"));
  });
});
