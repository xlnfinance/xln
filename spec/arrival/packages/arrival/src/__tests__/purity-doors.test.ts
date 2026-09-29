// RETIRED (M6 doors MVP hygiene) — fully absorbed into
// `doors/purity.law.test.ts`, which is the single F6 purity law table
// (dynamics + multi-return + assignment + mutators, including list-set! /
// string-copy! / append! / bytevector-fill! / promise? that this file never
// covered). Delete this stub once no external reference remains.
import { describe, it } from "vitest";

describe.skip("purity-doors (absorbed into doors/purity.law.test.ts)", () => {
  it("retired", () => {});
});
