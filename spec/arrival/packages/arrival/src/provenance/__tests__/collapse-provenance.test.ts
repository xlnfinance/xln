/**
 * Provenance soundness for the value-COLLAPSING ops (string-append / join).
 *
 * Collapsing a structure of inference-stamped values into one flat string destroys
 * the members the trace would walk; `collapseProvenance` must deep-walk and hoist
 * EVERY reachable point so field-to-field wiring survives the collapse. A gap here
 * is a SILENT provenance hole (no error, just a missing edge), so each structured
 * carrier gets a pin. See provenance-collapse.ts.
 */
import { describe, it, expect } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { collapseProvenance } from "../../provenance/provenance-collapse.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { AString } from "../../values/primitives/AString.js";
import { AVector } from "../../values/primitives/AVector.js";
import { APair } from "../../values/primitives/APair.js";
import { AJSArray } from "../../membrane/AJSArray.js";
import { nil } from "../../values/primitives/ANil.js";
import { requireEagerOracle } from "../../__tests__/_require-eager-oracle.js";

// this helper/execState needs the eager oracle ON
requireEagerOracle();

const stamped = (s: string, ...points: number[]) => new AString(s, new Set(points));
const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);

describe("collapseProvenance — sound over every structured carrier", () => {
  it("collects a bare AValue's own points", () => {
    expect(sorted(collapseProvenance(stamped("a", 1, 2)))).toEqual([1, 2]);
  });

  it("deep-walks a Pair list spine", () => {
    const list = new APair(stamped("a", 1), new APair(stamped("b", 2), nil));
    expect(sorted(collapseProvenance(list))).toEqual([1, 2]);
  });

  it("deep-walks a SchemeVector's elements (the gap a flat union missed)", () => {
    const vec = new AVector([stamped("a", 1), stamped("b", 2)]);
    expect(sorted(collapseProvenance(vec))).toEqual([1, 2]);
  });

  // A BORROWED array's source holds JS-WORLD VALUES ONLY (V's hygiene law — `JSWorldArray`,
  // values/types.ts), so its elements carry NO lineage of their own: the container's own provenance
  // — the crossing that made it — is the whole signal, and the deep walk finds nothing further.
  // (The old form put boxed AStrings in the store and asserted their per-element ids. Production
  // cannot construct that value, and reading such an element would have had `jsToScheme` re-stamp it
  // with the container's provenance anyway — so the ids it pinned were a fiction.)
  it("a borrowed array grounds in its CONTAINER's provenance — raw JS elements have none of their own", () => {
    const arr = new AJSArray(["a", "b"], new Set([1, 2]));
    expect(sorted(collapseProvenance(arr))).toEqual([1, 2]);
  });

  it("deep-walks a raw JS array", () => {
    expect(sorted(collapseProvenance([stamped("a", 1), stamped("b", 2)]))).toEqual([1, 2]);
  });

  it("unions across multiple args and nested structures", () => {
    const nested = new APair(stamped("a", 1), new APair(new AVector([stamped("b", 2)]), nil));
    expect(sorted(collapseProvenance(stamped("sep", 9), nested))).toEqual([1, 2, 9]);
  });

  it("is idempotent (never mints fresh ids) and cycle-safe", () => {
    expect(sorted(collapseProvenance(stamped("a", 1), stamped("a", 1)))).toEqual([1]);
    const cyclic: unknown[] = [stamped("a", 1)];
    cyclic.push(cyclic); // self-reference — the occurs-check must not loop
    expect(sorted(collapseProvenance(cyclic))).toEqual([1]);
  });
});

describe("string-append / join carry deep collapse-provenance end-to-end", () => {
  it("join over a list of stamped values keeps every point", async () => {
    const env = inferenceEnv.child("collapse-prov-join") as EnvWithInternals<ResolvingAmbient>;
    env.bind("a", stamped("alpha", 1));
    env.bind("b", stamped("beta", 2));
    // execState (COMPLEX tier): asserts box discipline + provenance (RULINGS.md R1).
    const [r] = (await execState(`(join "," (list a b))`, { env })).values;
    expect(r).toBeInstanceOf(AString);
    expect(sorted((r as AString).provenance as Set<number>)).toEqual([1, 2]);
  });

  it("string-append over a nested collapse keeps every point", async () => {
    const env = inferenceEnv.child("collapse-prov-append") as EnvWithInternals<ResolvingAmbient>;
    env.bind("a", stamped("alpha", 1));
    env.bind("b", stamped("beta", 2));
    const [r] = (await execState(`(string-append "x:" (join "," (list a b)))`, { env })).values;
    expect(r).toBeInstanceOf(AString);
    expect(sorted((r as AString).provenance as Set<number>)).toEqual([1, 2]);
  });
});
