/**
 * LEDGER F8 — the suite's truth table, owned in one place (P15).
 *
 * green = design · it.fails = documented gap (flips loudly when fixed) ·
 * it.todo = staged spec. This file indexes every gap/staging/inversion in the
 * suite so "what does green mean" is answerable mechanically. Each entry names
 * its GATE — the ruling or migration that flips it — and the law row that
 * replaces it.
 *
 * LEDGER CONVENTION (enforced below, not just documented): every `it.fails(...)`
 * call inside a SUNRISE dir (src/__tests__/{laws,membrane,provenance,ledger,
 * conformance,doors,agreement}/) must carry a `// @ledger: <id>` comment on the
 * line immediately above the call, where `<id>` is the exact `id` string of a
 * row in GAPS or INVERSIONS below. Example:
 *
 *   // @ledger: append drops element provenance
 *   it.fails("(append (list a) (list b)) keeps element ids", () => { ... });
 *
 * This is how the walker meta-test cross-references a red row back to its gate
 * without guessing by test name. The sunset suite's `it.fails` calls
 * are NOT governed by this convention — the walker only scans the sunrise dirs.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface LedgerRow {
  readonly id: string;
  readonly gate: string; // ruling (R1-R7) or migration (bare-value-purge, reverse-membrane, region-discipline, conservation-repair, G2)
  readonly replacedBy: string; // the v2 law row
}

const GAPS: readonly LedgerRow[] = [
  {
    id: "exact/list JSON.stringify throws (BigInt backing)",
    gate: "numeric-json design",
    replacedBy: "membrane/crossing",
  },
  { id: "null↔nil round-trip asymmetry", gate: "R1-adjacent ruling", replacedBy: "membrane/crossing null row" },
  { id: "schema-to-ts vector union not deduped", gate: "printer dedup follow-up", replacedBy: "type-layer suite" },
  // ── added by the RULINGS.md R8 mint sweep ─────────────────────────
  // Surfaced while flipping the equal?-verdict flyweight rows above: mintVerdict
  // faithfully forwards operand provenance, but AJSArray (`borrow-array`'s `fromJS`)
  // and ADict (`dict`'s `new ADict(...)`, env/polyglot/polyglot.ts) never stamp
  // their OWN top-level provenance with the R2 grouping-fact union at construction —
  // independent of R8, un-implemented (R2 is its own, later design item).
  // NARROWED to ADict (2026-07-14). It never applied to AJSArray: production DOES stamp a borrowed
  // container with the crossing's provenance (rosetta's inbound `array → borrowed AJSArray` claim,
  // `new AJSArray(v, p)`). The apparent gap was a FIXTURE artifact — `borrow-array` minted
  // through `fromJS`, which deliberately drops provenance (CONSTANT_CTX / EMPTY_PROVENANCE), so the
  // test was building a container production never builds and then ticketing the absence as a code
  // gap. With the fixture crossing its args honestly (V's hygiene law), AJSArray's cells pass on
  // their own merits. ADict's gap is real and stays open.
  {
    id: "ADict container carries no grouping-fact provenance",
    gate: "R2 container-provenance ruling",
    replacedBy: "laws/term-carrier equals cells (ADict)",
  },
  // Carried from clone-identity.test.ts (retired in the 2026-07-09 suite
  // consolidation) — the
  // one still-open site of the `=== nil` identity-equality sweep. `toJS`'s entry point special-cases `value === nil` instead
  // of `instanceof ANil`, so a provenance-bearing Nil clone (minted by
  // `restrictControlFlowProvenance`) falls through to the generic `return value` branch
  // and hands back a Nil object where callers expect `null`.
  { id: "nil-clone toJS entry loses identity", gate: "rosetta.ts:70 fix", replacedBy: "laws/identity" },
  // ── Q9 W1 agreement corpus findings (docs/PROVENANCE.md §7 W1 agreement; provenance/
  // wireframe-agreement.law.test.ts's "FINDINGS" section) — surfaced running the
  // extended generator corpus against BOTH the eager oracle and the wireframe
  // builder. Territory this wave is test files only (builder.ts/uneval.ts are
  // Q8c's); each row below is a REAL divergence, root-caused, awaiting a builder-
  // side fix in a later wave. Three are Q8a's OWN documented first-landing limits
  // (builder.ts's header comment, named there verbatim); two are newly surfaced by
  // this corpus and are NOT conflated with the three documented ones.
  {
    id: "letrec local-closure mux under-designation",
    gate: 'Q8c/Q9-follow-up builder fix (Q8a documented LIMIT, builder.ts header: "A local closure (letrec-bound lambda) wrapping a port under-designates a mux whose selector calls it")',
    replacedBy:
      "provenance/wireframe-agreement.law.test.ts's letrec-closure-mux row, once selectorReachesPort can see through a letrec-bound closure",
  },
  {
    id: "non-tail begin sink sequencing over-includes source",
    gate: 'Q8c/Q9-follow-up builder fix (Q8a documented LIMIT, builder.ts header: "A sink cut in non-tail begin position leaves the wire a sequencing reference to the sink node (D6 territory) — tolerated, not modeled")',
    replacedBy:
      "provenance/wireframe-agreement.law.test.ts's non-tail-begin row, once reachableNodes (or the builder) stops treating a dropped sink's ingress as reachable from the tail value",
  },
  {
    id: "cond => receiver approximation loses test-value dependency",
    gate: 'Q8c/Q9-follow-up builder fix (Q8a documented LIMIT, builder.ts\'s buildCondMux: "A `=>` clause\'s receiver is approximated as the arm — its applied-to-test threading is classifyCond\'s combine(\\"=>\\"), deferred here")',
    replacedBy:
      "provenance/wireframe-agreement.law.test.ts's cond=> row, once the arm wire models applying the receiver to the test's value instead of the raw closure",
  },
  {
    id: "field-shaped pure ops not projection-aware (car/cons sibling leak)",
    gate: "V ruling pending (Q21 audit 2026-07-10: survived the whole Q-track — Q8c built fact wires and Q17 flipped demand-monotonicity WITHOUT a `field` WireframeNode; whether one is added, and where it cuts, is a design ruling. Q9 finding — no `field` WireframeNode is built yet for car/cdr/:field/@ accessors, so a projection's sibling side is NOT pruned from the prospective cone the way the real accessor prunes it from the eager value; distinct from R2 demand-monotonicity, Q8c/Q17's SEPARATE deferred field-DEMAND-lattice concern — this is the ordinary full/flat cone over-including a sibling the runtime provably never touches)",
    replacedBy:
      "provenance/wireframe-agreement.law.test.ts's car/cons row, once a `field` node routes the projection the way §1/§2 describe",
  },
] as const;

const INVERSIONS: readonly LedgerRow[] = [
  {
    id: "forbidden bare-fn authoring form",
    gate: "McpEnvCapability annotation-lifting",
    replacedBy: "capability baked-symbol suites",
  },
  {
    id: "bare-fn env.set harness wiring",
    gate: "W8 ACallable-only env",
    replacedBy: "ANativeProcedure / hostFnToCallable harnesses",
  },
] as const;

/**
 * STAGED — §7 spec-law rows that are LEDGER-ONLY at Q5 (docs/PROVENANCE.md §7 law
 * table; two rows are LEDGER-ONLY, not stub files — they get an `@ledger` row citing
 * their flipping step but no law-test body yet). The surviving row below has no `it.todo`/
 * `it.fails` call anywhere in the six Q5 stub files (`laws/provenance-roles`,
 * `provenance/{wireframe-agreement,replay,track-cone,track-stream}`,
 * `doors/tier-honesty`) — this index entry IS its only test-suite presence today.
 * Distinct from GAPS/INVERSIONS (which index real `it.fails` rows the walker below
 * cross-references): a STAGED row is neither a documented gap nor a deliberate
 * inversion, it's a §7 law the plan has explicitly deferred giving a body to.
 */
const STAGED: readonly LedgerRow[] = [
  {
    id: "loop-unroll",
    gate: 'first loop-cone consumer wave — the wireframe-walking driver / P11 drill-in (the row SURVIVED the Q-track completion audit (2026-07-10), never silently dropped. docs/PROVENANCE.md §7: "widened vs exact-via-count cones" (finding #19). Both sides\' machinery exists since Q16 — widened loop cones refuse per-wire γ with ReplayScopeError and reconstruct via aggregation count + playback — so the law is BODY-able; nobody has staged its body because no consumer demands the widened-vs-exact comparison yet)',
    replacedBy: "a future `provenance/track-cone.law.test.ts` it.todo row, once its consumer wave stages the body",
  },
] as const;

// The sunrise family dirs this walker governs — mirrors vitest.sunrise.config.ts's
// include list (laws/membrane/provenance/ledger land now; conformance/doors/agreement
// are pre-declared per docs/test-suite-architecture.md §2 and simply won't exist on disk yet).
const SUNRISE_DIRS = ["laws", "membrane", "provenance", "ledger", "conformance", "doors", "agreement"] as const;

const IT_FAILS_RE = /\bit\.fails\s*\(/;
const LEDGER_COMMENT_RE = /^\s*\/\/\s*@ledger:\s*(.+?)\s*$/;

const testsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectTestFiles(dir: string): string[] {
  // `readdirSync(dir, { withFileTypes: true })` (no `encoding`) resolves the
  // `Dirent[]` (i.e. `Dirent<string>`) overload — `ReturnType<typeof readdirSync>`
  // picks the OTHER (`encoding: "buffer"`) overload's `Dirent<Buffer>[]` instead,
  // since an overloaded function's `typeof` resolves to its last signature.
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // dir doesn't exist yet (conformance/doors/agreement, pre-population)
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Walks every sunrise `.test.ts` file for `it.fails(` occurrences and checks each one's
 * immediately-preceding non-blank line for a `// @ledger: <id>` comment whose id resolves
 * against `knownIds`. Returns one human-readable violation string per problem found.
 */
function findUnledgeredFails(knownIds: ReadonlySet<string>): string[] {
  const violations: string[] = [];
  for (const dirName of SUNRISE_DIRS) {
    for (const file of collectTestFiles(join(testsRoot, dirName))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return; // doc-comment mentions don't count
        if (!IT_FAILS_RE.test(line)) return;
        let ledgerId: string | undefined;
        for (let back = idx - 1; back >= 0; back--) {
          const prev = lines[back];
          if (prev.trim() === "") continue; // blank lines don't break the search
          const match = prev.match(LEDGER_COMMENT_RE);
          if (match) ledgerId = match[1].trim();
          break; // first non-blank line decides it either way
        }
        const loc = `${file}:${idx + 1}`;
        if (!ledgerId) {
          violations.push(`${loc}: it.fails with no preceding "// @ledger: <id>" comment`);
        } else if (!knownIds.has(ledgerId)) {
          violations.push(`${loc}: @ledger id "${ledgerId}" has no matching GAPS/INVERSIONS row`);
        }
      });
    }
  }
  return violations;
}

describe("ledger — every gap names its gate", () => {
  it.each(GAPS.map((g) => [g.id, g] as const))("GAP %s", () => {});
  it.each(INVERSIONS.map((g) => [g.id, g] as const))("INVERTS %s", () => {});

  it.each(STAGED.map((g) => [g.id, g] as const))("STAGED %s", () => {});

  it("meta: no it.fails exists in the suite without a ledger row (walker)", () => {
    const knownIds = new Set([...GAPS, ...INVERSIONS].map((row) => row.id));
    const violations = findUnledgeredFails(knownIds);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it.todo("meta: no ledger gate references a ruling/migration that has already landed (staleness alarm)");
});
