import { describe, expect, it } from "vitest";
import { assertSingleLoad, DuplicateModuleLoadError } from "../single-load.js";

describe("assertSingleLoad", () => {
  it("throws DuplicateModuleLoadError on a second evaluation of the same module id", () => {
    const id = `test/single-load/${Date.now()}-${Math.random()}`;
    assertSingleLoad(id);
    expect(() => assertSingleLoad(id)).toThrow(DuplicateModuleLoadError);
    expect(() => assertSingleLoad(id)).toThrow(/evaluated twice in this isolate/);
  });

  it("does not confuse two distinct module ids", () => {
    const a = `test/single-load/a/${Date.now()}-${Math.random()}`;
    const b = `test/single-load/b/${Date.now()}-${Math.random()}`;
    assertSingleLoad(a);
    expect(() => assertSingleLoad(b)).not.toThrow();
  });
});
