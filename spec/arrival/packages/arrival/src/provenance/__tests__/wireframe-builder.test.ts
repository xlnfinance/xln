/**
 * Q8a — WIREFRAME BUILDER CORE rows (docs/PROVENANCE.md
 * §1 "Model", §2 lowering, §3 I5). Unit rows for the builder itself; the LAW rows
 * (wire-locality at emission, I5 exterior collapse) live in
 * `src/__tests__/provenance/wireframe-agreement.law.test.ts` and flip with this
 * landing. Loop interiors (binder backedge wiring) are Q8a′ — staged `it.todo`
 * below, tagged.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { Classifier, DeclaredRole } from "../lineage.js";
import { buildWireframe } from "../wireframe/builder.js";
import type { Wire, WireframeGraph, WireframeProgram } from "../wireframe/types.js";
import { freeVars } from "../wireframe/free-vars.js";
import { reachableNodes } from "../wireframe/loops.js";
import { WireLocalityError } from "../../errors.js";

// Declared roles (Q3's shape — synthetic here; production reads `.provenanceRole`).
const ROLES: Record<string, DeclaredRole> = {
  "src-a": "source",
  "src-b": "source",
  "fetch-item": "source",
  "emit!": "sink",
  dedent: "transparent",
  map: "fan",
  filter: "fan",
  "black-box": "opaque",
};
const C: Classifier = { roleOf: (op) => ROLES[op] };

// The hermetic-base predicate — a synthetic subset of base-pack names the test
// programs use (production derives this from the sealed base chain).
const BASE = new Set([
  "+",
  "-",
  "*",
  "/",
  ">",
  "<",
  "=",
  ">=",
  "positive?",
  "not",
  "car",
  "cdr",
  "cons",
  "list",
  "length",
  "equal?",
]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string): Promise<WireframeProgram> {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: C, isBaseName });
}

const kinds = (g: WireframeGraph): string[] => g.nodes.map((n) => n.kind);
const wireTo = (g: WireframeGraph, slot: string): Wire | undefined => g.wires.find((w) => w.consumer.slot === slot);

beforeAll(async () => {});

describe("Q8a builder core — the collapse rule (§1: maximal pure subgraphs fold to ONE wire)", () => {
  it("(emit! (+ (* x x) 5)) — the pure interior is ONE wire, param = its FV, sink is the node", async () => {
    const p = await wf("(emit! (+ (* x x) 5))");
    expect(kinds(p.main)).toEqual(["sink"]); // sink egresses nothing → no out-port
    expect(p.main.egress).toBeNull();
    expect(p.main.wires).toHaveLength(1);
    const w = p.main.wires[0];
    expect(w.consumer).toEqual({ node: 0, slot: "arg0" });
    expect(w.params).toEqual(["x"]);
    expect(w.paramRefs).toEqual([{ kind: "slot", name: "x" }]);
    expect(w.source).toBe("(lambda (x) (+ (* x x) 5))");
  });

  it("two sources cut out of one pure residue — wire params reference the port nodes", async () => {
    const p = await wf("(emit! (+ (src-a) (src-b)))");
    expect(kinds(p.main).sort()).toEqual(["sink", "source", "source"]);
    const sinkIdx = p.main.nodes.findIndex((n) => n.kind === "sink");
    const w = p.main.wires.find((x) => x.consumer.node === sinkIdx);
    expect(w).toBeDefined();
    expect(w?.paramRefs.map((r) => r.kind)).toEqual(["node", "node"]);
    // the residue keeps its shape, ports replaced by minted ingress params
    expect(w?.source).toBe("(lambda (in0 in1) (+ in0 in1))");
  });

  it("the program's value flows to ONE out-port node through the egress wire", async () => {
    const p = await wf("(+ (src-a) 1)");
    expect(kinds(p.main).sort()).toEqual(["port", "source"]);
    expect(p.main.egress).not.toBeNull();
    const w = wireTo(p.main, "out");
    expect(w?.paramRefs).toEqual([
      { kind: "node", name: "in0", node: p.main.nodes.findIndex((n) => n.kind === "source") },
    ]);
    expect(w?.source).toBe("(lambda (in0) (+ in0 1))");
  });

  it("transparent is a designated crossing node (a membrane FACT), not silently a pipe", async () => {
    const p = await wf("(emit! (dedent (+ x 1)))");
    expect(kinds(p.main).sort()).toEqual(["sink", "transparent"]);
  });
});

describe("Q8a builder core — selector-cone reachability decides mux fate (§1 A2 + amendment 1)", () => {
  it("pure-selector mux collapses INTO its wire: params are the full FV set, BOTH arms' ingress (m3)", async () => {
    const p = await wf("(if (> x 0) x (- y x))");
    expect(kinds(p.main)).toEqual(["port"]); // no mux node — collapsed
    const w = wireTo(p.main, "out");
    expect(w?.params.toSorted()).toEqual(["x", "y"]); // both arms' ingress, the m3 trade
    expect(w?.source).toContain("(if (> x 0) x (- y x))");
  });

  it("a mux whose selector directly crosses a port stays EXPANDED (port-coupled)", async () => {
    const p = await wf("(if (positive? (src-a)) x y)");
    expect(kinds(p.main).sort()).toEqual(["mux", "port", "source"]);
    const muxIdx = p.main.nodes.findIndex((n) => n.kind === "mux");
    const sel = p.main.wires.find((w) => w.consumer.node === muxIdx && w.consumer.slot === "selector");
    expect(sel?.source).toBe("(lambda (in0) (positive? in0))");
    expect(sel?.paramRefs[0]).toEqual({
      kind: "node",
      name: "in0",
      node: p.main.nodes.findIndex((n) => n.kind === "source"),
    });
    const arms = p.main.wires.filter((w) => w.consumer.node === muxIdx && w.consumer.slot.startsWith("arm"));
    expect(arms).toHaveLength(2);
  });

  it("coupling threads through a let binding (classify's subst — the inlined-form equality)", async () => {
    const p = await wf("(let ((y (src-a))) (if (positive? y) 1 2))");
    expect(kinds(p.main)).toContain("mux");
  });

  it("field-step selector: (:flag (src)) couples; (:flag cfg) over a plain slot collapses (walk()'s field-arm pattern)", async () => {
    const coupled = await wf("(if (:flag (src-a)) 1 2)");
    expect(kinds(coupled.main)).toContain("mux");

    const pure = await wf("(if (:flag cfg) 1 2)");
    expect(kinds(pure.main)).not.toContain("mux");
    expect(wireTo(pure.main, "out")?.params).toEqual(["cfg"]);
  });

  it("coupling is transitive through a port-reaching define (the reachClassifier's opaque lowering)", async () => {
    const p = await wf("(define (helper x) (src-a x))\n(if (helper k) 1 2)");
    expect(p.membership.wireframe.has("helper")).toBe(true);
    expect(kinds(p.main)).toContain("mux");
    // the selector wire cut the (helper k) call to a template-ref node
    expect(kinds(p.main)).toContain("template-ref");
  });

  it("a pure mux WRAPPING a port keeps the mux in the wire and cuts only the port", async () => {
    // Selector (> x 0) is pure → the if collapses; the source in the arm is still
    // a node (a wire body structurally contains no source).
    const p = await wf("(if (> x 0) (src-a) y)");
    expect(kinds(p.main).sort()).toEqual(["port", "source"]);
    const w = wireTo(p.main, "out");
    expect(w?.source).toContain("(if (> x 0) in0 y)");
    expect(w?.params.toSorted()).toEqual(["in0", "x", "y"]);
  });
});

describe("Q8a builder core — prelude, templates, template-refs (§1 A3/M1)", () => {
  it("a pure helper stays prelude-side and is referenced BY NAME from the wire body", async () => {
    const p = await wf("(define (inc n) (+ n 1))\n(emit! (inc x))");
    expect(p.prelude.names.has("inc")).toBe(true);
    const w = p.main.wires[0];
    expect(w.source).toBe("(lambda (x) (inc x))");
    expect(w.params).toEqual(["x"]); // inc is NOT ingress — a by-name reference
  });

  it("a port-reaching define becomes a TEMPLATE; its call site is a template-ref node wired like a port", async () => {
    const p = await wf("(define (fetch-price id) (fetch-item id))\n(+ (fetch-price x) 1)");
    expect(p.membership.wireframe.has("fetch-price")).toBe(true);
    const t = p.templates.get("fetch-price");
    expect(t).toBeDefined();
    expect(t?.params).toEqual(["id"]);
    expect(t?.graph.nodes.map((n) => n.kind).sort()).toEqual(["port", "source"]);
    // the template's source node receives `id` — the define's own formal, a slot
    const argWire = t?.graph.wires.find((w) => w.consumer.slot === "arg0");
    expect(argWire?.paramRefs).toEqual([{ kind: "slot", name: "id" }]);

    const refIdx = p.main.nodes.findIndex((n) => n.kind === "template-ref");
    expect(refIdx).toBeGreaterThanOrEqual(0);
    const call = p.main.nodes[refIdx];
    expect(call.kind === "template-ref" && call.name).toBe("fetch-price");
    expect(wireTo(p.main, "out")?.paramRefs).toEqual([{ kind: "node", name: "in0", node: refIdx }]);
  });

  it("a program of only defines has an empty main graph (egress null)", async () => {
    const p = await wf("(define (inc n) (+ n 1))");
    expect(p.main.nodes).toHaveLength(0);
    expect(p.main.egress).toBeNull();
  });
});

describe("Q8a builder core — fans are region hosts (§3 I5)", () => {
  it("a lambda callback's body becomes the region's PRIVATE template interior — its ports never enter G", async () => {
    const p = await wf("(length (map (lambda (v) (+ (fetch-item v) 1)) xs))");
    expect(kinds(p.main).sort()).toEqual(["fan", "port"]); // ONE node from G — no interior leak
    const fan = p.main.nodes.find((n) => n.kind === "fan");
    if (fan?.kind !== "fan") throw new Error("expected a fan node");
    expect(fan.lengthPreserving).toBe(true);
    expect(fan.elementParams).toEqual(["v"]);
    expect(fan.template).toBeDefined();
    expect(fan.template?.nodes.map((n) => n.kind).sort()).toEqual(["port", "source"]);
    // the fanned container arrives on the "source" slot
    const src = p.main.wires.find((w) => w.consumer.slot === "source");
    expect(src?.paramRefs).toEqual([{ kind: "slot", name: "xs" }]);
  });

  it("a template wire's slot beyond elementParams is a region CAPTURE by name (sealed ingress, I2)", async () => {
    const p = await wf("(length (map (lambda (v) (+ v scale)) xs))");
    const fan = p.main.nodes.find((n) => n.kind === "fan");
    if (fan?.kind !== "fan") throw new Error("expected a fan node");
    const egressWire = fan.template?.wires.find((w) => w.consumer.slot === "out");
    expect(egressWire?.params.toSorted()).toEqual(["scale", "v"]);
    // `scale` is a capture: a slot param, NOT an inlined value, NOT a G-node ref
    expect(egressWire?.paramRefs.every((r) => r.kind === "slot")).toBe(true);
  });

  it("filter is a length-CHANGING fan; a bare-symbol callback records fnOp with no template", async () => {
    const p = await wf("(length (filter positive? xs))");
    const fan = p.main.nodes.find((n) => n.kind === "fan");
    if (fan?.kind !== "fan") throw new Error("expected a fan node");
    expect(fan.lengthPreserving).toBe(false);
    expect(fan.fnOp).toBe("positive?");
    expect(fan.template).toBeUndefined();
  });
});

describe("Q8a′ builder core — loop-shaped binders get REAL backedge-wired interiors", () => {
  it("named let → binder{cycles} node with a real interior — no interior deferred", async () => {
    const p = await wf("(emit! (let loop ((i 0)) (if (> i 3) i (loop (+ i 1)))))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");
    expect(binder.cycles).toBe(true);
    expect(binder.op).toBe("named-let");
    expect(binder.params).toEqual(["i"]);
    // selector `(> i 3)` is pure → collapses (§1 A2, no mux node); the interior
    // holds exactly the backedge (`recur`, the `(loop (+ i 1))` arm) and the
    // terminal out-port (the `i` arm) — no half-wired/deferred placeholder.
    expect(binder.interior.nodes.map((n) => n.kind).sort()).toEqual(["port", "recur"]);
    expect(binder.interior.egress).not.toBeNull();
  });

  it("do → binder{cycles} node with a real interior — the step expression is the backedge", async () => {
    const p = await wf("(do ((i 0 (+ i 1))) ((> i 3) i))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");
    expect(binder.op).toBe("do");
    expect(binder.params).toEqual(["i"]);
    expect(binder.interior.nodes.map((n) => n.kind).sort()).toEqual(["port", "recur"]);
    expect(binder.interior.egress).not.toBeNull();
  });

  it("Q8a′: binder backedge wiring — loop interiors wireframe with per-iteration template referents", async () => {
    const p = await wf("(emit! (let loop ((i 0)) (if (> i 3) i (loop (+ i 1)))))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");

    // The binder's OWN ingress (in the ENCLOSING graph): the INITIAL value
    // only — the loop variable is NOT program ingress from G's point of view.
    const binderIdx = p.main.nodes.indexOf(binder);
    const initWire = p.main.wires.find((w) => w.consumer.node === binderIdx && w.consumer.slot === "arg0");
    expect(initWire?.source).toBe("(lambda () 0)");

    // Inside the interior: the recur node's arg0 is the NEXT-iteration value,
    // computed from the CURRENT iteration's `i` — the backedge, not a fresh
    // program ingress.
    const recurIdx = binder.interior.nodes.findIndex((n) => n.kind === "recur");
    expect(recurIdx).toBeGreaterThanOrEqual(0);
    const recurWire = binder.interior.wires.find((w) => w.consumer.node === recurIdx && w.consumer.slot === "arg0");
    expect(recurWire?.source).toBe("(lambda (i) (+ i 1))");
    expect(recurWire?.params).toEqual(["i"]);
  });

  it("Q8a′: a port inside a loop body is wireframed through the binder's interior graph", async () => {
    const p = await wf("(emit! (let loop ((i 0)) (if (> i 3) (fetch-item i) (loop (+ i 1)))))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");
    // The terminal arm's port lands as a designated node INSIDE the private
    // interior — never spliced into the enclosing graph `p.main` (I5's
    // discipline, extended to loop interiors).
    expect(binder.interior.nodes.map((n) => n.kind).sort()).toEqual(["port", "recur", "source"]);
    expect(p.main.nodes.some((n) => n.kind === "source")).toBe(false);

    // A `do` loop's step position is equally wireframed — the step IS the
    // backedge's own ingress wire, so a source in step position lands there,
    // alongside `do`'s own `recur` node (the step-triggered backedge).
    const doProgram = await wf("(emit! (do ((i 0 (fetch-item i))) ((> i 3) i)))");
    const doBinder = doProgram.main.nodes.find((n) => n.kind === "binder");
    if (doBinder?.kind !== "binder") throw new Error("expected a binder node");
    expect(doBinder.interior.nodes.map((n) => n.kind).sort()).toEqual(["port", "recur", "source"]);
  });

  it("Q9 finding 4 (FLIPPED): do's result clause wires back through the recur node — the source lives in a STEP expression, not the result form itself", async () => {
    // `acc` never mentions `fetch-item` directly — the source only fires inside the
    // STEP expression that computes acc's next-iteration value. Before the fix, the
    // result clause's `acc` reference resolved to a plain per-iteration LEAF slot
    // (a "slot" paramRef, no node reference at all); the fix routes it through the
    // `recur` node's id instead, so reachability from the interior's egress now
    // walks into the step expression and finds the source.
    const p = await wf("(emit! (do ((i 0 (+ i 1)) (acc 0 (+ acc (fetch-item i)))) ((> i 3) acc)))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");
    expect(binder.op).toBe("do");
    const { interior } = binder;
    const recurIdx = interior.nodes.findIndex((n) => n.kind === "recur");
    expect(recurIdx).toBeGreaterThanOrEqual(0);
    const sourceIdx = interior.nodes.findIndex((n) => n.kind === "source");
    expect(sourceIdx).toBeGreaterThanOrEqual(0);

    // The egress ("out") wire — the result clause's own wire — carries a NODE
    // paramRef straight into the recur node (not a bare "acc" slot reference).
    expect(interior.egress).not.toBeNull();
    const egressWire = interior.wires.find((w) => w.consumer.node === interior.egress && w.consumer.slot === "out");
    expect(egressWire).toBeDefined();
    expect(egressWire?.paramRefs.some((r) => r.kind === "node" && r.node === recurIdx)).toBe(true);

    // And the derived reachability cone (Q8a′'s V4 walk) now includes the source
    // that only fires inside the step expression — the whole point of the fix.
    const reached = reachableNodes(interior, interior.egress as number);
    expect(reached.has(sourceIdx)).toBe(true);
  });

  it("Q8a′: V4 cone-traversal termination rows exercise over real backedge topology", async () => {
    const p = await wf("(emit! (let loop ((i 0)) (if (> i 3) i (loop (+ i 1)))))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");

    // A REAL loop interior — today a DAG, terminates trivially, but exercised
    // through the SAME guarded walk the synthetic case below stresses.
    const outIdx = binder.interior.egress;
    expect(outIdx).not.toBeNull();
    const reached = reachableNodes(binder.interior, outIdx as number);
    expect(reached.size).toBeGreaterThan(0);

    // A SYNTHETIC index-level cycle — two nodes whose wires reference each
    // other — the honest proof the guard is load-bearing: an UNGUARDED
    // version of this exact walk would never return on this input.
    const cyclic: WireframeGraph = {
      nodes: [
        { kind: "recur", span: "a" },
        { kind: "recur", span: "b" },
      ],
      wires: [
        {
          source: "(lambda (x) x)",
          params: ["x"],
          paramRefs: [{ kind: "node", name: "x", node: 1 }],
          span: "w0",
          consumer: { node: 0, slot: "arg0" },
        },
        {
          source: "(lambda (x) x)",
          params: ["x"],
          paramRefs: [{ kind: "node", name: "x", node: 0 }],
          span: "w1",
          consumer: { node: 1, slot: "arg0" },
        },
      ],
      egress: null,
    };
    expect(reachableNodes(cyclic, 0)).toEqual(new Set([0, 1]));
  });
});

describe("Q8a builder core — dropped top-level forms and program order (§1 D6)", () => {
  it("a non-final top-level form's ports still land; its pure residue emits no wire", async () => {
    const p = await wf("(emit! x)\n(+ y 1)");
    expect(kinds(p.main).sort()).toEqual(["port", "sink"]);
    // wires: the sink's arg wire + the egress wire — nothing for the dropped shell
    expect(p.main.wires).toHaveLength(2);
    expect(wireTo(p.main, "out")?.params).toEqual(["y"]);
  });
});

describe("Q8a — unevalWire's emission-time door (wire-locality)", () => {
  it("a port-reaching define captured as a VALUE throws WireLocalityError (never a payload, never by-name)", async () => {
    const forms = await parse("(define (helper x) (src-a x))\n(emit! helper)");
    expect(() => buildWireframe(forms, { classifier: C, isBaseName })).toThrow(WireLocalityError);
  });

  it("every emitted wire is CLOSED: re-parsing its source yields FV ⊆ prelude ∪ base (params lambda-bound)", async () => {
    const p = await wf(
      "(define (inc n) (+ n 1))\n(let ((y (src-a))) (if (positive? y) (inc y) (emit! (+ y (src-b)))))",
    );
    const graphs: WireframeGraph[] = [p.main, ...[...p.templates.values()].map((t) => t.graph)];
    for (const g of graphs) {
      for (const w of g.wires) {
        const [lam] = await parse(w.source);
        for (const name of freeVars(lam)) {
          expect(p.prelude.names.has(name) || isBaseName(name), `"${name}" leaked from ${w.source}`).toBe(true);
        }
      }
    }
  });
});

// PRE-H2 machinery fix wave — gap (2): `free-vars.ts` had no `case "try"` in its
// switch, so a `try`'s `(catch (var) …)` / `(finally …)` sub-clauses fell through
// the unmodeled-head default-arm application walk — their `catch`/`finally` marker
// heads leaked into the free-variable set (neither is bound anywhere; `try` itself
// only escaped by ALSO being a `KEYWORD_SYNTAX_BASELINE` entry). The fix adds a
// `case "try"` mirroring `static-validation/collect-references.ts`'s own "try" arm
// 1:1: the body walks in the outer scope, `catch`'s bound var scopes its handler
// body only, and the `catch`/`finally` markers themselves are structural literals,
// never free variables.
describe("Q8a — freeVars models `try` (evalTry's exact shape; mirrors collect-references.ts's arm)", () => {
  it("catch/finally marker heads never leak into the free-variable set", async () => {
    const [form] = await parse("(try (raise-continuable x) (catch (e) (handle e)) (finally (cleanup)))");
    const fv = freeVars(form);
    expect(fv.has("try")).toBe(false); // own head — excluded like every other special form
    expect(fv.has("catch")).toBe(false); // structural marker, not a variable
    expect(fv.has("finally")).toBe(false); // structural marker, not a variable
  });

  it("the catch variable binds for its own handler body only — never free, never leaked to `finally`", async () => {
    const [form] = await parse("(try (raise-continuable x) (catch (e) (handle e)) (finally (handle e)))");
    const fv = freeVars(form);
    // `e` inside `catch`'s own handler is BOUND (excluded); `e` inside `finally` is
    // a genuinely free reference (finally does NOT see the catch var) — both facts
    // collapse onto the SAME name here, so assert via the exact expected set instead.
    expect([...fv].sort()).toEqual(["e", "handle", "raise-continuable", "x"].sort());
  });

  it("the try body, catch handlers, and finally clause all contribute their OWN free variables", async () => {
    const [form] = await parse("(try (raise-continuable x) (catch (e) (handle e)) (finally (cleanup)))");
    const fv = freeVars(form);
    expect([...fv].sort()).toEqual(["cleanup", "handle", "raise-continuable", "x"].sort());
  });

  it("a `try` with only a body (no catch/finally clauses) still walks the body correctly", async () => {
    const [form] = await parse("(try (only-body-call x))");
    const fv = freeVars(form);
    expect([...fv].sort()).toEqual(["only-body-call", "x"].sort());
  });
});
