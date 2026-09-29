// Boxing track S10: a boxed vector/bytevector must NOT leak its {kind,__vector__,
// provenance} object shape across the Scheme→JS boundary (the MCP/trace
// serialization path), and provenance must propagate through a vector's elements
// (the whole point of boxing — goal (b)). Locks the rosetta toJS/jsToScheme +
// deepProvenance vector handling. (docs/plan-2026-06-10-boxing-track.md.)
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../run/RunContext.js";
import { AValue } from "../values/primitives/AValue.js";
import { AExact } from "../values/primitives/AExact.js";
import { ABytevector } from "../values/primitives/ABytevector.js";
import { AVector } from "../values/primitives/AVector.js";
import { jsToScheme, toJS } from "../membrane/rosetta.js";

// The interpreter is monadic-boxed: a vector's payload is SchemeValue[], so an
// integer element IS an AExact (the boxer routes a safe-int JS number to
// `new AExact(n, 1)` — boxing.ts, RATIO-rework §0.2: num/denom are safe-int
// `number`s, not `bigint`). toJS unwraps each AExact back to its JS number,
// so the `.toEqual([1, 2, 3])` round-trip is unchanged.
const ex = (n: number) => new AExact(n);

describe("boxed vector/bytevector — Scheme→JS serialization (toJS)", () => {
  it("a boxed vector unwraps to a raw JS array (no object leak)", () => {
    const v = new AVector([ex(1), ex(2), ex(3)]);
    expect(toJS(v)).toEqual([1, 2, 3]);
    expect(Array.isArray(toJS(v))).toBe(true);
  });

  it("a nested boxed vector unwraps recursively", () => {
    const v = new AVector([new AVector([ex(1), ex(2)]), ex(3)]);
    expect(toJS(v)).toEqual([[1, 2], 3]);
  });

  it("a boxed bytevector unwraps to its Uint8Array", () => {
    const bv = new ABytevector(Uint8Array.from([4, 5, 6]));
    const out = toJS(bv);
    expect(out).toBeInstanceOf(Uint8Array);
    // Cast: `AUnwrap<T>` (values/types.ts) has no `ABytevector` arm — falls through to
    // `unknown` — even though ABytevector's `arrival/toJS` documents "ABytevector → raw
    // Uint8Array" (a source-type gap, not fixed here per I1 scope: flagged separately).
    // The `toBeInstanceOf` assertion above is the runtime proof this narrows honestly.
    expect([...(out as Uint8Array)]).toEqual([4, 5, 6]);
  });
});

describe("boxed vector — provenance propagation (jsToScheme)", () => {
  it("deep-stamps element provenance, keeps it a vector", () => {
    const v = new AVector([ex(1), ex(2), ex(3)]);
    const prov = new Set<number>([42]);
    const stamped = jsToScheme(CONSTANT_CTX, v, {}, prov) as AVector;
    expect(stamped).toBeInstanceOf(AVector);
    expect([...stamped.provenance]).toEqual([42]);
    for (const el of stamped.__vector__) {
      expect(el).toBeInstanceOf(AValue);
      expect([...(el as AValue).provenance]).toEqual([42]);
    }
  });
});
