/**
 * LAW — wire-locality (GREEN at Q8a), W1 agreement (staged, Q9), I5 exterior collapse
 * (GREEN at Q8a) (docs/PROVENANCE.md §1 "Model", §3 I5, §7 law table —
 * Q5's stub-file mapping, Q8a's landing).
 *
 * Three law families share this file because all three are properties OF THE
 * BUILDER'S OUTPUT (the wireframe graph), not of the retrospective stream:
 *
 *   - wire-locality  — an ASSEMBLY-TIME check on every emitted wire
 *     (`provenance/uneval.ts`'s `unevalWire` enforces FV(body) ⊆ params ∪ prelude ∪
 *     hermetic-base AT EMISSION — the `WireLocalityError` door).
 *   - W1 agreement   — the wireframe's cone vs the eager oracle's, SCOPED per the m3
 *     precision trade.
 *   - I5 ext. collapse — a region is ONE node from G (a fan's callback body is the
 *     region's PRIVATE `template` interior).
 *
 * Q7 (LANDED) keeps its own describe block below — the PRECURSOR half of
 * wire-locality's by-name row, asserted one layer down (partition + hermetic
 * assembler); the wire-level half is now asserted directly above it.
 */
import * as fc from "fast-check";
import { describe, it, expect, beforeAll } from "vitest";
import { parse, exec, execState, execStateOverFrame } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { Classifier, DeclaredRole } from "../../provenance/lineage.js";
import { classifyProgramPrelude, buildPreludeSource } from "../../provenance/prelude.js";
import { hermeticEnv } from "../../provenance/hermetic-env.js";
import { BASE_ROSTER } from "../../env/base-roster.js";
import { buildWireframe } from "../../provenance/wireframe/builder.js";
import { freeVars } from "../../provenance/wireframe/free-vars.js";
import type { WireframeGraph } from "../../provenance/wireframe/types.js";
import { WireLocalityError } from "../../errors.js";
import { scopeId } from "../../provenance/scope-id.js";
import { toJS } from "../../membrane/rosetta.js";
import { collapseProvenance } from "../../provenance/provenance-collapse.js";
import { isEagerProvenanceOracleEnabled, setEagerProvenanceOracleEnabled } from "../../values/op-helpers.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";
import {
  SourceRegistry,
  runEagerCone,
  prospectiveSourceCone,
  type SourceShape,
} from "../../__tests__/provenance/w1-harness.js";
import { W1_CORPUS, CORPUS_ROLES, CORPUS_BASE_NAMES, genLinearProgram } from "../../__tests__/provenance/w1-corpus.js";

const num: SourceShape = "num";

// ── Q8a harness: a synthetic declared-role classifier (Q3's shape) + a synthetic
// hermetic-base predicate. Production reads `.provenanceRole` off the sealed chain;
// the LAW is about the builder's output shape, not the role source. ──
const ROLES: Record<string, DeclaredRole> = { "src-a": "source", "fetch-item": "source", "emit!": "sink", map: "fan" };
const CLASSIFIER: Classifier = { roleOf: (op) => ROLES[op] };
const BASE = new Set(["+", "-", "*", ">", "positive?", "car", "cons", "list", "length"]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string) {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: CLASSIFIER, isBaseName });
}

beforeAll(async () => {});

describe("wire-locality (§1 CHOSEN: a wire is a closed arrival lambda) — FLIPPED at Q8a", () => {
  it(
    "FV(wire body) ⊆ params ∪ prelude-names — checked AT EMISSION by `uneval`'s lambda-" +
      "lifting; declared-vs-actual consumption drift is unrepresentable by construction",
    async () => {
      const p = await wf("(define (inc n) (+ n 1))\n(let ((y (src-a))) (if (positive? y) (inc y) (+ y (src-a))))");
      // POSITIVE direction: every emitted wire re-parses CLOSED — its lambda's free
      // variables are only prelude/base names (params are lambda-bound; ingress
      // that isn't a param cannot exist, so drift is unrepresentable).
      const graphs: WireframeGraph[] = [p.main, ...[...p.templates.values()].map((t) => t.graph)];
      let wiresChecked = 0;
      for (const g of graphs) {
        for (const w of g.wires) {
          const [lam] = await parse(w.source);
          for (const name of freeVars(lam)) {
            expect(p.prelude.names.has(name) || isBaseName(name), `"${name}" leaked from ${w.source}`).toBe(true);
          }
          wiresChecked++;
        }
      }
      expect(wiresChecked).toBeGreaterThan(0);

      // NEGATIVE direction: the check is AT EMISSION — a wire that would capture a
      // port-reaching define as a value is never minted; the door throws while the
      // builder assembles, not in a later audit pass.
      const violating = await parse("(define (helper x) (src-a x))\n(emit! helper)");
      expect(() => buildWireframe(violating, { classifier: CLASSIFIER, isBaseName })).toThrow(WireLocalityError);
    },
  );

  it(
    "a wire body calling a pure prelude helper references it BY NAME — a captured " +
      "reference that resolves to a prelude or native name is NEVER carried as a " +
      'payload (§1 EXCLUDED: "helpers-as-ingress... a captured native would smuggle a ' +
      'JS function into the persisted wire")',
    async () => {
      const p = await wf("(define (inc n) (+ n 1))\n(emit! (inc x))");
      expect(p.prelude.names.has("inc")).toBe(true);
      const w = p.main.wires[0];
      // by-name: `inc` appears in the body TEXT, never in the parameter list
      expect(w.source).toBe("(lambda (x) (inc x))");
      expect(w.params).toEqual(["x"]);
      expect(w.paramRefs).toEqual([{ kind: "slot", name: "x" }]);

      // γ = apply in the hermetic env (§4): the wire resolves `inc` through the
      // vocabulary+prelude scope — proof the reference needed no payload.
      const base = await hermeticEnv([...BASE_ROSTER], p.prelude.source);
      const [result] = (
        await execState(`(${w.source} 41)`, {
          capabilities: base.capabilities,
          config: base.config,
          scope: base.scope,
          runCtx: base.runCtx,
        })
      ).values;
      expect(toJS(result)).toBe(42);
    },
  );

  it(
    "a JS closure is never a wire carrier — wires serialize as Pairs-with-spans (the " +
      "reader AST) under the tagless algebra, never as an ambient-referencing JS " +
      'function (§1 EXCLUDED: "not serializable, not content-addressable")',
    async () => {
      const p = await wf("(+ (src-a) k)");
      const w = p.main.wires.find((x) => x.consumer.slot === "out");
      expect(w).toBeDefined();
      if (w === undefined) return;
      // the carrier is TEXT (content-addressable data), not a function
      expect(typeof w.source).toBe("string");
      for (const v of Object.values(w)) expect(typeof v).not.toBe("function");
      // and it re-reads as located Pairs — the homoiconic iso's data half
      const [lam] = await parse(w.source);
      expect((lam as { kind?: string }).kind).toBe("pair");
      expect(scopeId(lam)).toContain("@"); // spans intact on the re-read carrier
    },
  );
});

describe("W1 agreement (§7: eager-oracle cone == wireframe cone, SCOPED per the m3 precision trade)", () => {
  // Verbatim from docs/PROVENANCE.md §1 (round 3, m3) — the precision trade this whole
  // law family is built around, quoted so no future edit "fixes" the scoping by
  // accident: "Do not \"fix\" this by re-recording — the trade IS the ruling."

  const corpusClassifier: Classifier = { roleOf: (op) => CORPUS_ROLES[op] };
  const corpusIsBaseName = (n: string): boolean => CORPUS_BASE_NAMES.has(n);
  async function wfCorpus(code: string) {
    const forms = await parse(code);
    return buildWireframe(forms, { classifier: corpusClassifier, isBaseName: corpusIsBaseName });
  }

  describe.each(W1_CORPUS.filter((e) => e.precision === "exact"))("exact: $klass / $name", (entry) => {
    it(`${entry.code}`, async () => {
      const registry = new SourceRegistry();
      const eager = await runEagerCone(inferenceEnv, entry.code, entry.sources, registry);
      const program = await wfCorpus(entry.code);
      const wireframe = prospectiveSourceCone(program);
      expect([...wireframe].sort()).toEqual([...eager].sort());
    });
  });

  // wireframe cone is a proper superset (untaken arm); do not shrink it to match eager
  describe.each(W1_CORPUS.filter((e) => e.precision === "abstract"))("abstract both-arms: $klass / $name", (entry) => {
    it(`${entry.code}`, async () => {
      const registry = new SourceRegistry();
      const eager = await runEagerCone(inferenceEnv, entry.code, entry.sources, registry);
      const program = await wfCorpus(entry.code);
      const wireframe = prospectiveSourceCone(program);
      // eager ⊊ wireframe — a PROPER subset (never fix by re-recording to equality)
      for (const op of eager) expect(wireframe.has(op), `${op} missing from wireframe cone`).toBe(true);
      expect(wireframe.size).toBeGreaterThan(eager.size);
      for (const extra of entry.extraInWireframe ?? []) {
        expect(wireframe.has(extra), `${extra} should be wireframe-only`).toBe(true);
        expect(eager.has(extra), `${extra} should be ABSENT from eager (untaken arm)`).toBe(false);
      }
    });
  });

  it("property: random non-mux source pipe/merge programs agree exactly, over 30 generated programs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 ** 31 - 1 }), async (seed) => {
        const { code, sources } = genLinearProgram(seed);
        const sourceShapes: Record<string, SourceShape> = {};
        for (const s of sources) sourceShapes[s] = "num";
        const registry = new SourceRegistry();
        const eager = await runEagerCone(inferenceEnv, code, sourceShapes, registry);
        const program = await wfCorpus(code);
        const wireframe = prospectiveSourceCone(program);
        expect([...wireframe].sort(), `program: ${code}`).toEqual([...eager].sort());
      }),
      { numRuns: 30 },
    );
  });

  it("a pure-selector mux collapses INTO its wire and carries no decision record of its own — only port-coupled muxes reach the retrospective stream (§1 CHOSEN, A2)", async () => {
    const program = await wfCorpus(`(if #t (src-a) (src-b))`);
    expect(program.main.nodes.some((n) => n.kind === "mux")).toBe(false);
    // the two sources ARE designated nodes (they're Rosetta-IN crossings), just not
    // gated behind a mux node — confirming the collapse, not a designation failure.
    expect(program.main.nodes.filter((n) => n.kind === "source")).toHaveLength(2);

    const portCoupled = await wfCorpus(`(if (positive? (src-a)) 1 2)`);
    expect(portCoupled.main.nodes.some((n) => n.kind === "mux")).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FINDINGS — agreement failures the corpus surfaced. Per the wave's discipline
  // ("agreement failures are FINDINGS, not bugs to paper over"): each row below
  // documents an ACTUAL divergence between the eager oracle and the wireframe,
  // root-caused, with the exact program + expected/got cones. Territory this wave
  // is test files only (builder.ts/types.ts/uneval.ts are Q8c's) — none of these
  // are fixed here; each is named here for follow-up. Three are Q8a's OWN
  // documented first-landing limits (builder.ts's header comment); two are NEWLY
  // surfaced by this corpus (named distinctly, not conflated with the three).
  // ═══════════════════════════════════════════════════════════════════════════
  describe("KNOWN LIMIT (Q8a, documented) — letrec local-closure mux under-designation", () => {
    // @ledger: Q9 finding — builder.ts: "A local closure (letrec-bound lambda)
    // wrapping a port under-designates a mux whose selector calls it (classify
    // never expands call sites into callee bodies)". Empirically: the selector
    // `(positive? (get))` cannot see that `get` resolves to a lambda wrapping
    // `fetch-item`, so `selectorReachesPort` returns false and the WHOLE if
    // collapses into ONE pure wire (no `mux` node) instead of a port-coupled one.
    // @ledger: letrec local-closure mux under-designation
    it.fails(
      "a letrec-bound closure wrapping a port, called from a mux selector, SHOULD designate a port-coupled `mux` node (the selector genuinely reaches fetch-item transitively) — it does not",
      async () => {
        const program = await wfCorpus(
          `(letrec ((get (lambda () (fetch-item 0)))) (if (positive? (get)) (src-a) (src-b)))`,
        );
        expect(program.main.nodes.some((n) => n.kind === "mux")).toBe(true);
      },
    );

    // The limit is BENIGN at W1's op-NAME cone granularity specifically: the
    // pure-mux collapse's OWN "both arms + selector in one wire" shape happens to
    // still land every reachable source (fetch-item, src-a, src-b) as a node the
    // single collapsed wire references — so `prospectiveSourceCone` over-includes
    // exactly like an ordinary pure-mux would (abstract superset), not less than
    // that. Recorded as a passing row so the benign half stays asserted, not just
    // claimed in a comment.
    it("…but the CONE is still a sound (superset) abstract cone — not a silent under-approximation", async () => {
      const registry = new SourceRegistry();
      const code = `(letrec ((get (lambda () (fetch-item 0)))) (if (positive? (get)) (src-a) (src-b)))`;
      const eager = await runEagerCone(inferenceEnv, code, { "fetch-item": num, "src-a": num, "src-b": num }, registry);
      const program = await wfCorpus(code);
      const wireframe = prospectiveSourceCone(program);
      for (const op of eager) expect(wireframe.has(op)).toBe(true); // sound superset
      expect(wireframe.has("src-b")).toBe(true); // the untaken arm still shows up
    });
  });

  describe("KNOWN LIMIT (Q8a, documented) — non-tail begin sink sequencing", () => {
    // @ledger: Q9 finding — builder.ts: "A sink cut in non-tail begin position
    // leaves the wire a sequencing reference to the sink node (D6 territory) —
    // tolerated, not modeled." Empirically: `(begin (emit! (src-a)) (src-b))`'s
    // egress wire is `(begin in0 in1)` where `in0` is a NODE reference to the
    // sink — reachableNodes cannot distinguish "value consumed" from "value
    // dropped after a port fired", so it walks INTO the sink's own ingress
    // (src-a), over-including it. Real `begin` semantics discard the non-tail
    // value entirely — eager's deep-collapsed result never carries src-a's id.
    // @ledger: non-tail begin sink sequencing over-includes source
    it.fails(
      "(begin (emit! (src-a)) (src-b)): wireframe cone SHOULD equal eager's {src-b} — it over-includes src-a via the dropped sink's ingress",
      async () => {
        const ROLES_SINK: Record<string, DeclaredRole> = { ...CORPUS_ROLES, "emit!": "sink" };
        const classifierWithSink: Classifier = { roleOf: (op) => ROLES_SINK[op] };
        const forms = await parse(`(begin (emit! (src-a)) (src-b))`);
        const program = buildWireframe(forms, { classifier: classifierWithSink, isBaseName: corpusIsBaseName });
        const wireframe = prospectiveSourceCone(program);

        const env = inferenceEnv.child("w1-begin-finding");
        // Test-local EnvCapability: identity passthrough, `z.dynamic` on both sides (no
        // transform, matching the historical `fn: (x) => x` shape exactly).
        await applyCapability(env, [
          EnvCapability.define("test/w1-begin-finding", {
            symbols: (symbol, z) => ({
              "emit!": symbol.rosetta`emit!: identity passthrough (sink echo)`(
                { input: [z.dynamic], output: [z.dynamic] },
                (x: import("../../values/types.js").SchemeValue) => x,
              ),
            }),
          }),
        ]);
        const registry = new SourceRegistry();
        await registry.register(env, "src-a", num);
        await registry.register(env, "src-b", num);
        const { values } = await execStateOverFrame(`(begin (emit! (src-a)) (src-b))`, { env });
        const eager = registry.opsOf(collapseProvenance(values[values.length - 1]));

        expect([...wireframe].sort()).toEqual([...eager].sort()); // fails: wireframe = {src-a, src-b}, eager = {src-b}
      },
    );
  });

  describe("KNOWN LIMIT (Q8a, documented) — cond => receiver approximation", () => {
    // @ledger: Q9 finding — builder.ts's `buildCondMux`: "A `=>` clause's receiver
    // is approximated as the arm — its applied-to-test threading is
    // classifyCond's `combine(\"=>\")`, deferred here." Structurally: the arm wire
    // closes over the RAW receiver lambda `(lambda (x) …)`, whose own formal `x`
    // shadows the free-variable it would need if it genuinely modeled "the
    // receiver APPLIED to the test's value" — so a receiver that returns `x`
    // unchanged wires as a CLOSED, ZERO-PARAM lambda (the wire believes this arm
    // has no ingress at all), when the correct modeling would show a dependency on
    // whatever produced the test's value.
    // @ledger: cond => receiver approximation loses test-value dependency
    it.fails(
      "a `=>` receiver that returns its bound parameter untouched SHOULD wire with a non-empty param list (it depends on the test's value) — it wires as a closed, zero-param lambda",
      async () => {
        const forms = await parse(`(cond ((src-a) => (lambda (x) x)) (else (fetch-item 0)))`);
        const program = buildWireframe(forms, { classifier: corpusClassifier, isBaseName: corpusIsBaseName });
        const muxNode = program.main.nodes.findIndex((n) => n.kind === "mux");
        const armWire = program.main.wires.find((w) => w.consumer.node === muxNode && w.consumer.slot === "arm0");
        expect(armWire).toBeDefined();
        expect(armWire?.params.length ?? 0).toBeGreaterThan(0);
      },
    );
  });

  describe("do-loop result clause wires back to the recur node — FLIPPED (Q9 finding 4)", () => {
    // Was: `buildDoBinder`'s `interior.emitEgress(resultForm, intEnv)` walked the
    // RESULT clause in the SAME `intEnv` the loop body uses, where each bound
    // variable (e.g. `acc`) is a per-iteration LEAF SLOT (`intSubst.set(p, LEAF(p))`)
    // — the result clause wired as a plain SLOT reference to `acc`, with NO
    // node-kind paramRef to the `recur` node that actually computes next-
    // iteration's `acc` from the accumulating step expression. Contrast with
    // named-let: its body's tail position IS the literal `(loop next-args…)` call,
    // which the cut-and-close algorithm designates as a `recur` NODE referenced
    // like any other value — so reachability happens to walk through it for free.
    // `do` has no equivalent syntactic value-position call to lean on, so its
    // recur node was a dead end for `reachableNodes`: any source that only fires
    // inside a STEP expression (the whole point of `do`'s accumulation) was
    // invisible to the prospective cone, even though it demonstrably flows into
    // the eager result.
    //
    // `buildDoBinder` walks `result…` under an extra synthetic `let` that rebinds
    // every loop variable to a cut sentinel at the `recur` node, so the egress
    // wire carries a NODE paramRef into `recur`.
    it("(do ((i 0 (+ i 1)) (acc 0 (+ acc (fetch-item i)))) ((> i 3) acc)): wireframe cone equals eager's {fetch-item} — the result clause now wires back through the recur node", async () => {
      const code = `(do ((i 0 (+ i 1)) (acc 0 (+ acc (fetch-item i)))) ((> i 3) acc))`;
      const registry = new SourceRegistry();
      const eager = await runEagerCone(inferenceEnv, code, { "fetch-item": num }, registry);
      const program = await wfCorpus(code);
      const wireframe = prospectiveSourceCone(program);
      expect([...wireframe].sort()).toEqual([...eager].sort());
    });
  });

  describe("FINDING (Q9) — first-class reference to a declared source bypasses string-based role dispatch (the A21 HOF hole) — FLIPPED by V's ruling (2026-07-10)", () => {
    // Root-caused: `walkForCuts` used to designate a node ONLY at an APPLICATION
    // HEAD position (`(op . args)` where `op` is a literal symbol matching a
    // declared role). `fetch-item` passed as a bare VALUE — never applied at this
    // call site — was just a leaf symbol; the flow was silently invisible (no
    // WireLocalityError, no designated node, no trace it named a declared source
    // at all).
    //
    // V's ruling (2026-07-10): "we need to provenance rosetta-to-rosetta; we
    // actually do not care on reassignments here." `walkForCuts` (builder.ts,
    // header's "BARE DECLARED-ROLE REFERENCES" paragraph) now designates the bare
    // OCCURRENCE itself — `fetch-item` cuts to a `source` node right where it's
    // passed, so the prospective cone sees it even though the call that actually
    // fires it (`(f)`, hidden behind `call-source`'s own parameter — string-based
    // role lookup still can't see through THAT) never gets designated. Ruled OUT
    // of scope, deliberately unaddressed: `call-source` itself is still (silently)
    // judged port-free by materialNames' fixed point, and a let-ALIAS's own later
    // call site (`(let ((g fetch-item)) (g))`'s `(g)`) stays exactly as under-
    // designated as before — "do not chase aliases."
    it("(define (call-source f) (f)) (call-source fetch-item): wireframe cone includes fetch-item (it fires at runtime) — the bare-argument occurrence is now designated", async () => {
      const code = `(define (call-source f) (f)) (call-source fetch-item)`;
      const registry = new SourceRegistry();
      const eager = await runEagerCone(inferenceEnv, code, { "fetch-item": num }, registry);
      const program = await wfCorpus(code);
      const wireframe = prospectiveSourceCone(program);
      expect([...wireframe].sort()).toEqual([...eager].sort()); // both {fetch-item}
    });
  });

  describe("NEW FINDING (Q9) — field-shaped pure ops (car/cons chains) are not projection-aware, over-including a sibling source", () => {
    // Root-caused: the builder never constructs a `field` WireframeNode for
    // `car`/`cdr`/`:field`/`@` — these currently reach `walkForCuts` only via the
    // ordinary APPLICATION path with an UNDECLARED role (`car`/`cons` are BASE
    // names, not designated), so `(car (cons A B))` becomes ONE flat pure wire
    // closing over BOTH A and B's cut references, with no awareness that `car`
    // structurally discards the cdr side. The REAL `car`/`cons` implementation
    // (op-helpers.ts convention, conservation.law.test.ts's own pinned behavior:
    // "car projects the HEAD element only") DOES prune at the value level — the
    // eager cone genuinely excludes the cdr side's source. This is NOT R2 demand-
    // monotonicity (Q8c/Q17's deferred field-DEMAND lattice, "answer a query
    // without materializing") — it is the ordinary FULL/flat cone over-including
    // a sibling the runtime's OWN accessor semantics provably never touches,
    // present today because no `field` node exists yet to route the projection.
    // @ledger: field-shaped pure ops not projection-aware (car/cons sibling leak)
    it.fails(
      "(car (cons (fetch-item 0) (src-a))): wireframe cone SHOULD equal eager's {fetch-item} (car projects the head only) — it over-includes src-a, the pruned cdr side",
      async () => {
        const code = `(car (cons (fetch-item 0) (src-a)))`;
        const registry = new SourceRegistry();
        const eager = await runEagerCone(inferenceEnv, code, { "fetch-item": num, "src-a": num }, registry);
        const program = await wfCorpus(code);
        const wireframe = prospectiveSourceCone(program);
        expect([...wireframe].sort()).toEqual([...eager].sort()); // fails: wireframe = {fetch-item, src-a}, eager = {fetch-item}
      },
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ORACLE FLAG — production default is OFF. This suite's agreement corpus still
  // runs the eager oracle via `w1-harness.ts`'s `runEagerCone` forcing it on
  // per-call (save/restore around its own `execState`), not via an ambient default.
  // ═══════════════════════════════════════════════════════════════════════════
  describe("oracle flag — the Q20 read seam", () => {
    it("defaults to OFF in production (Q20b) — this suite's corpus above forced it on internally, per-call, via w1-harness.ts's runEagerCone", () => {
      expect(isEagerProvenanceOracleEnabled()).toBe(false);
    });

    it("round-trips via the test-only setter, restored after", () => {
      expect(isEagerProvenanceOracleEnabled()).toBe(false);
      setEagerProvenanceOracleEnabled(true);
      try {
        expect(isEagerProvenanceOracleEnabled()).toBe(true);
      } finally {
        setEagerProvenanceOracleEnabled(false); // restore — module-level flag, other tests read it
      }
      expect(isEagerProvenanceOracleEnabled()).toBe(false);
    });

    it("the agreement corpus above ran under the oracle FORCED ON internally (w1-harness.ts's runEagerCone) — CI keeps exercising the oracle regardless of the production default (Q20b's own gate: \"oracle mode still runs the agreement corpus in CI\")", () => {
      // Ambient flag is back at the (off) default here — the corpus never touched
      // it ambiently, it forced it on and restored it, per call, inside runEagerCone.
      expect(isEagerProvenanceOracleEnabled()).toBe(false);
    });
  });
});

describe("I5 — exterior collapse (§3: a region is ONE node from G) — FLIPPED at Q8a", () => {
  it(
    "a region collapses to exactly ONE wireframe node from G, regardless of how many " +
      "interior cones its body computes — structured egress (one value, several " +
      "interior cones) does NOT fragment the region into multiple designated nodes",
    async () => {
      // The callback's structured egress combines a PORT cone (fetch-item) and a
      // pure cone (+ v 1) into one cons — several interior cones, one region value.
      const p = await wf("(car (map (lambda (v) (cons (fetch-item v) (+ v 1))) xs))");
      // From G: the fan is ONE node; the out-port is the only other node. The
      // interior's source did NOT surface as a designated node of G.
      expect(p.main.nodes.map((n) => n.kind).sort()).toEqual(["fan", "port"]);
      const fanIdx = p.main.nodes.findIndex((n) => n.kind === "fan");
      const fan = p.main.nodes[fanIdx];
      if (fan.kind !== "fan") throw new Error("expected fan");
      // the interior EXISTS (replay material) and holds the region's own port
      expect(fan.template?.nodes.map((n) => n.kind).sort()).toEqual(["port", "source"]);
      // exactly ONE wire consumes the region's egress from G
      const consumers = p.main.wires.filter((w) => w.paramRefs.some((r) => r.kind === "node" && r.node === fanIdx));
      expect(consumers).toHaveLength(1);
    },
  );

  // no region field-port kind exists; the projection stays wire material
  it(
    "field-demand at a region boundary answers by REPLAY, not by records — region " +
      "field-ports are DEFERRED until a workload demands them (§3 I5 LIMIT)",
    async () => {
      const p = await wf("(:total (map (lambda (v) (fetch-item v)) xs))");
      // Field demand on the region's egress does NOT mint any per-field egress
      // node — the graph still holds exactly the fan and the out-port…
      expect(p.main.nodes.map((n) => n.kind).sort()).toEqual(["fan", "port"]);
      // …the projection rides INSIDE the consuming wire (glass, one γ-step away)…
      const out = p.main.wires.find((w) => w.consumer.slot === "out");
      expect(out?.source).toContain(":total");
      // …and the replay material (the region's template interior) is present —
      // that is HOW a field-demand answers, per the LIMIT.
      const fan = p.main.nodes.find((n) => n.kind === "fan");
      expect(fan?.kind === "fan" && fan.template !== undefined).toBe(true);
    },
  );
});

describe("Q7 — program prelude: a pure helper stays a REFERENCE, the positive direction (docs/PROVENANCE.md §1 program prelude CHOSEN)", () => {
  it(
    "a pure helper referenced by name from another define stays a REFERENCE: the " +
      "partition keeps BOTH prelude-side (neither is wireframe material), and the " +
      "hermetic assembler lands the joined prelude source as ordinary bindings the " +
      "calling define resolves through the SEALED chain at ordinary lookup — never as " +
      "an ingress payload (`hermeticEnv` is called with an EMPTY ingress bag below)",
    async () => {
      const C: Classifier = { roleOf: () => undefined }; // no declared ports anywhere
      const forms = await parse(
        `(define (helper x) (+ x 1))
         (define (caller y) (helper y))`,
      );
      const membership = classifyProgramPrelude(forms, C);
      expect(membership.pure.has("helper")).toBe(true);
      expect(membership.pure.has("caller")).toBe(true);
      expect(membership.wireframe.size).toBe(0);

      const prelude = buildPreludeSource(forms, membership);
      const base = await hermeticEnv([...BASE_ROSTER], prelude);
      const [result] = (
        await execState("(caller 41)", {
          capabilities: base.capabilities,
          config: base.config,
          scope: base.scope,
          runCtx: base.runCtx,
        })
      ).values;
      expect(toJS(result)).toBe(42);

      // `helper` is a REAL bound name resolved through the root scope — not
      // something the (empty) ingress bag carried.
      expect(base.scope.env.get("helper", { throwError: false })).toBeDefined();
    },
  );
});
