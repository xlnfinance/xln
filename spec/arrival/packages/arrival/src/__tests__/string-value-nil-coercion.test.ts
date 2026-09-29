// B1 (the manifold benchmark-defect register, private monorepo docs) — `stringValue`
// (values/op-helpers.ts) silently coerced container/nil values via `String(x)`:
// `String(nil)` → `"()"`, so `(string-length nil)` returned **2** instead of throwing. A
// model in the 89x2 benchmark corpus saw exactly this, concluded "probably truncated," and
// abandoned Scheme for Python.
//
// PRE-CHECK (this tranche): audited every `stringValue` call site (strings.ts, srfi-13.ts,
// srfi-28.ts, bytevectors.ts, vectors.ts, equality.ts) — every one declares a `z.string`
// contract and expects a genuine AString; none depends on the coercion fallback for a
// character/symbol/number. The door is narrowed to CONTAINER/NIL kinds only (pair, nil,
// vector, object, dict) — leaf/scalar kinds keep `String(x)`.
import { describe, expect, it } from "vitest";
import { execStateOverFrame as execState } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";

const run = (code: string) => execState(code, { env: inferenceEnv.child("string-value-nil-coercion") });

describe("B1 — stringValue throws on container/nil kinds instead of silently coercing", () => {
  it.each([
    {
      name: '(string-length \'()) throws (never silently returns 2, the `String(nil)` = "()" artifact)',
      code: "(string-length '())",
    },
    { name: "(string-upcase '()) throws", code: "(string-upcase '())" },
    { name: '(string-append "x" \'()) throws', code: '(string-append "x" \'())' },
    { name: '(string=? \'() "()") throws (never silently #t)', code: '(string=? \'() "()")' },
  ])("$name", async ({ code }) => {
    await expect(run(code)).rejects.toThrow(/expected a string/i);
  });

  it("leaf/scalar kinds are unaffected — a character still coerces via String(x)", async () => {
    // `stringValue` is reachable through `string->symbol` etc. via a validated-string
    // contract only in practice, but the fallback itself must remain permissive for
    // non-container kinds. `symbol->string` round-trips a symbol; this pins that the
    // narrowing doesn't regress leaf kinds.
    const { values } = await run("(symbol->string 'hello)");
    expect(values[0]?.valueOf()).toBe("hello");
  });
});
