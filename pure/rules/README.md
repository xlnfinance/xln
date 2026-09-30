# Rule register and its gate

`register.json` has one row per rule id. `bun rules/check.ts` (from `pure/`) reads the NAMES of things that check and fails when the register and the names disagree. Tests: `bun test rules`.

**Id policy (coordinator, 09-30).** New rule ids are descriptive names (`R-SOMETHING`), never bare numbers, so ids from different sources cannot collide. Review-finding ids (`F1`, `G1`, `S1`, ...) name findings only and are never rules. The policy is also the `policy` field at the top of `register.json`. A rule is retired with `retired_by: [successor ids]`, not deleted; a retired row needs no killer and claims no layer.

## A row

| field | meaning |
|---|---|
| `id` | the rule's id, as it appears in names: `J5`, `R-CLOCK`, `R2C-DEBT-FIRST` |
| `statement` | the rule in one sentence, copied in meaning from its source decision |
| `source` | where it was decided |
| `layers` | one cell per layer: `arrival`, `quint`, `contract`, `rig`, `ts` |
| `killers` | what fails when the rule is broken: a `test`, a planted `bug` or a `mutant`, each with its layer and name |

A cell is `"-"` (this layer does not hold the rule, or no slice has claimed it: never checked), `"hold"` (a name in this layer must carry the id: the gate fails when none does) or `"owed: <who>"` (the layer must hold it, a named PR or slice brings the name: shown as open, and the gate fails once a name already carries the id, so the waiver cannot outlive the work). A killer may carry `"owed": "<who>"` the same way.

The gate is a naming gate: it never runs the specs, the mutants or the tests, so `found` means a named killer exists, not that the bug is killed. Walks and mutant runs are the other half.

**The register only grows.** `bun rules/check.ts` also compares the register with the one at the merge base with `origin/main` (`--base <ref>`): a row may not vanish, a cell may not drop from `hold` to `owed` or from `owed` to `-`, and a killer the base named (not owed) may not disappear. A rule is retired with `retired_by`, into live rows, and the gate prints the retirement. A git failure is red. Every row needs at least one layer that is not `-`.

## What counts as a name

Only checks that run count.

- TypeScript: `describe`, `it`, `test` (and `.only`) called bare at the top of a file or inside an enclosing `describe`. Not `.skip`, `.todo`, `.skipIf`, `xit`, member calls (`re.test(`), calls under `if (false)` or in a helper, calls in comments or strings, or anything inside a skipped describe.
- A test file's own name counts only when the file holds at least one counted test.
- Foundry: public or external `test*` and `invariant*` functions in a concrete contract that inherits a base. Not internal or private functions, abstract contracts, `check*` or `prove*`.
- Arrival: `property`, `step-property` and `liveness` strings and planted-bug file names. (Dead code such as a property inside an uncalled helper is not detected.)
- Quint: `run` names, invariants a check script passes to `quint run --invariant`, and mutant ids (a mutant whose `why` opens with `R-A1:` also carries that tag). Not `val`, `def` or `action`.
- Contract tests are read only from folders a gate runs: `contracts/test/vm/*/`, `contracts/test/gate/`, `contracts/test/foundry/`. A rule held only in `a12/`, `dispute/`, `governance/` or `protocol/` is owed until that test moves into a gated folder.

Comments and strings never count. An id is carried when its tokens sit next to each other in a name: `J5` is in `j5-gas-exact` and `J5 a failing batch...`, not in `J50`; `R-CLOCK` is not in `R-HTLC-CLOCK`. Titles and property strings are matched case-sensitively, identifiers in any case.

## Adding or changing a rule

1. Add the row. Put the id in the name of every check that holds it (`it("R-FOO ...")`, `(property "... (R-FOO)" ...)`, a bug file `r-foo-...scm`).
2. Set each cell. A killer that does not exist yet is `owed`. A row with no killer fails the gate.
3. Register progress: `bun rules/check.ts --matrix` prints the matrix and the per-layer counts (held, owed, required).

Helpers: `--who <id>` lists the names that carry an id; `--layer-root arrival=<dir> --layer-root quint=<dir>` projects the matrix onto another checkout of the specs, which is how a spec PR is checked before it merges.

Never add a rule here that a decision did not make: the register records decisions, it does not make them.

## Other gates in this folder

- `bun rules/checks/frozen.ts` fails when the tree differs from og at `566c850` under `core/` or `jurisdictions/` in any way (edit, delete, rename out, mode change, untracked file, non-ASCII path). The allowlist is empty for good; a failing git is red.
- `bun pure/rules/checks/folder-width.ts` is the root `check:folder-width`: og's limits and debt table (copied at `566c850`, plus `contracts/contracts` and the generated contracts folders), on the files git lists (tracked plus untracked, never ignored), so a dev machine's gitignored folders (`contracts/.typechain-hardhat`, `contracts/lib/forge-std`) do not widen a folder. It does not read og's script.
