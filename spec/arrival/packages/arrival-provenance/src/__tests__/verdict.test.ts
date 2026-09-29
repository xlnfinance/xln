/**
 * The grounding seal's laws (completion-plan gap 4 gate list):
 *   - a grounded result signs;
 *   - a fabricated leaf (empty provenance, injected post-hoc) refuses, leaf NAMED;
 *   - the union-vs-per-leaf discriminating case: one grounded + one fabricated leaf
 *     ⇒ `unsigned` while `deepProvenance`'s union is non-empty;
 *   - a laundering attempt (re-minting a literal from a traced value's text) is
 *     caught by the typed-literal gate;
 *   - `attestation: "required"` flips a derived-value verdict (the brand drops on
 *     compute; `attestDeep` restores signability);
 *   - the focus edge degrades to `scoped`, never past it;
 *   - the truth-oracle disclaimer is pinned VERBATIM and present on every report.
 *
 * Fixture shape mirrors core's lineage suites: a `symbol.rosetta` source is a
 * Rosetta-IN point, so under a trace tap its return mints real provenance — no live
 * tools, fully deterministic.
 */
import { deepProvenance, EnvCapability, execState, LexicalScope } from "@inhuman.tools/arrival";
import { APair, AString, attestDeep, nil } from "@inhuman.tools/arrival/reflect-internals";
import { describe, expect, it } from "vitest";

import { EvalTrace } from "../index.js";
import { TRUTH_ORACLE_DISCLAIMER, groundingVerdict, verdictLeafValues } from "../verdict.js";

let seq = 0;

/** Run `source` under a fresh traced env with one deterministic Rosetta-IN source,
 *  `(evidence-read q)` → `"SRC:q"`. Returns the `{ result, trace, source }` bag
 *  `groundingVerdict` (and `buildUneval`) consume — `forms` stays unset, so the
 *  reverse-chain's output form derives from the trace itself (`lastTopLevelForm`),
 *  not a second, identity-mismatched parse of `source`.
 *
 *  Test-local `EnvCapability` with injected `symbol.rosetta`: plain typed
 *  `z.string → z.string` contract, no escape hatch needed. */
const evidenceReadCapability = EnvCapability.define("test/evidence-read", {
  symbols: (symbol, z) => ({
    "evidence-read": symbol.rosetta`evidence-read: deterministic Rosetta-IN fixture source`(
      { input: [z.string], output: [z.string] },
      (q) => `SRC:${q}`,
    ),
  }),
});

async function run(source: string) {
  const scope = LexicalScope.fresh(`verdict-test-${seq++}`);
  const trace = new EvalTrace();
  const { values } = await execState(source, { scope, tap: trace, capabilities: [evidenceReadCapability] });
  const result = values.at(-1);
  if (result === undefined) throw new Error("fixture ran zero forms");
  return { result, trace, source };
}

describe("groundingVerdict — a grounded result signs", () => {
  it("every leaf read from the source ⇒ signable, all gates pass", async () => {
    const bag = await run(`(list (evidence-read "who") (evidence-read "when"))`);
    const v = groundingVerdict(bag);
    expect(v.verdict).toBe("signable");
    expect(v.checks).toEqual({ grounding: "pass", typedLiteral: "pass", attestation: "n/a", focus: "n/a" });
    expect(v.leaves).toHaveLength(2);
    expect(v.leaves.every((l) => l.origin === "grounded")).toBe(true);
    // The per-leaf→read join: each leaf resolves to the read VERB a caller can act on.
    expect(v.leaves.every((l) => l.from.includes("evidence-read"))).toBe(true);
    // The certificate re-derives the finding and its points cover every leaf's reads.
    expect(v.reverseChain).toBeDefined();
    const points = new Set(v.reverseChain?.points);
    expect(v.leaves.every((l) => l.reads.every((id) => points.has(id)))).toBe(true);
  });
});

describe("groundingVerdict — fabrication refuses, per leaf, never by union", () => {
  it("a post-hoc injected empty-provenance leaf refuses with the leaf NAMED", async () => {
    const bag = await run(`(evidence-read "beacon")`);
    // The tamper: cons a freshly-minted (never-evaluated, provenance-∅) string onto
    // the grounded result AFTER the run — the exact laundering a whole-result union
    // cannot see.
    const fabricated = new AString("203.0.113.9");
    const tampered = new APair(fabricated, new APair(bag.result, nil));
    const v = groundingVerdict({ ...bag, result: tampered });
    expect(v.verdict).toBe("unsigned");
    expect(v.checks.grounding).toBe("fail");
    expect(v.checks.typedLiteral).toBe("n/a"); // later gates not reached
    // The fabricated leaf is named — in the per-leaf report AND the prose.
    const bad = v.leaves.find((l) => l.origin === "input");
    expect(bad?.display).toBe('"203.0.113.9"');
    expect(v.report).toContain('"203.0.113.9"');
    // An unsigned-for-grounding verdict carries NO re-derivation certificate.
    expect(v.reverseChain).toBeUndefined();
  });

  it("discriminates where deepProvenance's union cannot: union non-empty, verdict unsigned", async () => {
    const bag = await run(`(evidence-read "beacon")`);
    const fabricated = new AString("203.0.113.9");
    const tampered = new APair(fabricated, new APair(bag.result, nil));
    // The union sees the grounded half and calls the WHOLE structure grounded…
    expect(deepProvenance(tampered).size).toBeGreaterThan(0);
    // …the per-leaf seal does not.
    expect(groundingVerdict({ ...bag, result: tampered }).verdict).toBe("unsigned");
  });

  it("a hollow leaf (#f — a failed comparison) is not a positive finding", async () => {
    const bag = await run(`(list (evidence-read "a") (equal? (evidence-read "a") "nope"))`);
    const v = groundingVerdict(bag);
    expect(v.verdict).toBe("unsigned");
    expect(v.checks.grounding).toBe("fail");
  });
});

describe("groundingVerdict — the typed-literal laundering gate", () => {
  it("re-minting a literal from a traced value's text is caught even though provenance grounds it", async () => {
    // The grep door: filter a read against a hardcoded value and return the match.
    // The surviving leaf is GROUNDED (it came out of the read), but its text equals
    // the literal the author typed — authored, not derived.
    const bag = await run(`(car (filter (lambda (x) (equal? x "SRC:beacon")) (list (evidence-read "beacon"))))`);
    const v = groundingVerdict(bag);
    expect(v.verdict).toBe("unsigned");
    expect(v.checks).toEqual({ grounding: "pass", typedLiteral: "fail", attestation: "n/a", focus: "n/a" });
    expect(v.report).toContain('"SRC:beacon"');
    // No certificate: a slice over a typed verdict would re-run to the typed
    // literal — a laundered re-derivation, refused.
    expect(v.reverseChain).toBeUndefined();
  });

  it("a derived value that merely CONTAINS a typed fragment is not caught", async () => {
    const bag = await run(`(string-append (evidence-read "a") "-suffix")`);
    const v = groundingVerdict(bag);
    expect(v.checks.typedLiteral).toBe("pass"); // "SRC:a-suffix" equals no source literal
    expect(v.verdict).toBe("signable");
  });
});

describe("groundingVerdict — attestation: reported by default, a gate on demand (V6)", () => {
  it("required mode flips a derived value's verdict; attestDeep restores it", async () => {
    // A pure pipe over a source: lineage-grounded, but computation drops the brand
    // by construction (values/attestation.ts) — the two tiers answer different questions.
    const bag = await run(`(string-upcase (evidence-read "a"))`);

    const reported = groundingVerdict(bag);
    expect(reported.verdict).toBe("signable");
    expect(reported.leaves[0].attested).toBe(false); // reported as data, not gated

    const required = groundingVerdict({ ...bag, attestation: "required" });
    expect(required.verdict).toBe("unsigned");
    expect(required.checks).toEqual({ grounding: "pass", typedLiteral: "pass", attestation: "fail", focus: "n/a" });
    // The derivation is honest (grounded + read) — the certificate STAYS, showing
    // exactly which computation dropped the brand.
    expect(required.reverseChain).toBeDefined();

    attestDeep(bag.result); // the explicit re-assertion the door coaches toward
    const reasserted = groundingVerdict({ ...bag, attestation: "required" });
    expect(reasserted.verdict).toBe("signable");
    expect(reasserted.leaves[0].attested).toBe(true);
    expect(reasserted.checks.attestation).toBe("pass");
  });
});

describe("groundingVerdict — focus trichotomy boundary", () => {
  it("over-limit grounded results degrade to scoped (never to signable, never unsigned)", async () => {
    const bag = await run(`(list (evidence-read "a") (evidence-read "b") (evidence-read "c"))`);
    const scoped = groundingVerdict({ ...bag, focusLimit: 2 });
    expect(scoped.verdict).toBe("scoped");
    expect(scoped.checks.focus).toBe("fail");
    expect(scoped.reverseChain).toBeDefined(); // honestly re-derivable, just broad

    const focused = groundingVerdict({ ...bag, focusLimit: 3 });
    expect(focused.verdict).toBe("signable");
    expect(focused.checks.focus).toBe("pass");
  });

  it("an empty result has nothing to sign", async () => {
    const bag = await run(`(list)`);
    const v = groundingVerdict(bag);
    expect(v.verdict).toBe("unsigned");
    expect(v.leaves).toHaveLength(0);
    expect(v.report).toContain("nothing to sign");
  });
});

describe("groundingVerdict — the truth-oracle disclaimer is structural", () => {
  it("the disclaimer text is pinned VERBATIM (the mcp-rework ruled discipline)", () => {
    expect(TRUTH_ORACLE_DISCLAIMER).toBe(
      "This seal is a lineage-completeness oracle, not a truth oracle: `signable` means every leaf " +
        "traces to recorded reads — it will sign a provably-traced fabrication from a lying tool. " +
        "It never means 'true'.",
    );
  });

  it("every outcome carries it — in the structure AND the report prose", async () => {
    const grounded = await run(`(evidence-read "a")`);
    const outcomes = [
      groundingVerdict(grounded), // signable
      groundingVerdict({ ...grounded, focusLimit: 0 }), // scoped
      groundingVerdict({ ...grounded, result: new AString("lie") }), // unsigned
    ];
    for (const v of outcomes) {
      expect(v.disclaimer).toBe(TRUTH_ORACLE_DISCLAIMER);
      expect(v.report).toContain(TRUTH_ORACLE_DISCLAIMER);
    }
  });
});

describe("verdictLeafValues — the walk's laundering-hole closures", () => {
  it("an improper (dotted) tail is a leaf, not silently dropped", async () => {
    const bag = await run(`(evidence-read "a")`);
    // (grounded . "lie") — the sift reference's spine loop dropped the tail; here it
    // is a leaf and refuses.
    const dotted = new APair(bag.result, new AString("lie"));
    expect(verdictLeafValues(dotted)).toHaveLength(2);
    expect(groundingVerdict({ ...bag, result: dotted }).verdict).toBe("unsigned");
  });

  it("a leafCut treats a caller-designated unit as one atomic leaf", async () => {
    const bag = await run(`(list (evidence-read "a") "inner-literal")`);
    // Default walk: the typed inner literal is an ungrounded leaf ⇒ unsigned.
    expect(groundingVerdict(bag).verdict).toBe("unsigned");
    // A caller declaring the whole list one unit grounds it as a unit — the
    // generalized "row object = atomic leaf" cut (its own provenance decides).
    const asUnit = groundingVerdict({ ...bag, leafCut: (v) => v === bag.result });
    expect(asUnit.leaves).toHaveLength(1);
  });
});
