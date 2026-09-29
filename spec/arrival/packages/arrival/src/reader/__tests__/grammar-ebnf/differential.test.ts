import { describe, expect, it } from "vitest";

import { ACCEPT } from "./fixtures/accept.js";
import { harvestPolyglotInputs } from "./harvest.js";
import { arrivalGrammar } from "./load.js";
import { matchGrammar } from "./match.js";
import { readerAccepts } from "./reader-accepts.js";

/**
 * Law: every string the loose Parser reads as a complete program is in the eBNF.
 * Over-accept is allowed. Over-reject is a bug in grammar.ebnf.
 */
describe("Parser.accepts ⇒ eBNF.accepts", () => {
  const g = arrivalGrammar();

  it("hand corpus (reader-success rows)", async () => {
    const misses: string[] = [];
    for (const { name, input } of ACCEPT) {
      if (!(await readerAccepts(input))) continue;
      if (!matchGrammar(g, input).ok) misses.push(name);
    }
    expect(misses, `over-reject ${misses.join(", ")}`).toEqual([]);
  });

  it("polyglot spec inputs the reader accepts", async () => {
    const g2 = arrivalGrammar();
    const misses: string[] = [];
    const harvested = harvestPolyglotInputs();
    expect(harvested.length).toBeGreaterThan(40);
    let accepted = 0;
    for (const { file, input } of harvested) {
      if (!(await readerAccepts(input))) continue;
      accepted++;
      if (!matchGrammar(g2, input).ok) misses.push(`${file}: ${JSON.stringify(input)}`);
    }
    expect(accepted).toBeGreaterThan(20);
    expect(misses, `over-reject\n${misses.join("\n")}`).toEqual([]);
  });
});
