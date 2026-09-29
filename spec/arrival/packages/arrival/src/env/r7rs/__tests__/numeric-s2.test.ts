// square / exact-integer-sqrt / rationalize — R7RS §6.2.6 S2 gaps filled.
import { describe, expect, it } from "vitest";
import { exec } from "../../../eval/generator-exec.js";

describe("R7RS numeric S2", () => {
  it("square", async () => {
    expect((await exec("(square 12)"))[0]).toBe(144);
    expect((await exec("(square 1.5)"))[0]).toBe(2.25);
  });

  it("exact-integer-sqrt returns (s . r) pair product", async () => {
    expect((await exec("(car (exact-integer-sqrt 10))"))[0]).toBe(3);
    expect((await exec("(cdr (exact-integer-sqrt 10))"))[0]).toBe(1);
    expect((await exec("(car (exact-integer-sqrt 16))"))[0]).toBe(4);
    expect((await exec("(cdr (exact-integer-sqrt 16))"))[0]).toBe(0);
  });

  it("rationalize finds a simple rational in the band", async () => {
    // classic: (rationalize (exact 1/3) 1/10) → 1/3 or nearby simple form
    const [v] = await exec("(rationalize 1/3 1/10)");
    expect(Number(v)).toBeCloseTo(1 / 3, 5);
  });
});
