import { describe, expect, it } from "vitest";

import { ACCEPT } from "./fixtures/accept.js";
import { arrivalGrammar } from "./load.js";
import { matchGrammar } from "./match.js";
import { readerAccepts } from "./reader-accepts.js";

describe("eBNF accepts the loose-reader corpus", () => {
  const g = arrivalGrammar();

  it.each(ACCEPT)("$name", async ({ input }) => {
    expect(await readerAccepts(input), `Parser rejected ${JSON.stringify(input)}`).toBe(true);
    const got = matchGrammar(g, input);
    expect(got.ok, `eBNF rejected at ${got.pos} in ${JSON.stringify(input)}`).toBe(true);
  });
});
