// polyglot-racket pack — assemble onto a real env, then RUN the threading-alias
// macros and the dict accessor family. Split out of polyglot.test.ts (V,
// 2026-07-10 dialect split — see polyglot.ts's header for the full rationale).
import {
  execState as bareExecState,
  execStateOverFrame,
  type ExecOptionsOverFrame,
} from "../../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../inference-env.js";
import { applyCapability } from "../../../__tests__/_fresh-env.js";
import { describe, expect, it } from "vitest";
import polyglotRacket from "../../polyglot/polyglot-racket.js";

async function exec(code: string, options: ExecOptionsOverFrame) {
  return (await execStateOverFrame(code, options)).values.slice();
}

describe("@inhuman.tools/arrival/polyglot-racket", () => {
  it("installs ~>/~>> (aliasing Clojure's ->/->>) and dict-count, assembled STANDALONE", async () => {
    const env = sandboxedEnv.child("polyglot-racket-test");
    // Assembling JUST polyglot-racket pulls in scheme/polyglot-clojure (for the
    // ->/->> that ~>/~>> expand to, and str) transitively via its own declared
    // `deps` — the C3 dep walk this pack's header documents.
    await applyCapability(env, [polyglotRacket]);

    const num = async (src: string) => Number((await exec(src, { env }))[0]);
    // ~> is an alias of -> (thread-first)
    expect(await num("(~> 5 (+ 10))")).toBe(15);
    // ~>> is an alias of ->> (thread-last)
    expect(await num("(~>> 5 (- 20))")).toBe(15);
    expect(await num("(dict-count (dict :a 1 :b 2))")).toBe(2);
  });

  it("exports a well-formed SchemePackSpec", () => {
    expect(polyglotRacket.name).toBe("scheme/polyglot-racket");
    expect(polyglotRacket.spec.prelude).toBeUndefined();
    const symbols = polyglotRacket.spec.symbols as Record<string, { kind?: string; macroAttribute?: string }>;
    expect(symbols["~>"]?.kind).toBe("define-syntax");
    expect(symbols["~>"]?.macroAttribute).toBe("expression");
    expect(symbols["~>>"]?.kind).toBe("define-syntax");
    expect(symbols["dict-ref"]?.kind).toBe("define");
    expect(symbols["%dict-guard"]?.kind).toBe("define");
  });

  it("deps reach scheme/polyglot-clojure (for ->/->> and str) and the core/R7RS natives this pack's bodies use", () => {
    const names = (polyglotRacket.spec.deps ?? []).map((d) => d.name);
    expect(names[0]).toBe("scheme/polyglot-clojure"); // dependents-before-dependencies
    expect(names).toEqual(
      expect.arrayContaining([
        "scheme/polyglot-clojure",
        "scheme/polyglot",
        "scheme/equality",
        "scheme/numeric",
        "scheme/r7rs/exceptions",
        "scheme/vectors",
        "scheme/lists",
      ]),
    );
  });
});

// dict accessor family (Racket's dict library) — grain-completion: MCP-Atlas
// trajectory autopsy found models reaching for `dict-ref` on a dict-shaped tool
// result and getting stranded (Unbound variable). These are dict-SPECIFIC (guard
// the dict shape, unlike @'s origin-agnostic read) real bindings, not stubs.
// Default assembled env — polyglot-racket ships in BASE_PACKS in production.
describe("@inhuman.tools/arrival/polyglot-racket — dict accessor family (Bucket A)", () => {
  const str = async (src: string) => String((await bareExecState(src)).values[0]);
  const raw = async (src: string) => (await bareExecState(src)).values;

  it("dict-ref — reads by keyword, symbol, or string key, identically", async () => {
    expect(await str("(dict-ref (dict :a 1) :a)")).toBe("1");
    expect(await str('(dict-ref (dict "a" 1) \'a)')).toBe("1");
    expect(await str('(dict-ref (dict "a" 1) "a")')).toBe("1");
  });

  it("dict-ref — optional default, nil when missing and no default (same convention as get-in)", async () => {
    expect(await str("(dict-ref (dict :a 1) :b 99)")).toBe("99");
    const missing = await raw("(dict-ref (dict :a 1) :b)");
    expect(missing[0]).toEqual((await raw("'()"))[0]);
  });

  it("dict-ref — nested dicts", async () => {
    expect(await str("(dict-ref (dict-ref (dict :a (dict :b 2)) :a) :b)")).toBe("2");
  });

  it("dict-ref — errors with a door (fact + why + action) on a non-dict", async () => {
    await expect(raw("(dict-ref (list 1 2) :a)")).rejects.toThrow(
      /dict-ref: expected a dict .* got a pair\/list.*use @ for an origin-agnostic read/,
    );
    await expect(raw('(dict-ref "x" :a)')).rejects.toThrow(/dict-ref: expected a dict .* got a string/);
  });

  it("dict-has-key? — #t iff key resolves, #f when missing", async () => {
    const truthy = async (src: string) => str(`(if ${src} "yes" "no")`);
    expect(await truthy("(dict-has-key? (dict :a 1) :a)")).toBe("yes");
    expect(await truthy("(dict-has-key? (dict :a 1) :b)")).toBe("no");
  });

  it("dict-keys / dict-values — proper scheme lists, composable with map/filter", async () => {
    expect(await str("(length (dict-keys (dict :a 1 :b 2)))")).toBe("2");
    // dict-keys elements are raw JS strings lifted via array->list (same representation
    // as @keys elsewhere in this pack) — they print unquoted inside a list, same quirk
    // as any other raw-string-in-pair-spine value in this runtime.
    expect(await str("(map (lambda (k) k) (dict-keys (dict :a 1)))")).toBe("(a)");
    expect(await str("(dict-values (dict :a 1))")).toBe("(1)");
  });

  it("dict-count — the number of keys", async () => {
    expect(await str("(dict-count (dict :a 1 :b 2 :c 3))")).toBe("3");
    expect(await str("(dict-count (dict))")).toBe("0");
  });

  it("dict->alist / alist->dict — round trip through an alist of (key . value) pairs", async () => {
    expect(await str('(cdr (assoc "a" (dict->alist (dict :a 1))))')).toBe("1");
    expect(await str('(dict-ref (alist->dict (list (cons "a" 1) (cons "b" 2))) :b)')).toBe("2");
  });

  it("dict-set — an immutability DOOR, not a function (a 'set' verb in an immutable env is a silent-mutation trap)", async () => {
    await expect(raw("(dict-set (dict :a 1) :a 2)")).rejects.toThrow(
      /dict-set is not provided — dicts are immutable here.*assoc-in.*original d is unchanged/s,
    );
  });

  it("dict-update — an immutability DOOR pointing at update-in", async () => {
    await expect(raw("(dict-update (dict :a 1) :a (lambda (x) (+ x 1)))")).rejects.toThrow(
      /dict-update is not provided — dicts are immutable here.*update-in.*original d is unchanged/s,
    );
  });

  it("assoc-ref (Guile) — an alias of dict-ref, same key handling and default convention", async () => {
    expect(await str("(assoc-ref (dict :a 1) :a)")).toBe("1");
    expect(await str("(assoc-ref (dict :a 1) :b 42)")).toBe("42");
  });
});
