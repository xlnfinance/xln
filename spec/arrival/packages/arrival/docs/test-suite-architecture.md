# Test Suite Architecture

_Derived from PRINCIPLES.md: the suite's job is to enforce the constitution, and its strongest
form is the coherence law (P15) — one invariant × a table of subjects, `describe.each`/`it.each`
all the way down. Point tests exist only where a law genuinely has one subject._

## 1. What the suite enforces (the invariant families)

**F1 — Term×Carrier coherence (P0/P8).** For every tagless term (map, filter, reduce, sort,
concat, equals, length, car/cdr, toJS, print) × every carrier that implements it (APair,
AVector, AJSArray, AString where applicable, ADict where applicable): the VALUE result
matches the reference semantics AND the BOX discipline matches the law's declaration
(box-preserving / box-unioning / container-minting). One `describe.each(TERMS)` ×
`it.each(CARRIERS)` grid. A carrier that legitimately doesn't implement a term is an explicit
`unsupported` cell, not an absent row — an absent row is indistinguishable from an untested
one, which is exactly how a carrier can ship `map` and silently lack `filter` without the
grid ever showing a gap.

**F2 — Provenance conservation (P10/P11).** Property-based + golden:

- conservation: for generated pure programs, every input provenance id is reachable in the
  output's deep-collapsed provenance (no drops — append/cdr become rows here);
- minting: ids appear ONLY at declared source crossings (mint-at-edge);
- purity: `pure: true` ops never mint (the seal-laundering guard, generalized);
- idempotence/commutativity/associativity of union (absorbs provenance-algebra.property).
  The eager goldens (golden-prov-\*) stay as the oracle side of the static-lineage coherence law.

**F3 — Membrane crossing laws (P4/P5).** ONE table: every value type × both directions ×
(representation-in, representation-out, round-trip promise yes/no). The exit convention is a
single column — the table structurally cannot express "strings boxed, booleans raw" without
the contradiction being visible in the diff, which is what keeps the convention from drifting
once it's decided. Strict doors: every forbidden crossing (raw into toJS,
borrowed fn, AValue from JS) is an `it.each` over the violation table asserting the TAUGHT
message.

**F4 — Value-layer conformance (P15 coherence with the spec).** The chibi harness runs one
vitest test per scheme test form (see `src/__tests__/scheme-compliance/conformance/README.md`);
r7rs-numbers/unicode/identity fold in as arrival-specific extension tables beside it.

**F5 — Region discipline (P6).** Reverse-lambda scoping laws (call-after-return throws,
pending-at-return throws, abort cancels, per-scope wrapper identity) in
`src/membrane/__tests__/region.law.test.ts`.

**F6 — Doors (P5/errors-as-doors).** Registry-driven: `it.each(WELL_KNOWN_SYMBOLS)` asserts
every stubbed/famous name doors with a message naming its alternative; every resource cap
(allocation, budget, nesting) doors with the policy message, not an engine error. The registry IS
the test input — a door added without a registry row fails the completeness floor.

**F7 — Static-interpretation agreement (P0's N-interpreter clause).** The existing strong
suites, kept and named as a family: oracle-contract (Σ vs reference), lineage-spike (static
classifier vs eager stamps), `.test-d.ts` type-level tests (tsc-as-interpreter bite-guards),
name-escape (bifunctor law). New suites join this family with the same shape: interpreter A
vs interpreter B over a shared corpus, divergence = throw.

**F8 — The ledger (P15's taxonomy).** One suite that OWNS the truth table: every `it.fails`
gap row cites its fix gate; every `it.todo` cites its staging gate; every `[INVERTS: gate]`
transitional row is indexed here with the law row that replaces it. CI can then answer "what
does green mean" mechanically: nothing red-expected is silently green, nothing green is a lie.

**F9 — Drift alarms (P16's sanctioned pins).** Pack symbol counts, anti-vacuity floors,
registry completeness — each with its rationale string IN the table row.

## 2. Architecture

```
src/__tests__/
  laws/            F1 term-carrier grids, equality, identity (nil-clone), accessor, env-resolution
    _tables/       shared describe.each inputs: CARRIERS, TERMS, CROSSINGS, VIOLATIONS —
                   typed, single-sourced; a law file imports its table, never redeclares it
  provenance/      F2 conservation + minting + purity; goldens as oracle fixtures
  scheme-compliance/conformance/   F4 chibi v2 + arrival extension tables (r7rs-*)
  doors/           F6 registry-driven door suites
  ledger/          F8 gap/staging/inversion index
  oracle-contract.spec.ts   F7's oracle-contract (Σ vs reference); still loose at the top
                   level, not yet relocated into a dedicated family directory

src/membrane/__tests__/   F3 crossing tables, strict doors, egress; also F5 region
                   discipline (region.law.test.ts)
```

Conventions:

- **Law files are named `<subject>.law.test.ts`** and contain ONE law (possibly many rows).
- **Tables are data modules** (`laws/_tables/*.ts`), typed, imported by law files AND usable
  by future interpreters (the static lineage classifier can consume CARRIERS/TERMS too).
- **No helper tolerance**: comparison helpers assert ONE representation (the P4 exit
  convention). A helper that accepts boxed-or-raw is a P4 violation in test clothing.
- **Every table row is individually addressable** in vitest output (`%s` naming from row
  fields) — a failing cell names its term, carrier, and law.
- **Stubs-first discipline**: new law families land as `it.todo` grids with the full tables
  populated — the SHAPE of the suite (which cells exist) is reviewable before any assertion
  body is written. A stub grid that can't express an invariant is a design bug caught free.
