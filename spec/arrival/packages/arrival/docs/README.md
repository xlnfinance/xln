# Arrival — docs

For contributors to the `arrival` interpreter. This is the index: what the machine is, where
each subsystem is documented, and where its code lives. Read `PRINCIPLES.md` first, then the
one subsystem you are touching.

## What arrival is

> **Arrival executes every program twice at once — as computation over values and as
> provenance over boxes — and everything else is what it takes to keep the two executions
> telling the same story.** (`PRINCIPLES.md`, the one-sentence version)

Every value is boxed because an unboxed value is a term the provenance interpreter cannot
execute; the membrane is where the second interpreter's world ends; assembly, the run model,
and the static plane all exist to keep the two readings coherent.

## The load-bearing absences

Four things arrival does NOT have. Each is invisible in the code — a contributor must meet
them before touching any subsystem, because a change that reintroduces one breaks the machine
at a level no local test names.

- **No continuations.** `call/cc`/`dynamic-wind` are deliberately absent — the classical
  region-escape channel, closed on purpose (`PRINCIPLES.md` P0; `PROVENANCE.md`
  constitutional ground).
- **No mutation.** Values are frozen at construction; the mutator family is teaching-doored.
  The only writes are two named doors — cycle knot-tying and phase-gated assembly binding
  that dies at phase close. Mutation is the classical isolation-escape channel (`PRINCIPLES.md`
  P2).
- **Dependencies point down, only down.** A capability declares a `deps` edge and uses the
  granted names; it never reaches sideways into another capability's internals, and the
  kernel interprets nothing above itself (`environments.md` §CAPABILITY).
- **One egress door.** Egress always fully unwraps — outside the membrane only plain JS
  exists, provenance stays in the trace. The simple exit wraps the complex one, so there is
  exactly one exit point to audit; a raw value reaching it is refused, never passed through
  (`RULINGS.md` R1).

## Codemap

Subsystem → its doc → the source it governs. Modules are named, not linked — search by the
directory name; names survive `git mv`, links rot.

| Subsystem               | Doc                          | Source                                                                                   |
| ----------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| Grammar / reader        | `grammar.md`                 | `src/reader/`                                                                            |
| Environments / assembly | `environments.md`            | `src/env/`, `src/common/`                                                                |
| Membrane / FFI crossing | `membrane.md`                | `src/membrane/`                                                                          |
| Execution / run model   | `execution.md`               | `src/run/`, `src/eval/`                                                                  |
| Static-analysis plane   | `static-plane.md`            | `src/type-layer/`, `src/oracle/`, `src/static-validation/`, `@inhuman.tools/arrival-lsp` |
| Provenance              | `PROVENANCE.md`              | `src/provenance/`                                                                        |
| Loader / modules        | `environments.md` §LOADER    | `@inhuman.tools/arrival-modules`                                                         |
| Errors / doors          | `grammar.md` §ERRORS         | `src/errors.ts`                                                                          |
| Capability authoring    | `writing-capabilities.md`    | — (how-to over `src/common/`, `src/membrane/`)                                           |
| LLM agent card          | `llm-agent-card.md`          | — (system-prompt surface; custdev-measured)                                              |
| LLM language inventory  | `llm-language-guide.md`      | — (preferred vs compat; not the prompt)                                                  |
| Test discipline         | `test-suite-architecture.md` | `src/__tests__/`                                                                         |

The ledgers and reference material are not subsystems:

| Doc             | Role                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRINCIPLES.md` | The constitution — cross-cutting invariants (P-series) every subsystem obeys.                                                                                                                                                           |
| `RULINGS.md`    | Numbered, append-only cross-subsystem rulings (R-series) — the shared citation vocabulary.                                                                                                                                              |
| `strata.md`     | The bottom-up dependency-order registry — leaves, the closed-member-list interpreter knot, the one-directional layers above it, and the rules for extending them. The wall registry every subsystem doc's cycle notes should cite INTO. |
| `GLOSSARY.md`   | One-line canonical definition per invented term (box, membrane, egress, wire, …); a reference-canon, mints no ID series.                                                                                                                |
| `reference/`    | Exhaustive coverage/mapping tables (r7rs, srfi). Facts only.                                                                                                                                                                            |

## Reading paths

- **New contributor** — `PRINCIPLES.md` → this codemap → the one subsystem doc you are
  touching → its source dir.
- **LLM / agent authoring** — system prompt = `llm-agent-card.md` only. Human inventory /
  layer map = `llm-language-guide.md`. Grammar detail in `grammar.md`. Do not send
  `PRINCIPLES.md` as a model system prompt.
- **Reference lookup** — cite by ID: `RULINGS.md` R#, `PRINCIPLES.md` P#, a
  `reference/` table, or a subsystem doc's `§ANCHOR`. No prose reading needed.

## Register legend

Filename case is the normative-vs-explanatory signal, readable in `ls`:

- **`SHOUT.md` = normative / ledger / canon.** Mints its own stable-ID series, is the
  constitution, or is a declared reference-canon: `PRINCIPLES.md` (P-series), `RULINGS.md`
  (R-series), `PROVENANCE.md` (the spec, `§N` + Appendix A), `GLOSSARY.md` (term canon — mints
  no ID series). A citation resolves to a heading here.
- **`kebab-case.md` = explanation / how-to.** _Cites_ P/R IDs and `§ANCHOR`s; mints none:
  `grammar.md`, `environments.md`, `membrane.md`, `execution.md`, `static-plane.md`,
  `writing-capabilities.md`, `test-suite-architecture.md`.

The one exception: `grammar.md`'s **BG-series** (§BINDINGS, §CLAUSES) is a set of
grammar-internal, section-scoped rule tags mirroring the evaluator's own local `Rn` numbering
— not a cross-subsystem ledger, and cited only within `grammar.md`.
