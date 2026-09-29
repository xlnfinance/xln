import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { arrivalGrammar } from "./load.js";
import { matchGrammar } from "./match.js";
import { readerAccepts } from "./reader-accepts.js";

const ATOMS = [
  "0",
  "1",
  "-3",
  "3.14",
  ".5",
  "1/2",
  "+inf.0",
  "foo",
  "null?",
  "->",
  ":k",
  "#:name",
  "#t",
  "#f",
  "#true",
  "#false",
  "#null",
  '"hi"',
  '"a\\nb"',
  "#\\space",
  "|Picnic Tables|",
  "@",
  "@keys",
];

function pick<T>(xs: readonly T[], n: number): T {
  return xs[n % xs.length]!;
}

function genDatum(depth: number, seed: number): string {
  if (depth <= 0 || seed % 5 === 0) return pick(ATOMS, seed);
  const n = 1 + (seed % 3);
  const kids = Array.from({ length: n }, (_, i) => genDatum(depth - 1, (seed * 17 + i * 13) >>> 0));
  switch (seed % 7) {
    case 1:
      return `(${kids.join(" ")})`;
    case 2:
      return `[${kids.join(" ")}]`;
    case 3:
      return `[${kids.join(", ")}]`;
    case 4: {
      const pairs: string[] = [];
      for (let i = 0; i < n; i++) pairs.push(`:k${i}`, kids[i]!);
      return `{${pairs.join(" ")}}`;
    }
    case 5:
      return `'${kids[0]}`;
    default:
      return `#( ${kids.join(" ")} )`;
  }
}

const DELIM_ALPHABET = [
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "'",
  ",",
  "@",
  ".",
  "#",
  "|",
  '"',
  ";",
  "\\",
  "`",
  "a",
  "1",
  ":",
  " ",
  "\n",
] as const;

describe("generated programs: Parser and eBNF both accept", () => {
  const g = arrivalGrammar();

  it("short strings over the delimiter alphabet", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: fc.constantFrom(...DELIM_ALPHABET), maxLength: 5 }), async (input) => {
        if (!(await readerAccepts(input))) return;
        const got = matchGrammar(g, input);
        expect(got.ok, `over-reject ${JSON.stringify(input)} at ${got.pos}`).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("random balanced programs from the atom/compound generator", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2_147_483_647 }), async (seed) => {
        const input = Array.from({ length: 1 + (seed % 3) }, (_, i) => genDatum(1 + (seed % 3), seed + i * 99)).join(
          "\n",
        );
        expect(await readerAccepts(input), `Parser rejected generated ${JSON.stringify(input)}`).toBe(true);
        const got = matchGrammar(g, input);
        expect(got.ok, `eBNF rejected generated ${JSON.stringify(input)} at ${got.pos}`).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
