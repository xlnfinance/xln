# Rule register and its gate

`register.json` has one row per rule id. `bun rules/check.ts` (from `pure/`) reads the NAMES of things that check and fails when the register and the names disagree, then runs the style gate of the new tree (`kernel/`, `chain/`; see `style/README.md`), folder width (below) and contract-test placement (below), so there is one gate command and one exit code (`--register-only`, `--style-only`, `--width-only`, `--tests-only` and `--forge-only` run just that part through the same table the plain command uses; `--matrix` prints only the matrix). Tests: `bun test rules`.

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
- Contract tests are read only from folders a gate runs: `contracts/test/vm/<area>/`, `contracts/test/gate/`, `contracts/test/foundry/` (the same globs as the `contracts-fork` job; a file straight under `vm/` is in none). A rule held only in a Hardhat-only file (`dispute/`, `governance/`, `protocol/`) is owed until that test moves into a gated folder. `bun rules/check.ts --tests-only` keeps that honest: a contract test in any other folder is red (`UNGATED_CONTRACT_TEST`) unless it is on `HARDHAT_ONLY` in `rules/checks/contract-tests.ts`, and a listed file that is gone or now gated is red too (`STALE_HARDHAT_ONLY`).
- The Foundry suite runs inside the gate: `bun rules/check.ts --forge-only` runs `forge test --root contracts` (`export PATH=$PATH:/foundry`; forge-std from `cd contracts && bun run forge:setup`). A failed or skipped test is red (`FORGE_TESTS_FAILED`, `FORGE_TESTS_SKIPPED`), and so is a run that saw a different number of tests than the register's reader counts under `test/foundry/` (`FORGE_COUNT_MISMATCH`: a filter, a wrong root, a file forge did not compile). No forge or no forge-std is red, never skipped (`FORGE_MISSING`, `FORGE_STD_MISSING`). The CI `contracts-fork` job runs the same suite.

Comments and strings never count. An id is carried when its tokens sit next to each other in a name: `J5` is in `j5-gas-exact` and `J5 a failing batch...`, not in `J50`; `R-CLOCK` is not in `R-HTLC-CLOCK`. Titles and property strings are matched case-sensitively, identifiers in any case.

## Adding or changing a rule

1. Add the row. Put the id in the name of every check that holds it (`it("R-FOO ...")`, `(property "... (R-FOO)" ...)`, a bug file `r-foo-...scm`).
2. Set each cell. A killer that does not exist yet is `owed`. A row with no killer fails the gate.
3. Register progress: `bun rules/check.ts --matrix` prints the matrix and the per-layer counts (held, owed, required).

Helpers: `--who <id>` lists the names that carry an id; `--layer-root arrival=<dir> --layer-root quint=<dir>` projects the matrix onto another checkout of the specs, which is how a spec PR is checked before it merges.

Never add a rule here that a decision did not make: the register records decisions, it does not make them.

## Other gates in this folder

- `bun rules/checks/frozen.ts` fails when the tree differs from og at `566c850` under `core/` or `jurisdictions/` in any way (edit, delete, rename out, mode change, untracked file, non-ASCII path). The allowlist is empty for good; a failing git is red.
- `bun pure/rules/checks/folder-width.ts` is the root `check:folder-width`, and `bun rules/check.ts` runs it too: og's limits and debt table (copied at `566c850`, plus `contracts/contracts` and the generated contracts folders), on the files git lists (tracked plus untracked, never ignored), so a dev machine's gitignored folders (`contracts/.typechain-hardhat`, `contracts/lib/forge-std`) do not widen a folder. It does not read og's script.

## The gate's own tests are registered

Rows `R-GATE-REGISTER`, `R-GATE-FROZEN`, `R-GATE-STYLE`, `R-GATE-WIDTH` and `R-GATE-COMPOSE` hold the gate's fools as named ts killers (the ts layer reads `pure/rules/` tests too). A skipped or deleted fool is a missing name, so the register gate is red. `rules/checks/compose.ts` turns the parts into one exit code, and `compose.test.ts` runs the real command over a scratch copy of `pure/` with a planted throw and a folder of 11 files.

## Known reds that are og's

- `tests/unit/runtime-folder-width.test.ts` (root) imports og's `core/scripts/checks/architecture/check-folder-width.ts`, which this branch keeps at `566c850`. Main carries a seven-line edit to that file (the generated `spec/arrival` and contracts folders excluded, `contracts/contracts` debt of 16); the revert takes it out, so the test "the repository has only the exact declared source-folder debt" fails with `FOLDER_TOO_WIDE spec/arrival/...`. It fails on og's side by design: `frozen.ts` has no exceptions, because "og is untouched" is worth nothing as a gate with one. No gate of ours loads it (`gate:rules`, `bun test` in `pure/`, `check:folder-width`, `tsc`, `style/check.ts` read `pure/`, `core/`/`jurisdictions/` by git, and nothing under `tests/unit/`). If a runner ever picks it up, exclude it in our gate config, never in og.

## Known limits of the name readers

- The gate is a naming gate: it does not run specs or mutants, and a test that throws before it asserts still counts.
- Dead code inside an Arrival helper, an `if false` branch in a Quint `.sh`, Scheme quoted data and `#| |#` blocks count as names.
- A regex literal is found by where it can start (after an operator, `=>`, an opening bracket, or `return`); an unusual layout such as a regex after a `)` of an `if (...)` is read as division.
- A retirement into any live row is a NOTE, not a failure: read the NOTE lines.
