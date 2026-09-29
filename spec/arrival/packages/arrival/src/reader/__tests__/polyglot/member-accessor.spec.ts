// Fresh accessor-mechanic cases (corpus's (:key …) cases stay in curly-braces.spec.ts as dict-feature probes).
import { describe, expect, it } from "vitest";
import { evalJson, errorClass } from "./_harness.js";

describe("member-accessor / (:key …) accessor mechanics", () => {
  // POSITIVE — eval: input evaluates to value
  it.each([
    { name: "y_accessor_basic_hit", input: "(:a {:a 1})", value: 1 },
    { name: "y_accessor_miss_is_nil", input: "(:b {:a 1})", value: null },
    { name: "y_accessor_is_first_class_fn", input: "((lambda (f) (f {:a 7})) :a)", value: 7 },
    { name: "y_accessor_chains", input: "(:a (:b {:b {:a 9}}))", value: 9 },
    { name: "y_accessor_on_string_key", input: '(:x {"x" 5})', value: 5 },
  ])("eval · $name", async ({ input, value }) => {
    expect(await evalJson(input)).toEqual(value);
  });

  // DOORS — accessor on a non-dict operand throws, but not through a stable
  // `.code` (errorClass(e) is undefined on this path — the "no members to
  // read" message is a plain Error, not an ArrivalError with a door code).
  // Assert only that it errors, matching curly-braces.spec.ts's any-error
  // convention for codeless doors.
  it.each([{ name: "n_accessor_on_non_dict_operand", input: "(:a 5)" }])(
    "door any-error · $name",
    async ({ input }) => {
      let err: unknown;
      try {
        await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected any error, but succeeded").toBeDefined();
      expect(errorClass(err)).toBeUndefined();
    },
  );
});
