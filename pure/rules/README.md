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

## What counts as a name

Test titles (`describe`, `it`, `test`), Foundry contract and `test*`/`invariant*`/`check*` function names, test file names, Arrival `property` and `step-property` strings, Arrival planted-bug file names, Quint `run`/`val`/`def`/`action` names, and Quint mutant ids (a mutant whose `why` opens with `R-A1:` also carries that tag). Comments never count. An id is carried when its tokens sit next to each other in a name: `J5` is in `j5-gas-exact` and `J5 a failing batch...`, not in `J50`; `R-CLOCK` is not in `R-HTLC-CLOCK`. Titles and property strings are matched case-sensitively, identifiers in any case.

## Adding or changing a rule

1. Add the row. Put the id in the name of every check that holds it (`it("R-FOO ...")`, `(property "... (R-FOO)" ...)`, a bug file `r-foo-...scm`).
2. Set each cell. A killer that does not exist yet is `owed`. A row with no killer fails the gate.
3. Register progress: `bun rules/check.ts --matrix` prints the matrix and the per-layer counts (held, owed, required).

Helpers: `--who <id>` lists the names that carry an id; `--layer-root arrival=<dir> --layer-root quint=<dir>` projects the matrix onto another checkout of the specs, which is how a spec PR is checked before it merges.

Never add a rule here that a decision did not make: the register records decisions, it does not make them.

## Other gates in this folder

- `bun rules/checks/frozen.ts [base]` fails when the branch touches `core/` or `jurisdictions/` (og, never edited).
- `bun pure/rules/checks/folder-width.ts` is the root `check:folder-width`: the same limits and debt table as og's check, counting tracked files only, so a dev machine's gitignored folders (`contracts/.typechain-hardhat`, `contracts/lib/forge-std`) no longer widen a folder.
