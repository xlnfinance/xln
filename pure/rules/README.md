# Rule register and its gate

The register is the folder `register/`: one file per rule, `register/<id>.json`, holding that rule's row. Two changes that add or edit different rules touch different files, so they never conflict. Rows are read in id order. `bun rules/check.ts` (from `pure/`) reads the NAMES of things that check and fails when the register and the names disagree, then runs the style gate of the new tree (`kernel/`, `chain/`; see `style/README.md`), folder width (below) and contract-test placement (below), so there is one gate command and one exit code (`--register-only`, `--style-only`, `--width-only`, `--tests-only` and `--forge-only` run just that part through the same table the plain command uses; `--matrix` prints only the matrix). Tests: `bun test rules`.

**Id policy (coordinator, 09-30).** New rule ids are descriptive names (`R-SOMETHING`), never bare numbers, so ids from different sources cannot collide. Review-finding ids (`F1`, `G1`, `S1`, ...) name findings only and are never rules. This sentence is the policy; it used to be a field at the top of `register.json`. A rule is retired with `retired_by: [successor ids]`, not deleted; a retired row needs no killer and claims no layer.

## A row

| field | meaning |
|---|---|
| `id` | the rule's id, as it appears in names: `J5`, `R-CLOCK`, `R2C-DEBT-FIRST` |
| `statement` | the rule in one sentence, copied in meaning from its source decision |
| `source` | where it was decided |
| `layers` | one cell per layer: `arrival`, `quint`, `contract`, `rig`, `ts` |
| `killers` | what fails when the rule is broken: a `test`, a planted `bug` or a `mutant`, each with its layer and name |

**Every live rule states every layer.** A cell is one of five things:

- `"hold"`: a name in this layer must carry the id; the gate fails when none does.
- `"owed: <who>"`: the layer must hold it and a named PR or slice brings the name. It is shown as open, and the gate fails once a name already carries the id, so the waiver cannot outlive the work.
- `"stale: <what is out of date and who brings the current version>"`: a name in this layer carries the id, but the layer models an earlier version of the rule (the rule was revised and the layer has not caught up). It counts as owed, never as held, so the progress report does not claim more than the layer says. The gate fails when no name carries the id (then the cell is `owed`), and a stale cell may be promoted to `hold` once the layer models the current rule; the gate cannot see that, so the PR that revises a rule flips the layers that trail it to `stale` and the PR that catches a layer up flips it back, each stating the cell for review.
- `"n/a: <why>"`: the layer has no part in this rule, said in one line from what the rule says (`"n/a: an off-chain rule; no contract code takes part in it"`). A bare `n/a` is refused. The gate fails when a name in that layer already carries the id (the layer plainly has a part), and a killer may not sit in an `n/a` layer. An `n/a` cell leaves the layer's required count, so the progress report prints how many there are, and the PR that writes one lists it for review.
- `"-"`, or a layer left out: unstated. The gate fails on it for every live rule (`UnstatedCell`); only a retired row may leave a layer unstated.

A killer may carry `"owed": "<who>"` the same way as an owed cell.

The gate is a naming gate: it never runs the specs, the mutants or the tests, so `found` means a named killer exists, not that the bug is killed. Walks and mutant runs are the other half.

**The register only grows.** `bun rules/check.ts` also compares the register with the one at the merge base with `origin/main` (`--base <ref>`): a row may not vanish, a cell may not drop from `hold` or `stale` to `owed`, from `owed` to `n/a`, or from any stated cell back to `-`, and a killer the base named (not owed) may not disappear. A claim (`hold`, `owed`) outranks `n/a`, so a rule cannot leave a column's denominator by giving a reason; `n/a` to `owed` or `hold` is growth. A rule is retired with `retired_by`, into live rows, and the gate prints the retirement. A git failure is red.

## What counts as a name

Only checks that run count.

- TypeScript: `describe`, `it`, `test` (and `.only`) called bare at the top of a file or inside an enclosing `describe`. Not `.skip`, `.todo`, `.skipIf`, `xit`, member calls (`re.test(`), calls under `if (false)` or in a helper, calls in comments or strings, or anything inside a skipped describe.
- A test file's own name counts only when the file holds at least one counted test.
- Foundry: public or external `test*` and `invariant*` functions in a concrete contract that inherits a base. Not internal or private functions, abstract contracts, `check*` or `prove*`.
- Arrival: `property`, `step-property` and `liveness` strings and planted-bug file names. (Dead code such as a property inside an uncalled helper is not detected.)
- Quint: `run` names, invariants a check script passes to `quint run --invariant`, and mutant ids (a mutant whose `why` opens with `R-A1:` also carries that tag). Not `val`, `def` or `action`.
- Contract tests are read only from folders a gate runs: `contracts/test/vm/<area>/`, `contracts/test/gate/`, `contracts/test/foundry/` (the same globs as the `contracts-fork` job; a file straight under `vm/` is in none). A rule held only in a Hardhat-only file (`dispute/`, `governance/`, `protocol/`) is owed until that test moves into a gated folder. `bun rules/check.ts --tests-only` keeps that honest: a contract test in any other folder is red (`UNGATED_CONTRACT_TEST`) unless it is on `HARDHAT_ONLY` in `rules/checks/contract-tests.ts`, and a listed file that is gone or now gated is red too (`STALE_HARDHAT_ONLY`).
- The Foundry suite runs inside the gate: `bun rules/check.ts --forge-only` runs `forge test --root contracts` (`export PATH=$PATH:/foundry`; forge-std from `cd contracts && bun run forge:setup`). A failed or skipped test is red (`FORGE_TESTS_FAILED`, `FORGE_TESTS_SKIPPED`), and so is a run that saw a different number of tests than the register's reader counts under `test/foundry/` (`FORGE_COUNT_MISMATCH`: a filter, a wrong root, a file forge did not compile). No forge or no forge-std is red, never skipped (`FORGE_MISSING`, `FORGE_STD_MISSING`). The CI `contracts-fork` job runs the same command, so the skip and count checks apply there too. forge-std is judged by `contracts/scripts/setup-forge-std.sh` (commit, origin, clean tree): a tampered or stale checkout is red (`FORGE_STD_UNVERIFIED`). `contracts/foundry.toml` pins a fuzz seed so a rejected-inputs run cannot turn the gate red at random.

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

- `rules/ci/ci-drift.test.ts` (run by `bun test`) compares what GitHub CI repeats with its source: every `bun-version` in `.github/workflows/` with `packageManager` in the root `package.json`, the gate's seed matrix with the default seeds of `test:seeds` in `pure/package.json`, and the `ast-grep-cli` version the workflow installs with the one `style/check.ts` runs through uvx. A planted drift in each is a named problem (`CI_DRIFT_*`). Copies are read from code, never from a comment; every file in `.github/workflows/` counts, `.yaml` too; and a form the comparison cannot read (a `setup-bun` step with no `bun-version`, a `bun-version-file`, an `ast-grep-cli` install with no `==version`) is a problem of its own. Row `R-GATE-CI-DRIFT` holds these tests as ts killers.
- `bun rules/check.ts --timeouts-only` (part of the plain command, `rules/checks/timeouts/heavy-timeouts.ts`) fails a heavy test that names no timeout (`TEST_TIMEOUT_MISSING path:line`). Bun gives every test 5 s unless told otherwise, so the suite runs with no `--timeout` flag (`bun test`, `bun run test:seeds`, the CI jobs) and a heavy test carries its own: `test("...", async () => {...}, 120_000)`. Heavy is read from the test's code: it starts a bun, forge, ast-grep, quint or uvx process (every test that runs the gate on a tree), opens og's world or lane (`openWorld`, `createLane`, `bootChain`, `walk`), calls an explorer (`explore...`), or lists or copies a tree of files (`existingFiles`, `cpSync`, `copyFileSync`, a recursive `readdirSync`: a scratch copy of pure/ is about 3,800 files and takes seconds on a loaded machine without starting a process), directly or through a helper of its own file, in a test or in a `beforeAll`, `beforeEach`, `afterAll` or `afterEach` hook (hooks have the same 5 s default; a hook's timeout is its second argument). Size the timeout from the measured run time with headroom: 30_000 up to 3 s, 60_000 up to 6 s, 120_000 up to 12 s, 600_000 above (at least 10 times the run time; the junit reporter gives it: `bun test --reporter=junit --reporter-outfile=out.xml`). Every test that took over 1 s when measured names one as well, heavy by the signature or not. Not seen: a heavy call that comes through a helper of another file, a helper passed by name or three levels deep, a command held in a variable, `Bun.$` or `bash -c`, `test.each` and other test forms, a test file not named `*.test.ts`, `.tsx` or `.mts`, a third argument that is not a timeout, and a slow test that makes none of the calls above; for those the plain run is the check (a test over 5 s with no timeout fails on any machine).
- `bun rules/check.ts --contracts-only` (part of the plain command, `rules/checks/contracts/contracts-vm.ts`) runs the contracts/ BrowserVM and deploy-gate tests the way CI does: `bash contracts/scripts/build.sh` must leave `contracts/typechain-types` as it was (`TYPECHAIN_STALE`), then every `contracts/test/vm/<area>/*.test.ts` and `contracts/test/gate/*.test.ts` runs in a process of its own (`CONTRACTS_TEST_FAILED file exited N`, with the end of its output). The files are the ones `rules/scan.ts` calls gate tests, so a test the placement check accepts is a test this part runs. It takes about as long as CI's contracts job (several minutes), needs hardhat's solc (downloaded once, then cached under `~/.cache/hardhat-nodejs`) and `anvil` (Foundry) for `deploy-dry-run.test.ts`. CI's contracts job runs this same command, not a loop of its own.
- CI steps are compared with the gate (`pure/rules/ci/ci-steps.ts`, run by `rules/ci/ci-drift.test.ts`): every `run:` command of a job that `One gate` needs is a gate command (tsc, `bun rules/check.ts` with at most one part flag, frozen, style, `bun test`, `bun run test:seeds`) or set-up (`cd`, `bun install --frozen-lockfile`, `bun run forge:setup`, the ast-grep script); anything else, such as a test loop written in the workflow, is `CI_DRIFT_UNGATED_STEP`, and a gate command that no gate job runs any more is `CI_DRIFT_GATE_MISSING`. A new set-up command is added to `SETUP_COMMANDS` there, on purpose.
- CI set-up does not depend on one download: `.github/scripts/setup-ast-grep.sh` uses the uv and ast-grep the CI cache restored (the pinned ast-grep answers `uvx --offline`) and otherwise installs them with `.github/scripts/retry.sh` (three tries), with pip and uv timeouts of 120 s; forge-std (a pinned checkout) and hardhat's solc are cached as well. Bun comes from `setup-bun`, which caches its own binary, and Foundry is pinned to one version; neither has failed on a download so far. Both scripts are tested against stub tools in `rules/ci/setup-scripts.test.ts`.
- The gate workflow cannot skip a PR (`pure/rules/ci/ci-triggers.ts`, run by the same drift test): the five `One gate` checks are required, so a PR that never gets them stays blocked. `pull_request` is a trigger with no `branches`, `branches-ignore`, `paths`, `paths-ignore` or `types` filter, no job behind `one-gate` has a job-level `if` (a skipped job reports success), and `one-gate` has none but `${{ always() }}`. One case no workflow setting can reach: GitHub starts no `pull_request` run on a PR whose branch conflicts with its base, which is why PR 65 showed no checks at 3cf41b4 (the cause is inferred, not read: that PR has no run of any kind, and the workflow had no paths filter). The conflict blocks the merge by itself and clears with the next push.
- The names the ruleset requires are pinned (`pure/rules/ci/ci-checks.ts`, list in `.github/required-checks.json`, a copy of the ruleset's `required_status_checks`): every required name must be reported by a job of the gate workflow, a matrix job once per value, so renaming a job or dropping a seed is red here. The copy of the ruleset's list cannot be checked offline: change the ruleset and the file together.

## The progress report

`bun rules/progress.ts [--since <ref>] [--skip-verify]` (from `pure/`) is read-only and is not part of the gate. It prints, for each column (Arrival, Quint, ts code, contracts, walk), how many rules hold out of how many the column must carry (held, owed and a `hold` cell no name carries; an `n/a` or unstated cell is not required), the percent, and the total over all five. The last two columns count the live rules whose cell says `n/a` (with a reason in the register) and the live rules whose cell is unstated, so a column at 100% is read against how many rules it leaves out of its denominator. The gate is red on an unstated cell, so on a green tree the unstated column is 0. It also says how many rules the register gained and lost since a commit (default: the merge base with `origin/main`; `--since <ref>` names another, exactly), with the ids up to 10, and each column's percent and denominator then and now. Retiring a rule takes it out of both numbers, so the retired ones are printed. The "then" side is counted from the cells of that commit's register (it has no names), the "now" side from the names; they agree on a green tree.

The header names the branch and says whether the checkout is clean or dirty. Everything is read from the checkout except the Arrival and Quint milestones, which are read from `origin/main` (its register, and its `spec/` unpacked from git); with no `origin/main` they print `unchecked`.

It then prints the six goal milestones, each with what it rests on. Arrival on main and Quint on main are done when the column on `origin/main` is complete: something required, all of it held, nothing owed and no cell unstated, so retiring or blanking rules cannot finish them. xln.ts cut to the spec and the walk are done by the same test on their column in the checkout; every line prints how many live rules say `n/a` there. Contracts reviewed and deployed is done only when the contract column is complete, `contracts/deploy/sepolia.manifest.json` is valid with status `deployed`, and `bun contracts/deploy/verify.ts` (run by the report; read-only, no key) exits 0: the code the chain holds at every address is the current build's, and the line quotes the block it was read at. Exit 1 with the block line in its output (a contract differs) is `not done`; exit 1 without it is Bun failing to start the verifier (a missing module, say) and reads as could not check; exit 2, a run that never finished, or no run (`--skip-verify`, or a manifest that records no deployment) is `unchecked`, never done: the verifier needs a build (`bash contracts/scripts/build.sh`) and a Sepolia node, and a machine without them says `could not check` with the reason. The end-to-end Sepolia run (open, pay, HTLC across hubs, swap, dispute) has no check in this report and prints `unchecked`. The column milestones rest on names, like the gate: they say what is named, not what a walk or a mutant run has shown.

The banner `the register evaluation is red` counts only the register evaluation (missing names, stale waivers); the ratchet, style, folder width, contract-test placement and forge parts of the composed gate are not run here: use `bun rules/check.ts`. Tests: `rules/progress/measure.test.ts`.

## The gate's own tests are registered

Rows `R-GATE-REGISTER`, `R-GATE-FROZEN`, `R-GATE-STYLE`, `R-GATE-WIDTH` and `R-GATE-COMPOSE` hold the gate's fools as named ts killers (the ts layer reads `pure/rules/` tests too). A skipped or deleted fool is a missing name, so the register gate is red. `rules/checks/compose.ts` turns the parts into one exit code, and `compose.test.ts` runs the real command over a scratch copy of `pure/` with a planted throw and a folder of 11 files.

## Known reds that are og's

- `tests/unit/runtime-folder-width.test.ts` (root) imports og's `core/scripts/checks/architecture/check-folder-width.ts`, which this branch keeps at `566c850`. Main carries a seven-line edit to that file (the generated `spec/arrival` and contracts folders excluded, `contracts/contracts` debt of 16); the revert takes it out, so the test "the repository has only the exact declared source-folder debt" fails with `FOLDER_TOO_WIDE spec/arrival/...`. It fails on og's side by design: `frozen.ts` has no exceptions, because "og is untouched" is worth nothing as a gate with one. No gate of ours loads it (`gate:rules`, `bun test` in `pure/`, `check:folder-width`, `tsc`, `style/check.ts` read `pure/`, `core/`/`jurisdictions/` by git, and nothing under `tests/unit/`). If a runner ever picks it up, exclude it in our gate config, never in og.

## Known limits of the name readers

- The gate is a naming gate: it does not run specs or mutants, and a test that throws before it asserts still counts.
- Dead code inside an Arrival helper, an `if false` branch in a Quint `.sh`, Scheme quoted data and `#| |#` blocks count as names.
- A regex literal is found by where it can start (after an operator, `=>`, an opening bracket, or `return`); an unusual layout such as a regex after a `)` of an `if (...)` is read as division.
- A retirement into any live row is a NOTE, not a failure: read the NOTE lines.

## The register is a folder, one file per rule

`register/<id>.json` holds one row (`id`, `statement`, `source`, `layers`, `killers`, and `retired_by` for a retired rule), printed with one space of indent. The file's name must be the row's id plus `.json`; nothing else may be in the folder, except names that start with a dot (`.DS_Store`, an editor's swap file), which are ignored (a stray directory, a README or a misnamed file is red, and so is a `register.json` beside the folder). Ids are letters, digits and hyphens only, since an id names a file; two ids that differ only in case are refused, because on a case-insensitive file system (a Mac) they would be one file. The loader reads the files in id order, so the matrix lists rules alphabetically. The ratchet and the progress report read a base commit in either layout: the folder, or the single `register.json` of a commit from before the split.

A branch that edited the old `register.json` meets the folder on merge as a conflict on that file, and the stage that holds the branch's own version depends on which side is merging (from the repository root; `:1:` is the version the branch started from):

```
git show :1:pure/rules/register.json > /tmp/base.json
git show :2:pure/rules/register.json > /tmp/theirs.json     # the branch merges the split: its own file is stage 2 (modify/delete)
git show :3:pure/rules/register.json > /tmp/theirs.json     # the branch already has the folder and merges main, which edited the old file: stage 3 (delete/modify)
git rm -q pure/rules/register.json
(cd pure && bun rules/layout/register-split.ts port /tmp/base.json /tmp/theirs.json)
git add pure/rules/register
```

Use one of the two `theirs` lines (`git ls-files -u pure/rules/register.json` says which stage exists). In the second case "theirs" is main's edited file and "base" is the old file the folder was split from; the port then brings main's edits into the folder.

Rows the file's side added or changed are written, rows it removed are deleted, and a rule the folder changed since the branch started is reported as a conflict and left for the author. `register-split.ts split <old.json>` writes the whole folder from an old file, and `register-split.ts verify <old.json>` exits 0 only when the folder holds exactly those rules with identical data (the equality the split commit was checked with).
