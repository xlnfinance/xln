// reachability.test-d.ts — bite-guard for the list-slot reachability gate (the committed spike).
// At a List slot, admit a head iff its return COULD be a list — mask only PROVABLY non-list.
// `CouldBeList` (on a resolved return type) is the gate's core logic; the `[unknown] extends [R]`
// nuke-guard keeps `if` / `car` / generic returns admissible so `(if …)` is never blocked.
import { describe, expectTypeOf, test } from "vitest";
import type { CouldBeList, List } from "../carriers.js";
import { car, cdr, list, map } from "../carriers.js";

describe("CouldBeList on RESOLVED return types — the gate's verdict", () => {
  test("list is a list", () => {
    expectTypeOf<CouldBeList<List<string>>>().toEqualTypeOf<true>();
  });

  test("(if …) branch union of lists", () => {
    expectTypeOf<CouldBeList<List<string> | List<number>>>().toEqualTypeOf<true>();
  });

  test("unknown — the nuke-guard (generic / if / car)", () => {
    expectTypeOf<CouldBeList<unknown>>().toEqualTypeOf<true>();
  });

  test("vector ≠ list (disjoint) → mask", () => {
    expectTypeOf<CouldBeList<readonly number[]>>().toEqualTypeOf<false>();
  });

  test("provably non-list → mask", () => {
    expectTypeOf<CouldBeList<number>>().toEqualTypeOf<false>();
    expectTypeOf<CouldBeList<string>>().toEqualTypeOf<false>();
  });
});

// call-site reachability — list-returning expressions fill a list slot; non-list ones bite
declare function ifList<A, B>(cond: unknown, a: A, b: B): A | B; // models (if cond a b) → A | B
declare function append<T>(a: List<T>, b: List<T>): List<T>;
declare function add(...n: number[]): number;
declare function upcase(s: string): string;
declare function get_route(stops: List<string>, mode: string): void;
declare const listOne: List<string>;
declare const listTwo: List<string>;

get_route(ifList(true, listOne, listTwo), "fast"); // (if c lo lt) → List<string> — NOT blocked
get_route(append(listOne, listTwo), "fast");
get_route(ifList(true, list("a"), cdr(map((s: string) => s, listOne))), "fast"); // deep recursion (depth 3)

declare const listOfLists: List<List<string>>;
get_route(car(listOfLists), "fast"); // car of list-of-lists → List<string>

// bites — provably-non-list heads cannot fill a list slot
// @ts-expect-error add → number, not a list
get_route(add(1, 2, 3), "fast");
// @ts-expect-error bare string is not a list
get_route(upcase("x"), "fast");
// @ts-expect-error car of list-of-strings → string, not a list
get_route(car(listOne), "fast");
