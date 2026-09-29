/**
 * TYPE-LEVEL: path producers (queries/effects) are CrossingContract-only.
 * ContourContract (native/sequence/define) excess-property-checks refuse them.
 * Annotated `Contract<…>` values remain assignable to ContourContract.
 */
import { describe, test } from "vitest";
import { EnvCapability } from "../capability.js";
import type { Contract, ContourContract, CrossingContract } from "../symbols/_bake.js";
import * as z from "../scheme-zod/index.js";

describe("resource-path producers — type placement", () => {
  test("queries on native must NOT compile", () => {
    EnvCapability.define("test/cqs-type-native-q", {
      symbols: (symbol) => ({
        bad: symbol.native`bad-n-q: `(
          {
            input: [z.schemeValue],
            output: [z.schemeValue],
            // @ts-expect-error — queries?/effects? are rosetta-only (CrossingContract)
            queries: () => [["x"]],
          },
          (v) => v,
        ),
      }),
    });
  });

  test("effects on sequence must NOT compile", () => {
    EnvCapability.define("test/cqs-type-seq-e", {
      symbols: (symbol) => ({
        bad: symbol.sequence`bad-s-e: `(
          {
            input: [z.schemeValue],
            output: [z.schemeValue],
            // @ts-expect-error — path producers are rosetta-only
            effects: () => [["x"]],
          },
          (args) => args[0],
        ),
      }),
    });
  });

  test("sink + queries must NOT compile (ruling 2026-08-13)", () => {
    EnvCapability.define("test/cqs-type-sink-q", {
      symbols: (symbol) => ({
        bad: symbol.rosetta`bad-sink-q: `(
          // @ts-expect-error — sink cannot declare queries (impl skipped under gather)
          {
            input: [z.string],
            output: [z.undefinedResult],
            provenance: "sink",
            queries: (s: string) => [["d", s]],
          },
          () => undefined,
        ),
      }),
    });
  });

  test("effects-only with a real return must NOT compile (return licensed by Q)", () => {
    EnvCapability.define("test/cqs-type-e-only-ret", {
      symbols: (symbol) => ({
        bad: symbol.rosetta`bad-e-ret: `(
          // @ts-expect-error — effects-only must be void-family; declare the Q path or void the output
          {
            input: [z.string],
            output: [z.string],
            effects: (s: string) => [["d", s]],
          },
          (s) => s,
        ),
      }),
    });
  });

  test("void effects-only and hybrid-with-return compile clean", () => {
    EnvCapability.define("test/cqs-type-e-void-h-ret", {
      symbols: (symbol) => ({
        writer: symbol.rosetta`ok-e-void: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            effects: (s: string) => [["d", s]],
          },
          () => undefined,
        ),
        upsert: symbol.rosetta`ok-h-ret: `(
          {
            input: [z.string],
            output: [z.string],
            queries: (s: string) => [["d", s]],
            effects: (s: string) => [["d", s]],
          },
          (s) => s,
        ),
      }),
    });
  });

  test("sink + effects compiles clean (a sink IS an effect)", () => {
    EnvCapability.define("test/cqs-type-sink-e", {
      symbols: (symbol) => ({
        ok: symbol.rosetta`ok-sink-e: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            provenance: "sink",
            effects: (s: string) => [["d", s]],
          },
          () => undefined,
        ),
      }),
    });
  });

  test("queries+effects on rosetta compile clean", () => {
    EnvCapability.define("test/cqs-type-rosetta-ok", {
      symbols: (symbol) => ({
        ok: symbol.rosetta`ok-r: `(
          {
            input: [z.string],
            output: [z.string],
            queries: (s: string) => [["d", s]],
            effects: (s: string) => [["d", s]],
          },
          (s) => s,
        ),
      }),
    });
  });

  test("annotated Contract without path fields is assignable to ContourContract", () => {
    const c: Contract<[typeof z.schemeValue], [typeof z.schemeValue]> = {
      input: [z.schemeValue],
      output: [z.schemeValue],
    };
    const contour: ContourContract<[typeof z.schemeValue], [typeof z.schemeValue]> = c;
    void contour;
  });

  test("CrossingContract may carry path producers", () => {
    const c: CrossingContract<[typeof z.string], [typeof z.string]> = {
      input: [z.string],
      output: [z.string],
      queries: (s: string) => [["d", s]],
    };
    void c;
  });
});
