import { describe, expect, it } from "vitest";
import { testCallCtx } from "@inhuman.tools/arrival";

import { RunResolverUnreachableError } from "../errors.js";
import { runResolverOf } from "../loader.js";

describe("runResolverOf", () => {
  it("throws RunResolverUnreachableError when CallCtx has no resolver", () => {
    expect(() => runResolverOf(testCallCtx(), "require")).toThrow(RunResolverUnreachableError);
  });
});
