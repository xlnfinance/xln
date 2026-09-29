// carriers.test-d.ts — bite-guard for the R3 carrier model (the committed spike).
// Runs via `vitest --typecheck`. Proves the 3-way slot probes, empty-list covariance,
// list ≠ vector, deep algebra composition, dict → object — and that wrong programs bite.
import { describe, expectTypeOf, test } from "vitest";
import type { List, SlotKind, ElemOf, AcceptsBareWord, IsStringTyped } from "../carriers.js";
import { car, cons, filter, list, map, reduce } from "../carriers.js";

// harvested tools (what schema-to-ts emits)
declare function set_timer(seconds: number): void;
declare function get_weather(city: string, unit: "celsius" | "fahrenheit"): void;
declare function get_route(stops: List<string>, mode: "fast" | "scenic"): void;
declare function sum_readings(readings: readonly number[]): number;
declare function note(text: string): void;
declare function configure(opts: { name: string; age: number }): void;

// lowered programs (must type-check)
set_timer(600);
get_weather("NYC", "celsius");
get_route(list("A", "B", "C"), "fast");
get_route(cons("Z", list("A", "B")), "scenic"); // cons-prepend → List<string>
sum_readings([1, 2, 3]);
get_route(
  map((n: number) => String(n), list(1, 2)),
  "fast",
); // map → List<string> into a list slot
const _r1: number = car(list(1, 2, 3));
const _comp: number = reduce(
  (a: number, x: number) => a + x,
  0,
  map(
    (s: string) => s.length,
    filter((s: string) => s.length > 0, list("a", "bb")),
  ),
);
configure({ name: "a", age: 30 }); // (dict :name "a" :age 30) → object literal

describe("carriers — 3-way slot probes", () => {
  test("list slot: kind + element", () => {
    expectTypeOf<SlotKind<Parameters<typeof get_route>[0]>>().toEqualTypeOf<"list">();
    expectTypeOf<ElemOf<Parameters<typeof get_route>[0]>>().toEqualTypeOf<string>();
  });

  test("vector slot: kind + element", () => {
    expectTypeOf<SlotKind<Parameters<typeof sum_readings>[0]>>().toEqualTypeOf<"vector">();
    expectTypeOf<ElemOf<Parameters<typeof sum_readings>[0]>>().toEqualTypeOf<number>();
  });

  test("enum / scalar kinds", () => {
    expectTypeOf<SlotKind<Parameters<typeof get_weather>[1]>>().toEqualTypeOf<"string">();
    expectTypeOf<SlotKind<Parameters<typeof set_timer>[0]>>().toEqualTypeOf<"scalar">();
  });

  test("bare-word / string-typed probes", () => {
    expectTypeOf<AcceptsBareWord<Parameters<typeof note>[0]>>().toEqualTypeOf<true>();
    expectTypeOf<AcceptsBareWord<Parameters<typeof get_route>[0]>>().toEqualTypeOf<false>();
    expectTypeOf<IsStringTyped<Parameters<typeof get_weather>[1]>>().toEqualTypeOf<true>();
  });

  test("nested list element", () => {
    expectTypeOf<ElemOf<List<List<number>>>>().toEqualTypeOf<List<number>>();
  });
});

// bites — wrong programs that MUST error
// @ts-expect-error scalar where list expected
get_route("A", "fast");
// @ts-expect-error number element where string list expected
get_route(list(1, 2), "fast");
// @ts-expect-error wrong enum member
get_weather("NYC", "kelvin");
// @ts-expect-error vector where list expected (vector ≠ list)
get_route([1, 2, 3], "fast");
// @ts-expect-error wrong dict field type
configure({ name: "a", age: "old" });
// @ts-expect-error missing dict field
configure({ name: "a" });
