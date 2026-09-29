// polyglot-clojure pack — assemble onto a real env, then RUN the threading
// macros and the Clojure stdlib completion. Split out of polyglot.test.ts (V,
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
import polyglotClojure from "../../polyglot/polyglot-clojure.js";

async function exec(code: string, options: ExecOptionsOverFrame) {
  return (await execStateOverFrame(code, options)).values.slice();
}

describe("@inhuman.tools/arrival/polyglot-clojure", () => {
  it("installs the threading macros and comp; they run correctly assembled STANDALONE", async () => {
    const env = sandboxedEnv.child("polyglot-clojure-test");
    // Assembling JUST polyglot-clojure pulls in scheme/polyglot (core), srfi-1,
    // and the R7RS natives transitively via its own declared `deps` (C3 dep walk)
    // — the same standalone-composition story polyglot.test.ts's pre-split
    // suite told for the whole monolith.
    await applyCapability(env, [polyglotClojure]);

    const num = async (src: string) => Number((await exec(src, { env }))[0]);
    // -> threads FIRST: (+ 5 1)=6 ; (* 6 2)=12
    expect(await num("(-> 5 (+ 1) (* 2))")).toBe(12);
    // ->> threads LAST
    expect(await num("(->> 5 (- 20))")).toBe(15);
    // comp is compose's Clojure alias
    expect(await num("((comp (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)")).toBe(12);
  });

  it("exports a well-formed SchemePackSpec", () => {
    expect(polyglotClojure.name).toBe("scheme/polyglot-clojure");
    expect(polyglotClojure.spec.prelude).toBeUndefined();
    const symbols = polyglotClojure.spec.symbols as Record<string, { kind?: string; macroAttribute?: string }>;
    expect(symbols["->"]?.kind).toBe("define-syntax");
    expect(symbols["->"]?.macroAttribute).toBe("expression");
    expect(symbols["->>"]?.kind).toBe("define-syntax");
    expect(symbols["comp"]?.kind).toBe("define");
  });

  it("deps reach scheme/polyglot (core), srfi-1, and the R7RS natives this pack's bodies use", () => {
    const names = (polyglotClojure.spec.deps ?? []).map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "scheme/polyglot",
        "scheme/srfi-1",
        "scheme/equality",
        "scheme/numeric",
        "scheme/strings",
        "scheme/vectors",
        "scheme/lists",
      ]),
    );
  });
});

// Cross-dialect stdlib completion — famous Clojure symbols implemented as REAL,
// pure bindings over primitives already bound elsewhere (map/filter/reduce/dict/@/
// @keys/…). These run against the DEFAULT assembled env (`exec` with no explicit
// env), since polyglot-clojure ships in BASE_PACKS in production — the same
// surface a model actually reaches. Sibling to env/polyglot/polyglot-stubs.ts, which doors
// the symbols that genuinely can't be pure (IO/mutation/macro-only — println here).
describe("@inhuman.tools/arrival/polyglot-clojure — stdlib completion (Bucket A)", () => {
  const str = async (src: string) => String((await bareExecState(src)).values[0]);

  it("str — concatenates the display form of every arg", async () => {
    expect(await str('(str "a" "b")')).toBe("ab");
    expect(await str('(str "n=" 5)')).toBe("n=5");
    expect(await str("(str)")).toBe("");
  });

  it("get-in / assoc-in / update-in — nested dict access, immutable rebuild", async () => {
    expect(await str('(get-in (dict "a" (dict "b" 1)) (list "a" "b"))')).toBe("1");
    // assoc-in creates missing intermediate dicts on demand
    expect(await str('(get-in (assoc-in (dict) (list "a" "b") 42) (list "a" "b"))')).toBe("42");
    expect(
      await str('(get-in (update-in (dict "a" (dict "b" 1)) (list "a" "b") (lambda (x) (+ x 1))) (list "a" "b"))'),
    ).toBe("2");
    // the original dict is untouched (immutable rebuild, not mutation)
    expect(await str('(let ((d (dict "a" 1))) (assoc-in d (list "a") 99) (:a d))')).toBe("1");
  });

  it("zipmap — a dict pairing keys with vals at the same position", async () => {
    expect(await str('(:a (zipmap (list "a" "b") (list 1 2)))')).toBe("1");
    expect(await str('(:b (zipmap (list "a" "b") (list 1 2)))')).toBe("2");
  });

  it("frequencies — a dict of element to occurrence count", async () => {
    expect(await str('(@ (frequencies (list "a" "b" "a")) "a")')).toBe("2");
    expect(await str('(@ (frequencies (list "a" "b" "a")) "b")')).toBe("1");
  });

  it("group-by — a dict of (f element) to the matching elements, in order", async () => {
    expect(await str('(@ (group-by (lambda (x) (if (> x 2) "big" "small")) (list 1 2 3 4)) "big")')).toBe("(3 4)");
    expect(await str('(@ (group-by (lambda (x) (if (> x 2) "big" "small")) (list 1 2 3 4)) "small")')).toBe("(1 2)");
  });

  it("partial — fixes leading args, returns a function of the rest", async () => {
    expect(await str("((partial + 1 2) 3)")).toBe("6");
  });

  it("juxt — applies every fn to the same args, collecting the results", async () => {
    expect(await str("((juxt (lambda (x) x) (lambda (x) (* x 2))) 5)")).toBe("(5 10)");
  });

  it("mapv / filterv — map/filter with a vector result", async () => {
    const isVector = async (src: string) => (await bareExecState(src)).values[0];
    const v1 = (await isVector("(mapv (lambda (x) (* x x)) (list 1 2 3))")) as { constructor: { name: string } };
    expect(v1.constructor.name).toBe("AVector");
    expect(await str("(vector->list (mapv (lambda (x) (* x x)) (list 1 2 3)))")).toBe("(1 4 9)");
    expect(await str("(vector->list (filterv (lambda (x) (> x 1)) (list 1 2 3)))")).toBe("(2 3)");
  });

  it("conj — prepends onto a list (successive items land at the front), appends onto a vector", async () => {
    expect(await str("(conj (list 1 2 3) 4 5)")).toBe("(5 4 1 2 3)");
    expect(await str("(vector->list (conj (vector 1 2 3) 4))")).toBe("(1 2 3 4)");
  });

  it("into — pours from's elements into to via conj", async () => {
    expect(await str("(into '() (list 1 2 3))")).toBe("(3 2 1)");
    expect(await str("(vector->list (into (vector) (list 1 2 3)))")).toBe("(1 2 3)");
  });

  it("rest — cdr that tolerates a non-pair instead of erroring", async () => {
    expect(await str("(rest (list 1 2 3))")).toBe("(2 3)");
    expect(await str("(rest '())")).toBe("()");
  });

  it("empty? — #t iff the list/string/vector/dict has no elements", async () => {
    // `(if X "yes" "no")` normalizes over the boxed-ABool-vs-raw-JS-boolean
    // representation quirk (null?/pair? return boxed #t/#f; = returns a raw JS
    // boolean) — both are scheme-truthy/falsy either way, `if` doesn't care.
    const truthy = async (src: string) => str(`(if ${src} "yes" "no")`);
    expect(await truthy("(empty? '())")).toBe("yes");
    expect(await truthy("(empty? (list 1))")).toBe("no");
    expect(await truthy('(empty? "")')).toBe("yes");
    expect(await truthy('(empty? "x")')).toBe("no");
    expect(await truthy("(empty? (vector))")).toBe("yes");
    expect(await truthy("(empty? (dict))")).toBe("yes");
    expect(await truthy("(empty? (dict :a 1))")).toBe("no");
  });

  it("first / curry are ALREADY bound elsewhere — not redefined here", async () => {
    expect(await str("(first (list 1 2 3))")).toBe("1"); // SRFI-1, srfi-1.ts
    expect(await str("((curry (lambda (a b) (+ a b)) 1) 2)")).toBe("3"); // srfi-235.ts
  });
});
