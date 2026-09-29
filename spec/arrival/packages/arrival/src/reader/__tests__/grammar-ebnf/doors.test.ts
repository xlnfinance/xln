import { describe, expect, it } from "vitest";

import { DOORS } from "./fixtures/doors.js";
import { readerAccepts, readerErrorCode } from "./reader-accepts.js";

describe("reader doors stay doors (CFG may over-accept; doors teach)", () => {
  it.each(DOORS)("$name · $code", async ({ input, code }) => {
    expect(await readerAccepts(input), `door moved — Parser now accepts ${JSON.stringify(input)}`).toBe(false);
    const got = await readerErrorCode(input);
    expect(got).toBe(code);
  });
});
