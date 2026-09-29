import { describe, it, expect } from "vitest";
import { exec } from "../../../eval/generator-exec.js";

describe("nil? aliases null?", () => {
  it("agrees on nil and non-empty list", async () => {
    const [v] = await exec(`(list (null? nil) (nil? nil) (null? (list 1)) (nil? (list 1)))`);
    expect(v).toEqual([true, true, false, false]);
  });
  it("works for missing-key defaults", async () => {
    const [v] = await exec(`(if (nil? (:timeout (dict :host 1))) 30 99)`);
    expect(v).toBe(30);
  });
});
