/**
 * v0.2 — the FIELD / lens carrier (design
 * arrival/packages/arrival-provenance/docs/static-lineage-v02-lens-carrier.md
 * §"The carrier", §"The viz constraint", "Decisions resolved"). Proves the new
 * `field` LineageNode — the static form of trace.ts's runtime field-point — and
 * that it:
 *   - NORMALIZES every member-read surface syntax (`(:foo x)` / `(@ x :foo)` /
 *     `(car x)` / `(vector-ref x i)`) to ONE canonical node + step;
 *   - ABSORBS a field-under-field to base + innermost step (D-v02-1, mirroring
 *     trace.ts:351-352 — no nested-key path);
 *   - stays NEUTRAL for the teleological fullCone (a field over x yields x's cone,
 *     byte-identical to the pre-v0.2 pipe classification — the v0.1 shadow, which
 *     skips `(:field …)` heads, is unaffected);
 *   - DEMAND-AS-PROJECTION (fieldCone, D-v02-2): demanding one field follows the
 *     matching field child and prunes the siblings — no explicit optic needed;
 *   - composes with a FAN without unrolling (fan×lens, §"The viz constraint"): a
 *     field projected inside a fan template nests UNDER the fan; a field over the
 *     fan wraps it — the single `[number][field]` parametric wire the v02-G6 viz
 *     reads.
 *
 * DR5: assert via the tree structure (.kind/.step) and fullCone/fieldCone, never
 * equal?. ADDITIVE — the serial core (computeProvenance / AValue.provenance) is
 * untouched; its retirement is a later phase.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import {
  classify,
  fullCone,
  countCone,
  fieldCone,
  type Classifier,
  type LineageNode,
} from "../../provenance/lineage.js";

const C: Classifier = {
  // `dict` carries no declared role here — falls through to the pure-application
  // default, so the fan×lens body classifies as a constructor merge.
  roleOf: (op) =>
    ["infer", "fetch", "db-read"].includes(op)
      ? "source"
      : ["map", "filter", "vector-map"].includes(op)
        ? "fan"
        : ["ext-call"].includes(op)
          ? "opaque"
          : undefined,
};

async function skeleton(src: string): Promise<LineageNode> {
  const [ast] = await parse(src);
  return classify(ast, C); // STATIC — no execution
}

// ── NORMALIZATION — every surface accessor → ONE canonical field node ─────────
describe("lineage field — member-read syntaxes normalize to a canonical `field` node", () => {
  it("(:foo x) → field{step:{field:'foo'}} over leaf(x) (keyword accessor)", async () => {
    const n = await skeleton(`(:foo x)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "foo" });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });

  it("(@ x :foo) → the SAME canonical field node (membrane.readMember, keyword key)", async () => {
    const n = await skeleton(`(@ x :foo)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    // Canonical step is identical to `(:foo x)` — the head differs, the node does not.
    expect(n.step).toEqual({ field: "foo" });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });

  it("(@ x \"foo\") → field{field:'foo'} (string key is the same canonical step)", async () => {
    const n = await skeleton(`(@ x "foo")`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "foo" });
  });

  it("(@ x 1) → field{step:{index:1}} (a LITERAL int membrane key is a positional step)", async () => {
    // memberRead's `@` arm: a non-symbol, non-pair key whose valueOf is an integer takes
    // the `literalIndex` branch (lineage.ts:201-202) → {index:1}, the same canonical
    // positional step `(vector-ref x 1)` produces. (The only `@`-return arm with no
    // dedicated coverage before this.)
    const n = await skeleton(`(@ x 1)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ index: 1 });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });

  it("(car x) → field{step:{car:true}} over leaf(x)", async () => {
    const n = await skeleton(`(car x)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ car: true });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });

  it("(vector-ref x 1) → field{step:{index:1}} over leaf(x) (literal index)", async () => {
    const n = await skeleton(`(vector-ref x 1)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ index: 1 });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });

  it("(list-ref x 2) → field{step:{index:2}} (list-ref shares the index step)", async () => {
    const n = await skeleton(`(list-ref x 2)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ index: 2 });
  });

  it("a VARIABLE index is NOT a static field: (vector-ref x n) stays a pure op (pipe/merge)", async () => {
    // The key isn't known statically (no literal), so there's no field node — the
    // form falls through to the pure-op arity cut (here: pipe over leaf(x); `n` is
    // also a leaf → merge). Either way: NOT a field.
    const n = await skeleton(`(vector-ref x n)`);
    expect(n.kind).not.toBe("field");
  });

  it("(@ x k) with a COMPUTED key is NOT a static field — falls through to a pure op", async () => {
    const n = await skeleton(`(@ x k)`);
    expect(n.kind).not.toBe("field");
  });

  it("cdr / cadr / rest stay PIPES, not fields (sound over-approximation)", async () => {
    // Consumers only ever pin keyword/car/index fields; cdr-family is left as a
    // pass-through pipe (the design's named boundary).
    const cdr = await skeleton(`(cdr x)`);
    expect(cdr).toEqual({ kind: "pipe", op: "cdr", child: { kind: "leaf", slot: "x" } });
    const cadr = await skeleton(`(cadr x)`);
    expect(cadr.kind).not.toBe("field");
  });
});

// ── ABSORPTION (D-v02-1) — field under field collapses to base + innermost ────
describe("lineage field — nested projection ABSORBS to base + INNERMOST step", () => {
  it("(:a (:b x)) → field{step:'b'} over leaf(x) — the outer :a is absorbed (NOT a 2-deep path)", async () => {
    // Mirrors trace.ts:351-352: a re-projection is a deeper pluck within the SAME
    // producer pin; keep the inner key as the producer port, do not compose a path.
    const n = await skeleton(`(:a (:b x))`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "b" }); // INNERMOST step
    expect(n.child).toEqual({ kind: "leaf", slot: "x" }); // base — NOT a field{:a, field{:b, …}}
  });

  it("absorption is KEYWORD-PRIORITY across syntaxes: a keyword pins over a transparent positional step", async () => {
    // (car (:b x)): the inner KEYWORD `:b` wins — a keyword anywhere in the chain is
    // the pin (the live minter is blind to the outer `car`). Innermost keyword.
    const carOverField = await skeleton(`(car (:b x))`);
    expect(carOverField.kind).toBe("field");
    if (carOverField.kind === "field") expect(carOverField.step).toEqual({ field: "b" });

    // (@ (car x) :a): the OUTER keyword `:a` over a transparent positional `car` child
    // now pins `{field:"a"}` (NOT `{car}`) — keyword-priority makes the static carrier
    // agree with the live field-point minter, which ignores `car` and pins the keyword.
    const fieldOverCar = await skeleton(`(@ (car x) :a)`);
    expect(fieldOverCar.kind).toBe("field");
    if (fieldOverCar.kind !== "field") return;
    expect(fieldOverCar.step).toEqual({ field: "a" }); // keyword wins over positional
    // The 2-DEEP structure (lineage.ts:352 keeps `child` as the transparent positional
    // node, NOT a bare leaf): the outer keyword node wraps the inner `field{car}` node.
    // This diverges from the FLAT runtime field-point pin (which absorbs car→null and
    // surfaces only "a"); pinning the nested shape here guards the static carrier against
    // a regression that flattened the child to `leaf(x)`.
    expect(fieldOverCar.child).toEqual({
      kind: "field",
      op: "car",
      step: { car: true },
      child: { kind: "leaf", slot: "x" },
    });
  });

  it("triple nesting (:a (:b (:c x))) absorbs to the single innermost step :c", async () => {
    const n = await skeleton(`(:a (:b (:c x)))`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "c" });
    expect(n.child).toEqual({ kind: "leaf", slot: "x" });
  });

  it("POSITIONAL over positional (car (vector-ref x 0)): no keyword to pin → keep the INNER positional, drop the outer car", async () => {
    // lineage.ts:353 — the field-under-field arm with NO keyword anywhere: neither the
    // outer `car` step nor the inner `index` step is a `field`, so `return child` keeps
    // the INNERMOST member-read (`vector-ref`'s {index:0}) and discards the outer `car`.
    // (NOT null — that prior expectation was wrong; the code returns the inner node.)
    const n = await skeleton(`(car (vector-ref x 0))`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.op).toBe("vector-ref"); // the inner node's surface head, not the outer `car`
    expect(n.step).toEqual({ index: 0 }); // INNERMOST positional kept
    expect(n.child).toEqual({ kind: "leaf", slot: "x" }); // base = leaf, the outer car absorbed
  });

  it("KEYWORD over index (:a (vector-ref x 0)): the keyword wraps the transparent positional child (2-deep)", async () => {
    // lineage.ts:352 — the inner child is a positional `field{index:0}` (not a keyword),
    // and the OUTER step IS a keyword, so the keyword pins ON TOP of the transparent
    // positional: a field{:a} node whose child is the field{index:0} node (2-deep).
    const n = await skeleton(`(:a (vector-ref x 0))`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "a" }); // outer keyword pins
    expect(n.child).toEqual({
      kind: "field",
      op: "vector-ref",
      step: { index: 0 }, // the transparent positional child, kept NESTED under the keyword
      child: { kind: "leaf", slot: "x" },
    });
  });

  it("INDEX over keyword (vector-ref (:b x) 0): the inner keyword wins, the outer index is absorbed", async () => {
    // lineage.ts:351 — the inner child is a keyword `field{:b}`, so `"field" in child.step`
    // fires: `return child`. The outer `index` step is dropped (a keyword anywhere wins the
    // pin), leaving field{:b} directly over leaf(x).
    const n = await skeleton(`(vector-ref (:b x) 0)`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.op).toBe(":b"); // the inner keyword node's head, not the outer `vector-ref`
    expect(n.step).toEqual({ field: "b" }); // inner keyword pin
    expect(n.child).toEqual({ kind: "leaf", slot: "x" }); // base = leaf, outer index absorbed
  });
});

// ── NEUTRALITY — fullCone of a field == fullCone of the pre-v0.2 pipe ──────────
describe("lineage field — fullCone is NEUTRAL vs the pre-change pipe classification", () => {
  it("fullCone((:foo x)) == x's cone — the teleological query is unchanged", async () => {
    const field = await skeleton(`(:foo x)`);
    // Before v0.2, `(:foo x)` classified as pipe{:foo}→leaf(x); both yield x's cone.
    expect(fullCone(field, { x: [42] })).toEqual([42]);
  });

  it("fullCone over a deeper expr is identical to the pipe form: (* v1 (:foo v2))", async () => {
    const n = await skeleton(`(* v1 (:foo v2))`);
    // (:foo v2) is a field (pipe-equivalent for the cone); the merge unions v1 + v2.
    expect(fullCone(n, { v1: [100], v2: [200] })).toEqual([100, 200]);
  });

  it("absorbed (:a (:b x)) still yields x's full cone (neutral after absorption)", async () => {
    const n = await skeleton(`(:a (:b x))`);
    expect(fullCone(n, { x: [7] })).toEqual([7]);
  });
});

// ── DEMAND-AS-PROJECTION (D-v02-2) — fieldCone prunes siblings ─────────────────
describe("lineage field — fieldCone descends the matching field, prunes the siblings", () => {
  it("demanding the SAME field follows it: fieldCone((:foo x), {field:'foo'}) == x's cone", async () => {
    const n = await skeleton(`(:foo x)`);
    expect(fieldCone(n, { x: [42] }, { field: "foo" })).toEqual([42]);
  });

  it("demanding a DIFFERENT field prunes it: fieldCone((:foo x), {field:'bar'}) == [] (sibling complement)", async () => {
    const n = await skeleton(`(:foo x)`);
    expect(fieldCone(n, { x: [42] }, { field: "bar" })).toEqual([]);
  });

  it("a merge is a DEMAND BARRIER (M2): a field demand cannot be attributed to one child — full cone", async () => {
    // (cons (:foo a) (:bar b)) — `cons` is a fan-in producing a FRESH value, so a
    // `:foo` demand reaching the merge cannot be statically attributed to one child
    // (no genesis labels yet — that is v02-G6). The sound move (M2) is the full cone:
    // the demand is DROPPED at the barrier and both children contribute. Distributing
    // the demand into the children (the old walkField behavior) was the M2 bug —
    // re-projecting `:foo` into each child asks "which inputs feed child.:foo", which
    // is the wrong question (the children are not the field; the merge IS the producer).
    const n = await skeleton(`(cons (:foo a) (:bar b))`);
    expect(n.kind).toBe("merge");
    expect(fieldCone(n, { a: [1], b: [2] }, { field: "foo" })).toEqual([1, 2]); // barrier: both children
    expect(fieldCone(n, { a: [1], b: [2] }, { field: "bar" })).toEqual([1, 2]); // barrier: both children
    expect(fieldCone(n, { a: [1], b: [2] }, { field: "absent" })).toEqual([1, 2]); // a demand the merge can't satisfy still falls back
    expect(fullCone(n, { a: [1], b: [2] })).toEqual([1, 2]); // teleological — same as the barrier fallback
  });

  it("an OPAQUE head is ALSO a demand barrier (walk merge/opaque share the M2 case): a field demand drops to the full cone", async () => {
    // walk()'s `case "merge": case "opaque":` is shared (lineage.ts:559-568): an opaque
    // black-box is a fan-in to a fresh value just like a merge, so a field demand reaching
    // it cannot be attributed to one child — the demand is DROPPED and every child walks the
    // full cone. Only `merge` was covered before; `ext-call` (the classifier's lone opaque)
    // exercises the opaque arm of the same barrier.
    const n = await skeleton(`(ext-call (:foo a) (:bar b))`);
    expect(n.kind).toBe("opaque");
    expect(fieldCone(n, { a: [1], b: [2] }, { field: "foo" })).toEqual([1, 2]); // barrier: both children, demand dropped
    expect(fieldCone(n, { a: [1], b: [2] }, { field: "bar" })).toEqual([1, 2]); // barrier: both children
    expect(fieldCone(n, { a: [1], b: [2] }, { field: "absent" })).toEqual([1, 2]); // unsatisfiable demand → full cone fallback
    expect(fullCone(n, { a: [1], b: [2] })).toEqual([1, 2]); // teleological == the barrier fallback
  });

  it("a MUX is NOT a barrier: a field demand CROSSES the `if` into BOTH arms and still FILTERS them", async () => {
    // walk()'s `case "mux"` (lineage.ts:570-578) carries the demand into the selector AND
    // every arm (unlike merge/opaque, which DROP it): an arm IS the value, not an input to a
    // fresh genesis, so the projection is the arm's own projection. The designed contrast to
    // the merge barrier: a MATCHING demand reaches both arms; a NON-matching demand PRUNES
    // them (a barrier would ignore the demand and return both children either way).
    const n = await skeleton(`(if p (:foo a) (:foo b))`);
    expect(n.kind).toBe("mux");
    // The selector leaf (`p`) is always walked (a leaf ignores the demand) — it is the
    // constant `[9]` across both demands, isolating the arm toggling.
    const b = { p: [9], a: [1], b: [2] };
    expect(fieldCone(n, b, { field: "foo" })).toEqual([1, 2, 9]); // demand matches both arms → both flow (+ selector)
    expect(fieldCone(n, b, { field: "zzz" })).toEqual([9]); // demand crosses in and PRUNES both arms (not a barrier)
    expect(fullCone(n, b)).toEqual([1, 2, 9]); // teleological: selector ∪ both arms
  });

  it("an index demand is distinct from a field demand of the same name-shape", async () => {
    const n = await skeleton(`(vector-ref x 1)`);
    expect(fieldCone(n, { x: [9] }, { index: 1 })).toEqual([9]); // matched
    expect(fieldCone(n, { x: [9] }, { index: 2 })).toEqual([]); // wrong index — pruned
    expect(fieldCone(n, { x: [9] }, { field: "1" })).toEqual([]); // field≠index — pruned
  });
});

// ── FAN × LENS (§"The viz constraint") — field nests under the fan, no unroll ──
describe("lineage field — fan × lens composes PARAMETRICALLY (the z-axis is preserved)", () => {
  it("field-INSIDE-fan: (map (lambda (it) (:bar it)) xs) keeps the field NESTED in the fan template", async () => {
    const n = await skeleton(`(map (lambda (it) (:bar it)) xs)`);
    expect(n.kind).toBe("fan");
    if (n.kind !== "fan") return;
    expect(n.lengthPreserving).toBe(true);
    expect(n.source).toEqual({ kind: "leaf", slot: "xs" }); // the z-stack source, NOT unrolled
    // The per-element field lives in the template — the parametric [number][:bar] path.
    expect(n.template).toBeDefined();
    expect(n.template).toEqual({
      kind: "field",
      op: ":bar",
      step: { field: "bar" },
      child: { kind: "leaf", slot: "it" }, // the element binder
    });
  });

  it("field-OVER-fan wraps it: (:foo (map (lambda (it) (:bar it)) xs)) = field{:foo}→fan→template field{:bar}", async () => {
    // The single `[number][field]` wire the v02-G6 viz reads: source[number][:bar]
    // → result[number][:foo], carried as ONE parametric shape (field over fan over
    // field-in-template), never N unrolled element wires.
    const n = await skeleton(`(:foo (map (lambda (it) (:bar it)) xs))`);
    expect(n.kind).toBe("field");
    if (n.kind !== "field") return;
    expect(n.step).toEqual({ field: "foo" }); // result projection
    expect(n.child.kind).toBe("fan"); // the fan axis survives under the outer field
    if (n.child.kind !== "fan") return;
    expect(n.child.source).toEqual({ kind: "leaf", slot: "xs" });
    expect(n.child.template).toEqual({
      kind: "field",
      op: ":bar",
      step: { field: "bar" },
      child: { kind: "leaf", slot: "it" },
    });
  });

  it("the v0.2 dict shape (map (lambda (it) (dict :foo (:bar it))) xs) carries the inner field nested", async () => {
    // The canonical example from the proposal: the per-element template is a dict
    // construction whose `:bar` projection of the element is a field node nested
    // inside it (NOT flattened away) — the carrier-shaping constraint.
    const n = await skeleton(`(map (lambda (it) (dict :foo (:bar it))) xs)`);
    expect(n.kind).toBe("fan");
    if (n.kind !== "fan") return;
    expect(n.template?.kind).toBe("merge");
    if (n.template?.kind !== "merge") return;
    const innerField = n.template.children.find((ch) => ch.kind === "field");
    expect(innerField).toEqual({
      kind: "field",
      op: ":bar",
      step: { field: "bar" },
      child: { kind: "leaf", slot: "it" },
    });
  });

  it("a BARE function symbol fan carries NO template — byte-identical to the pre-v0.2 fan", async () => {
    // (map infer xs) — no lambda, so no template key. This guards the additive
    // promise: existing fans (lineage-spike's (map infer xs)) are untouched.
    const n = await skeleton(`(map infer xs)`);
    expect(n.kind).toBe("fan");
    if (n.kind !== "fan") return;
    expect(n.template).toBeUndefined();
    expect(n.introduces).toBe(true); // infer mints
    // Cones unchanged from lineage-spike.
    expect(fullCone(n, { xs: [10], infer: [20] })).toEqual([10, 20]);
    expect(countCone(n, { xs: [10], infer: [20] })).toEqual([10]);
  });

  it("field-over-fan fullCone is still the source cone (the field walk descends only the focus)", async () => {
    // The outer field over the fan does not collapse the fan axis for the cone: the
    // teleological query reaches the fan's source (xs). The template is viz-only.
    const n = await skeleton(`(:foo (map (lambda (it) (:bar it)) xs))`);
    expect(fullCone(n, { xs: [10] })).toEqual([10]);
  });

  it("a PRESENT template is cone-NEUTRAL: fullCone/countCone equal the template-less twin (walk never descends template)", async () => {
    // The defining additive promise (walk never descends n.template), asserted THROUGH
    // the cone, not just the structure: a template-bearing fan and the same fan with the
    // template stripped yield byte-identical fullCone AND countCone. A regression that
    // descended `template` (e.g. counting the body's `:bar it` leaf) would diverge here.
    const withTemplate = await skeleton(`(map (lambda (it) (:bar it)) xs)`);
    expect(withTemplate.kind).toBe("fan");
    if (withTemplate.kind !== "fan") return;
    expect(withTemplate.template).toBeDefined(); // the lambda built a per-element template
    // The template-less twin: the same fan node with `template` removed (structurally
    // identical to a bare-symbol fan over the same source/op/flags).
    const { template: _t, ...withoutTemplate } = withTemplate;
    const b = { xs: [10, 11] };
    expect(fullCone(withTemplate, b)).toEqual(fullCone(withoutTemplate, b)); // [10,11] either way
    expect(fullCone(withTemplate, b)).toEqual([10, 11]); // = the source cone (lambda body mints nothing)
    expect(countCone(withTemplate, b)).toEqual(countCone(withoutTemplate, b)); // map → pruned identically
    expect(countCone(withTemplate, b)).toEqual([10, 11]); // map count = source cone; the per-element prune drops only the introduce (none here)
  });
});
