import { describe, expect, it } from "vitest";

import { BASE_ROSTER } from "../../env/base-roster.js";
import { harvestPlaneHost } from "../harvest-plane-host.js";

describe("harvestPlaneHost — name-level skip, not scheme/* prefix", () => {
  it("binds authored-type natives PRE does not own, and skips overlay names", () => {
    const skip = new Set(["apply", "append", "map", "join", "list", "car", "cdr", "string-append"]);
    const { entries } = harvestPlaneHost(BASE_ROSTER, skip);
    const names = new Set(entries.map(([n]) => n));
    expect(names.has("apply")).toBe(false);
    expect(names.has("map")).toBe(false);
    expect(names.has("vector->list")).toBe(true);
    expect(names.has("member")).toBe(true);
    expect(names.has("string-split")).toBe(true);
    expect(names.has("string-tokenize")).toBe(true);
    const vec = entries.find(([n]) => n === "vector->list")?.[1];
    expect(vec).toMatch(/List</);
  });

  it("does not harvest names in skipNames even if the pack is scheme/*", () => {
    const { entries } = harvestPlaneHost(BASE_ROSTER, new Set(["vector->list", "member"]));
    const names = new Set(entries.map(([n]) => n));
    expect(names.has("vector->list")).toBe(false);
    expect(names.has("member")).toBe(false);
    expect(names.has("string-split")).toBe(true);
  });
});
