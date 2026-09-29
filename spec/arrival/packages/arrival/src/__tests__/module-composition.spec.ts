/**
 * Tests for AmbientRuntime Module Composition System
 *
 * Tests the composable module system where:
 * - Modules form an environment chain (first = base, last = top)
 * - Resolution order per module: bindings → resolvers → parent
 * - Resolvers can yield by returning undefined
 *
 * These tests call `_lookupWithResolvers` — production surface
 * (`Resolver.ts`, `Capabilities.ts`, `LexicalScope.ts`, `common/capability.ts`).
 * Resolvers live on `ResolvingAmbient` only; construction targets that type
 * at the layers that register resolvers.
 */
import { describe, expect, it } from "vitest";
import { AmbientRuntime, ResolvingAmbient } from "../env/AmbientRuntime.js";
import type { ResolverSpec } from "../common/scheme-env.js";
import { AExact } from "../values/primitives/AExact.js";
import { CONSTANT_CTX } from "../run/RunContext.js";
import { nil } from "../values/primitives/ANil.js";

// The boxed sentinel a resolver answers with (resolvers box at their own boundary now).
const FOUND = new AExact(42);

const lookup = (env: AmbientRuntime, name: string) => env._lookupWithResolvers(name);

describe("AmbientRuntime Module Composition", () => {
  describe("Resolver Yielding", () => {
    it("should try multiple resolvers in order until one returns a value", () => {
      const callOrder: string[] = [];

      const resolver1: ResolverSpec = {
        id: "resolver-1",
        resolve: (name) => {
          callOrder.push("resolver-1");
          return undefined;
        },
      };

      const resolver2: ResolverSpec = {
        id: "resolver-2",
        resolve: (name) => {
          callOrder.push("resolver-2");
          return name === "target" ? FOUND : undefined;
        },
      };

      const env = ResolvingAmbient.root("test");
      env.registerResolver(resolver1);
      env.registerResolver(resolver2);

      expect(lookup(env, "target")).toBe(FOUND);
      expect(callOrder).toEqual(["resolver-1", "resolver-2"]);
    });

    // INVARIANT: a resolver returning undefined "yields" (search continues); returning
    // any other defined value — including a found NIL — stops the search (pins
    // implementation, not behavior). Post-hermetic-ruling the raw JS `null` sentinel is
    // out of the resolver contract (boxed values only); `nil` is its in-contract twin.
    it("should distinguish between undefined (yield) and a found nil (found)", () => {
      const resolver: ResolverSpec = {
        id: "nil-resolver",
        resolve: (name) => (name === "nil-value" ? nil : undefined),
      };

      const env = ResolvingAmbient.root("test");
      env.registerResolver(resolver);

      // nil is a valid FOUND value, should not continue searching
      expect(lookup(env, "nil-value")).toBe(nil);
    });
  });

  describe("_lookupWithResolvers", () => {
    it("should implement correct per-module resolution order", () => {
      // Bindings AND resolver answers are boxed SchemeValues — the hermetic ruling's
      // resolver contract: a resolver boxes at its own boundary, so the walk hands the
      // evaluator boxed values on every path.
      const Y = new AExact(2);
      const W = new AExact(4);
      const env = ResolvingAmbient.root("parent", { x: new AExact(1) });
      env.registerResolver({
        id: "parent-resolver",
        resolve: (name) => (name === "y" ? Y : undefined),
      });

      const child = env.child("child", { z: new AExact(3) });
      child.registerResolver({
        id: "child-resolver",
        resolve: (name) => (name === "w" ? W : undefined),
      });

      expect(child._lookupWithResolvers("z")).toEqual(new AExact(3));

      expect(child._lookupWithResolvers("w")).toBe(W);

      expect(child._lookupWithResolvers("x")).toEqual(new AExact(1));

      expect(child._lookupWithResolvers("y")).toBe(Y);

      expect(child._lookupWithResolvers("not-found")).toBe(undefined);
    });
  });
});
