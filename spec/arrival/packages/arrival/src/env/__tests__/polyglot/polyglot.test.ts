// polyglot pack (SHARED CORE) — assemble onto a real env, then RUN the member-
// access protocol and composition family. DIALECT SPLIT (V, 2026-07-10): the
// threading macros (->/->>/~>/~>>) and the cross-dialect stdlib completion moved
// out to polyglot-clojure.test.ts / polyglot-lisp.test.ts / polyglot-racket.test.ts
// — see polyglot.ts's header for the full split rationale. This file keeps only
// what stays in the shared core: @/@?/@keys/dict, nil, compose/pipe/flow,
// %interleave.
import { exec as bareExec, execStateOverFrame, type ExecOptionsOverFrame } from "../../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../inference-env.js";
import { applyCapability } from "../../../__tests__/_fresh-env.js";
import { describe, expect, it } from "vitest";
import polyglot from "../../polyglot/polyglot.js";

// This whole file stringifies the BOXED result's Scheme print form (list "(1 4 9)")
// and checks box discipline directly (`.constructor.name === "AVector"`) — a
// boxed-state concern (RULINGS.md R1), not the SIMPLE tier's plain-JS exit. Local
// `exec` shadows the barrel export with the COMPLEX tier (execStateOverFrame) so every
// call site passing its own `env` is unchanged and still reads the boxed SchemeValue[]
// it always did.
async function exec(code: string, options: ExecOptionsOverFrame) {
  return (await execStateOverFrame(code, options)).values.slice();
}

describe("@inhuman.tools/arrival/polyglot (shared core)", () => {
  it("installs @/@?/@keys/dict and compose/pipe run correctly standalone", async () => {
    const env = sandboxedEnv.child("polyglot-core-test");
    await applyCapability(env, [polyglot]);

    const num = async (src: string) => Number((await exec(src, { env }))[0]);
    // compose is right-to-left: (*2 (+1 5)) = 12
    expect(await num("((compose (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)")).toBe(12);
    // pipe is left-to-right: (*2 (+1 5)) = 12
    expect(await num("((pipe (lambda (x) (+ x 1)) (lambda (x) (* x 2))) 5)")).toBe(12);
    // flow is pipe's alias
    expect(await num("((flow (lambda (x) (+ x 1)) (lambda (x) (* x 2))) 5)")).toBe(12);

    const str = async (src: string) => String((await exec(src, { env }))[0]);
    expect(await str("(@ (dict :a 1) :a)")).toBe("1");
    // @keys answers a VECTOR of keys, so it composes with the vector verbs and with
    // `@` — assert through that surface rather than stringifying the container.
    expect(await num("(vector-length (@keys (dict :a 1 :b 2)))")).toBe(2);
    expect(await str("(vector-ref (@keys (dict :a 1)) 0)")).toBe("a");
    expect(await num("(@ (dict :a 1) (vector-ref (@keys (dict :a 1)) 0))")).toBe(1);
  });

  it("exports a well-formed SchemePackSpec — the shrunk core, post-split", () => {
    expect(polyglot.name).toBe("scheme/polyglot");
    expect(polyglot.spec.prelude).toBeUndefined();
    // No text-blob prelude — individually-declared symbol.define/symbol.native entries only.
    const symbols = polyglot.spec.symbols as Record<string, { kind?: string; callable?: boolean }>;
    expect(symbols["compose"]?.kind).toBe("define");
    expect(symbols["compose"]?.callable).toBe(true);
    expect(symbols["flow"]?.callable).toBe(false);
    expect(symbols["nil"]?.callable).toBe(false);
    // Post-split: the threading macros are NOT here anymore — they moved to
    // polyglot-clojure.ts (->/->>) and polyglot-racket.ts (~>/~>>).
    expect(symbols["->"]).toBeUndefined();
    expect(symbols["~>"]).toBeUndefined();
    // Post-split: comp (Clojure's alias) moved to polyglot-clojure.ts too.
    expect(symbols["comp"]).toBeUndefined();
  });

  it("deps shrink to [equality, lists] — the whole cross-capability reach of the shrunk core", () => {
    const names = (polyglot.spec.deps ?? []).map((d) => d.name);
    expect(names.sort()).toEqual(["scheme/equality", "scheme/lists"]);
  });
});

describe("@inhuman.tools/arrival/polyglot — nil (polyglot empty-list alias, shared)", () => {
  it("nil is the empty list", async () => {
    // `(if …)` normalizes over the boxed-ABool representation (same convention
    // the sibling dialect test files use for boolean-verdict assertions).
    const [truthy] = await bareExec('(if (null? nil) "yes" "no")');
    expect(String(truthy)).toBe("yes");
  });
});
