// srfi-13-contract-precision.test.ts — HARVEST-signature precision for srfi-13's Contract-bearing
// ops (the `Contract.type` author-assertion axis; see srfi-1-contract-precision.test.ts's header for
// the axis distinction). Three ops get an override; the other fifteen are already precise and are
// left alone (a regression guard below asserts a representative sample stays zod-derived).
//
// The three overridden ops all share the same root defect: an op that genuinely returns / consumes a
// LIST-OF-STRINGS, but whose zod contract can only spell the list slot as `z.schemeValue` (→ `unknown`) —
// scheme-zod has no element-typed list schema — so the harvest loses the element type. The author
// knows it: each impl `to_array`s / `APair.fromArray`s strings. `List<string>` (from carriers.ts's
// ambient vocabulary) is the honest, informative image.
//   • string-join     — `z.schemeValue` list input → `unknown`; `z.union([z.string,z.schemeString])` output
//                        → the redundant `string | string`. Both collapse to `(list: List<string>,
//                        delimiter?: string) => string`.
//   • string-tokenize — `z.schemeValue` output → `unknown`, but it returns a proper list of token strings.
//   • string-split    — `z.schemeValue` output → `unknown` (list of pieces); the `string | char` delimiter
//                        images to the redundant `string | string` (both print `string`).
import { describe, expect, it } from "vitest";
import srfi13 from "../srfi-13.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(srfi13.spec.symbols);
function def(name: string): AEntity {
  const d = symbols[name];
  if (d === undefined) throw new Error(`srfi-13 pack: no symbol named ${name}`);
  return d;
}

describe("scheme/srfi-13 Contract harvest precision — author-asserted `type:` recovers the List-of-string domain z.schemeValue erases", () => {
  it("string-join: List<string> input (was z.schemeValue → unknown) + string output (was the redundant string | string)", () => {
    expect(signatureOf(def("string-join"))).toBe("(list: List<string>, delimiter?: string) => string");
  });

  it("string-tokenize: List<string> output (was z.schemeValue → unknown — it returns a proper list of token strings)", () => {
    expect(signatureOf(def("string-tokenize"))).toBe("(str: string, criterion?: unknown) => List<string>");
  });

  it("string-split: List<string> output (was z.schemeValue → unknown) + string delimiter (was the redundant string | string)", () => {
    expect(signatureOf(def("string-split"))).toBe("(str: string, delimiter: string) => List<string>");
  });
});

describe("scheme/srfi-13 Contract harvest precision — already-precise ops stay zod-derived (regression guard: no redundant override)", () => {
  it("string-null? / string-prefix? / string-reverse keep their exact zod-computed signatures", () => {
    // A precise scalar-in/scalar-out op needs NO override — adding one would be a duplicate source of
    // truth (the very drift risk this pass avoids). These read straight off the zod schema.
    expect(signatureOf(def("string-null?"))).toBe("(a: string) => boolean");
    expect(signatureOf(def("string-prefix?"))).toBe("(a: string, b: string) => boolean");
    expect(signatureOf(def("string-reverse"))).toBe("(a: string) => string");
  });

  // `z.exact`/`z.schemeNumber` decode/encode plain `number`, not `bigint | number`.
  // `string-take`/`string-index`/`string-count` carry a `type:` author override
  // (a `dedent` interface-call-signature block, not a bare arrow). `string-index`/
  // `string-count` spell criterion as a char OR a one-arg predicate — `unknown`
  // would misread a bare `string`.
  it("string-take / string-index / string-count carry a `type:` override (dedent interface block, not a bare arrow signature)", () => {
    expect(signatureOf(def("string-take"))).toBe("{\n  (s: string, n: number): string;\n}");
    // string-index / string-count keep `criterion` spelled as "a char or one-arg predicate" in
    // the override prose: the membrane genuinely accepts a char OR a one-arg predicate, and a
    // char's TS image (`string`) would misread as "a whole string".
    expect(signatureOf(def("string-index"))).toBe(
      "{\n  (s: string, criterion: string | ((c: string) => unknown)): number | false;\n}",
    );
    expect(signatureOf(def("string-count"))).toBe(
      "{\n  (s: string, criterion: string | ((c: string) => unknown)): number;\n}",
    );
  });
});
