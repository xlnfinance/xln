import { describe, expect, it } from "vitest";

import { REJECT } from "./fixtures/reject.js";
import { arrivalGrammar } from "./load.js";
import { matchGrammar } from "./match.js";
import { readerAccepts } from "./reader-accepts.js";

describe("eBNF rejects structural illegal programs", () => {
  const g = arrivalGrammar();

  it.each(REJECT)("$name", async ({ input }) => {
    expect(await readerAccepts(input), `Parser accepted ${JSON.stringify(input)} — move off REJECT`).toBe(false);
    const got = matchGrammar(g, input);
    expect(got.ok, `eBNF accepted ${JSON.stringify(input)}`).toBe(false);
  });
});
