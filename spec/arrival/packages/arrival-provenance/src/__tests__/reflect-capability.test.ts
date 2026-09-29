// reflect-capability.test.ts — assemble arrivalReflectCapability onto the standard base and assert
// each provenance verb binds.

import { describe, expect, it } from "vitest";

import { execState } from "@inhuman.tools/arrival";
import { symbolsOwnedBy } from "@inhuman.tools/arrival/host-internals";
import { arrivalReflectCapability } from "../reflect/capability.js";

describe("arrivalReflectCapability", () => {
  it("binds every provenance verb", async () => {
    const { runCtx } = await execState("(begin)", { capabilities: [arrivalReflectCapability] });
    const owned = symbolsOwnedBy(runCtx, arrivalReflectCapability);
    for (const verb of ["why", "where", "how", "dag", "blast", "result-value"]) {
      expect(owned.has(verb)).toBe(true);
    }
  });
});
