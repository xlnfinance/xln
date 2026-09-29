/**
 * LAW — resource path producers are rosetta-only (suite S2).
 * Natives / sequences cannot declare queries? / effects?.
 */
import { describe, it, expect } from "vitest";
import * as z from "../../common/scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import {
  ResourcePathDeclarationError,
  ResourcePathRoleConflictError,
  ResourcePathShapeError,
} from "../resource-paths.js";

describe("resource-path bake (S2)", () => {
  it("P-BAKE-OK — rosetta with Q only / E only / both defines", () => {
    expect(() =>
      symbol.rosetta`rp-q: `(
        {
          input: [z.string],
          output: [z.string],
          queries: (s) => [["d", s]],
        },
        (s) => s,
      ),
    ).not.toThrow();

    expect(() =>
      symbol.rosetta`rp-e: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          effects: (s) => [["d", s]],
        },
        () => undefined,
      ),
    ).not.toThrow();

    expect(() =>
      symbol.rosetta`rp-both: `(
        {
          input: [z.string],
          output: [z.string],
          queries: (s) => [["d", s]],
          effects: (s) => [["d", s]],
        },
        (s) => s,
      ),
    ).not.toThrow();
  });

  /**
   * N-Q-SHAPE (ruling 2026-08-13): a queries-declaring contract must be
   * serializable on BOTH vectors — the whole point of `queries: (...args) =>
   * StringTuple[]` is forcing resource naming into serializable, accessible
   * form (point at an external resource by id / well-known name). An unkeyable
   * arg (z.dynamic / z.lambda) would crash `runCacheKey` at the path-Q
   * view-elevation the moment ANY cache is armed. Bake door, mirroring the
   * `view` shape gate.
   */
  it("N-Q-SHAPE — queries-declaring contract with unkeyable slots bake-doors", () => {
    // z.dynamic input — decoded arg is an arbitrary raw value, no stable key
    expect(() =>
      symbol.rosetta`rp-q-dyn-in: `(
        {
          input: [z.dynamic],
          output: [z.string],
          queries: () => [["d"]],
        },
        () => "x",
      ),
    ).toThrow(ResourcePathShapeError);

    // z.lambda input — a callable is not a resource pointer
    expect(() =>
      symbol.rosetta`rp-q-lam-in: `(
        {
          input: [z.lambda],
          output: [z.string],
          queries: () => [["d"]],
        },
        (() => "x") as never,
      ),
    ).toThrow(ResourcePathShapeError);

    // output side — the Q value-cache entry must serialize too
    expect(() =>
      symbol.rosetta`rp-q-dyn-out: `(
        {
          input: [z.string],
          output: [z.dynamic],
          queries: (s) => [["d", s]],
        },
        ((s: string) => s) as never,
      ),
    ).toThrow(ResourcePathShapeError);

    // hybrid is gated through its Q half
    expect(() =>
      symbol.rosetta`rp-h-dyn-in: `(
        {
          input: [z.dynamic],
          output: [z.string],
          queries: () => [["d"]],
          effects: () => [["d"]],
        },
        () => "x",
      ),
    ).toThrow(ResourcePathShapeError);

    // A-CTRL: effects-only with a dynamic slot stays legal (no keyed storage)
    expect(() =>
      symbol.rosetta`rp-e-dyn-in: `(
        {
          input: [z.dynamic],
          output: [z.undefinedResult],
          effects: () => [["d"]],
        },
        () => undefined,
      ),
    ).not.toThrow();
  });

  /**
   * N-SINK-WITH-Q (ruling 2026-08-13): provenance and path axes are orthogonal
   * INTERPRETERS, but some combinations are contradictions — a sink's body is
   * SKIPPED under gather, so a declared Q would journal a read and arm a
   * subscription for an impl that never ran. sink+effects stays legal (a sink
   * IS an effect).
   */
  it("N-SINK-WITH-Q — sink cannot declare queries; sink+effects legal", () => {
    expect(() =>
      symbol.rosetta`rp-sink-q: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          provenance: "sink",
          queries: (s: string) => [["d", s]],
        } as never,
        () => undefined,
      ),
    ).toThrow(ResourcePathRoleConflictError);

    // hybrid-on-sink is the same contradiction (Q half)
    expect(() =>
      symbol.rosetta`rp-sink-h: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          provenance: "sink",
          queries: (s: string) => [["d", s]],
          effects: (s: string) => [["d", s]],
        } as never,
        () => undefined,
      ),
    ).toThrow(ResourcePathRoleConflictError);

    // A-CTRL: sink + effects bakes clean
    expect(() =>
      symbol.rosetta`rp-sink-e: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          provenance: "sink",
          effects: (s: string) => [["d", s]],
        },
        () => undefined,
      ),
    ).not.toThrow();
  });

  /**
   * N-E-ONLY-RETURN (ruling 2026-08-13, from V's upsert chunk): the E+Q mixing
   * exists to make upsert-with-return possible — the RETURN of an effectful verb
   * is licensed by its Q half. Effects-only with a real return claims to mint
   * world data it never declared reading: declare the query path (hybrid) or
   * void the output.
   */
  it("N-E-ONLY-RETURN — effects-only with a real return bake-doors; hybrid return legal", () => {
    // INSERT-RETURNING shape without declaring what it reads back — incoherent
    expect(() =>
      symbol.rosetta`rp-e-ret: `(
        {
          input: [z.string],
          output: [z.string],
          effects: (s: string) => [["d", s]],
        } as never,
        ((s: string) => s) as never,
      ),
    ).toThrow(ResourcePathRoleConflictError);

    // A-CTRL 1: upsert-with-return IS the licensed shape
    expect(() =>
      symbol.rosetta`rp-h-ret: `(
        {
          input: [z.string],
          output: [z.string],
          queries: (s: string) => [["d", s]],
          effects: (s: string) => [["d", s]],
        },
        (s: string) => s,
      ),
    ).not.toThrow();

    // A-CTRL 2: void effects-only writer stays legal (fires + ARM2 logs; no dual-key)
    expect(() =>
      symbol.rosetta`rp-e-void: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          effects: (s: string) => [["d", s]],
        },
        () => undefined,
      ),
    ).not.toThrow();
  });

  it("N-I9 — native cannot declare Q / E / both", () => {
    expect(() =>
      symbol.native`rp-nat-q: `(
        {
          input: [z.schemeValue],
          output: [z.schemeValue],
          queries: () => [["x"]],
        } as any,
        (x) => x,
      ),
    ).toThrow(ResourcePathDeclarationError);

    expect(() =>
      symbol.native`rp-nat-e: `(
        {
          input: [z.schemeValue],
          output: [z.schemeValue],
          effects: () => [["x"]],
        } as any,
        (x) => x,
      ),
    ).toThrow(ResourcePathDeclarationError);

    expect(() =>
      symbol.native`rp-nat-both: `(
        {
          input: [z.schemeValue],
          output: [z.schemeValue],
          queries: () => [["x"]],
          effects: () => [["x"]],
        } as any,
        (x) => x,
      ),
    ).toThrow(ResourcePathDeclarationError);
  });

  it("N-I9 — sequence cannot declare path axes (Q / E / both)", () => {
    expect(() =>
      symbol.sequence`rp-seq-q: `(
        {
          input: [z.schemeValue],
          output: [z.schemeValue],
          queries: () => [["x"]],
        } as any,
        (args) => args[0],
      ),
    ).toThrow(ResourcePathDeclarationError);

    expect(() =>
      symbol.sequence`rp-seq-e: `(
        {
          input: [z.schemeValue],
          output: [z.schemeValue],
          effects: () => [["x"]],
        } as any,
        (args) => args[0],
      ),
    ).toThrow(ResourcePathDeclarationError);

    expect(() =>
      symbol.sequence`rp-seq-both: `(
        {
          input: [z.schemeValue],
          output: [z.schemeValue],
          queries: () => [["x"]],
          effects: () => [["x"]],
        } as any,
        (args) => args[0],
      ),
    ).toThrow(ResourcePathDeclarationError);
  });

  it("N-I9 — define cannot declare path axes", () => {
    expect(() =>
      symbol.define`rp-def-q: `(
        {
          input: [z.schemeValue],
          output: [z.schemeValue],
          queries: () => [["x"]],
        } as any,
        "(lambda (s) s)",
      ),
    ).toThrow(ResourcePathDeclarationError);

    expect(() =>
      symbol.define`rp-def-e: `(
        {
          input: [z.schemeValue],
          output: [z.schemeValue],
          effects: () => [["x"]],
        } as any,
        "(lambda (s) s)",
      ),
    ).toThrow(ResourcePathDeclarationError);
  });

  it("N-I9 — declaration error is contract-shape, not other", () => {
    try {
      symbol.native`rp-cat: `(
        {
          input: [z.schemeValue],
          output: [z.schemeValue],
          queries: () => [["x"]],
        } as any,
        (x) => x,
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ResourcePathDeclarationError);
      expect((err as ResourcePathDeclarationError)["arrival/error-category"]).toBe("contract-shape");
    }
  });
});
