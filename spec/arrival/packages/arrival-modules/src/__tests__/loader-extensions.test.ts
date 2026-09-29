// The file-type resolver registry behind (require/register-extension): by-name mapping,
// longest-suffix match, idempotent register / conflict-throw. Every run's registry is
// its own per-`RunContext` `Map` (`LoaderRunResources.extensionResolvers`). This file
// re-pins `registerExtensionIn` / `lookupExtensionResolverIn` against a fresh `Map`
// per test — no shared table to reset.
import { describe, expect, it, beforeEach } from "vitest";

import {
  lookupExtensionResolverIn,
  registerExtensionIn,
  type ExtensionResolverRegistry,
} from "../loader-extensions.js";

let registry: ExtensionResolverRegistry;
beforeEach(() => {
  registry = new Map();
});

describe("registerExtensionIn / lookupExtensionResolverIn", () => {
  it("maps a suffix to a resolver verb NAME and looks it up by path", () => {
    registerExtensionIn(registry, ".hbs", "handlebars/lambda");
    expect(lookupExtensionResolverIn(registry, "templates/card.hbs")).toBe("handlebars/lambda");
    expect(lookupExtensionResolverIn(registry, "data/x.json")).toBeUndefined();
  });

  it("normalizes a dot-less suffix", () => {
    registerExtensionIn(registry, "toml", "toml/parse");
    expect(lookupExtensionResolverIn(registry, "config.toml")).toBe("toml/parse");
  });

  it("longest matching suffix wins (.spec.json beats .json)", () => {
    registerExtensionIn(registry, ".json", "data/json");
    registerExtensionIn(registry, ".spec.json", "spec/parse");
    expect(lookupExtensionResolverIn(registry, "a.json")).toBe("data/json");
    expect(lookupExtensionResolverIn(registry, "a.spec.json")).toBe("spec/parse");
  });

  it("re-registering the SAME mapping is an idempotent no-op", () => {
    registerExtensionIn(registry, ".prompt", "prompt/compile");
    expect(() => registerExtensionIn(registry, ".prompt", "prompt/compile")).not.toThrow();
    expect(lookupExtensionResolverIn(registry, "x.prompt")).toBe("prompt/compile");
  });

  it("a CONFLICTING name for an already-claimed suffix throws", () => {
    registerExtensionIn(registry, ".prompt", "prompt/compile");
    expect(() => registerExtensionIn(registry, ".prompt", "other/compile")).toThrow(
      /already handled by "prompt\/compile"/,
    );
  });
});

// The `(require/register-extension)` verb itself (the baked `symbol.macro` def, bound at both
// its bootstrap and mid-run sites) is no longer unit-tested against a hand-rolled host here — it
// has no imperative host-fn bind helper left to drive in isolation; both real bind
// sites live in `loader-capability.ts` and are exercised end-to-end by
// the arrival-chain register-extension prelude-overlay test (private monorepo).
