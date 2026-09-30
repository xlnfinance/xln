import { describe, expect, test } from "bun:test";
import { none, orElse, some } from "./option.ts";

describe("kernel/option", () => {
  test("a value is read as itself and absence as the fallback, even a falsy value", () => {
    expect(orElse(some(0), 7)).toBe(0);
    expect(orElse(some(""), "x")).toBe("");
    expect(orElse(none, 7)).toBe(7);
  });
});
