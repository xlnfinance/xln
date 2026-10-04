# AGENTS.md

The single instruction file for agents and people working in this repository. `CLAUDE.md` points here and holds no rules of its own. The project instructions Arthur set on the project (goal, Done list, process) are the source of this text; where this file and a message from Arthur differ, the message wins and this file is fixed to match.

## Goal

A pure-functional XLN that is ready for testnet, with a protocol spec you can check and an elegant implementation that follows it. We take og's ideas, not its code. og is a reference and a source of lessons, never the oracle.

Done means:

1. A compact spec of the Account, Entity, J and Runtime layers: data flow, control flow, state machines and the properties each layer keeps, with no open questions left.
2. The contracts are reviewed. Every flaw is fixed or accepted in writing, and every encoding the contracts read is pinned by a vector the contract itself produced.
3. `pure/xln.ts` is cut down to the spec and passes the relief test.
4. On fresh seeds, the walk checks the spec's properties every frame against the real contracts: a dispute pays out what both sides believed, money is conserved, credit holds, and both sides sign the same proof. Mutants in money, deadline and consensus code are killed, and CI is green.
5. The contracts are deployed on testnet and nodes run the implementation, with one scripted end-to-end run (`testnet-e2e/`).

Scope: the complete verified spec covers everything. v1 code covers payments, HTLC routing and disputes; v2 covers the order book, lending and boards. Not the goal: equality with og's bytes, fixing og's bugs, or og's frontend.

Current scope of the path to testnet (Arthur's plan "Convergence to development, then main", adopted 2026-10-03): open accounts, payments, multi-hub HTLCs, two-party swaps, disputes and recovery. Deferred: loans, cross-J, watchtower coordination, live Sepolia, structural refactor. Done item 5 above still names a loan; the plan defers it.

Order: collect (done), spec, implement, testnet. Code changes wait for the spec, except fixes to real bugs. Every open question gets one owner and a decision; the coordinator owns them.

## Where things are

| Path | What it is |
|---|---|
| `pure/` | The rewrite. New tree: `kernel/` `account/` `chain/` `entity/` `j/` `host/` `runtime/` `market/`. Old single file: `xln.ts` (frozen legacy, deleted once the walk judges the new tree). |
| `pure/rules/` | The rule register (`register/<id>.json`, one file per rule) and its gate. Read `pure/rules/README.md` before adding or changing a rule. |
| `pure/style/` | The style gate and its registered exceptions (`pure/style/README.md`). |
| `pure/diff/` | The og-parity rig and the walk. It judges the legacy file today. |
| `spec/` | The spec. Arrival is the main spec, vendored with its checker and MCP server; `spec/quint/` is a complete duplicate in Quint. Each records unclear points in its own `QUESTIONS.md`. |
| `contracts/` | Our fork of the contracts, fixed here. Deployed Sepolia addresses and vectors: `contracts/deploy/`, `contracts/vectors/`. |
| `testnet-e2e/` | The scripted end-to-end run on an anvil fork of Sepolia. |
| `review/` | Reviews, one folder per pull request (`review/pr-<n>/`). |
| `docs/process-lanes.md` | Lanes, required checks, promotion to `main`. The CI thread keeps it in step with the workflows. |
| `.github/required-checks.json` | The check names each branch requires. |
| `core/`, `jurisdictions/` | og. Frozen reference at `566c850`; see the last section. |

Decisions of record live in the register, in `plan/` (convergence plan, consolidation plan, contracts decisions, process) in the project's shared files, and in issue #178 (the ledger of the convergence plan; PR #179 carries `plan/convergence-plan.md`). Check the register for an Arthur decision before changing process or CI. The older project files (GOAL, NOW, PICKUP, AUTHORITY, SOURCE, DSL, PROTOCOL-AUDIT) describe an earlier tree: history, not instructions.

## Evidence

- Claims are shown, never made. Per-function MATCH tests share the author's misreadings, so prefer whole-system checks: the walk, and the real contracts in BrowserVM. Every encoding a reader of chain bytes uses is pinned by a vector the contract produced, not by our own encoder.
- A scripted path passing is not the properties being checked. A test that accepts a forbidden outcome hides a money bug. A reviewer's clear is not an audit clear.
- Before saying "green", run these from `pure/` and report counts and the SHA:
  - `../node_modules/.bin/tsc --noEmit -p .`
  - `bun test --timeout 600000`
  - `bun run test:seeds`
  - `bun style/check.ts`
- A failing seed is a bug until proven otherwise. Never tune a seed or a generator to get green. "Flake" is not a root cause: a test that fails under load gets an explicit timeout or a fix.
- Say "merged" or "running" only after checking it (a PR state, a run, a log line).

## The gate

One gate, run from `pure/` unless noted. Name the command you ran when you report a result.

| Command | What it checks |
|---|---|
| `../node_modules/.bin/tsc --noEmit -p .` | Types. |
| `bun rules/check.ts` | Register (names, layers, ratchet against the base), tree style, folder width, contract-test placement, Foundry suite. `--matrix` prints register progress. Needs forge and forge-std (`cd contracts && bun run forge:setup`). |
| `bun rules/checks/frozen.ts` | `core/` and `jurisdictions/` are byte-identical to og. |
| `bun style/check.ts` | The legacy file's style ratchet. |
| `bun test`, `bun run test:seeds` | Tests; the three seeds `SEEDX=0 12345 987654`. |
| `cd spec && node test.mjs` | The Arrival pages and planted bugs (build first: `spec/package.json` `setup`). |
| `cd spec/quint && bash check.sh` | The Quint spec. |
| `bun testnet-e2e/run.ts --out <file>` | The scripted end-to-end run on the fork. |

CI split (register row `R-GATE-CI-SPLIT`, Arthur's decision). A pull request into `development` runs two fast checks, `One gate (tsc, rules, frozen, style)` and `One gate (bun test)`, plus `Lane label`. The seeds, Quint, Arrival and the fork run on every push to `development` and `main` and on promotion. Do not move seeds onto pull requests or add local whole-suite rules. Locally, while iterating, run tsc, the rules gate, style and the tests of the area you touch; the push run is the judge of the rest. Red `development` is fixed forward and nothing else merges meanwhile. A job that died before any test ran may be re-run once.

The aggregate `One gate` is the check `main` requires. The rulesets are Arthur's to edit; do not route around a denied push or a missing setting.

## Style

Pure functional TypeScript with ADTs and FSMs. Follow `style/arthur-elegant-code-guide.md` in the project's shared files: name the domain model first, then write functions in its terms. The bar is the relief test: code readable without tracing.

- No loops, `let`, mutation, `throw`, classes or `try` outside the exceptions registered in `pure/style/README.md`. A new exception is listed there with the reason no pure expression does the same work at the same cost.
- Use `Result` with tagged errors, not `throw` and not string errors. Make invalid states unrepresentable; parse into the type instead of asserting it (`as unknown as` is counted).
- Use `switch`/`case` and the in-house ts-pattern-style `match`, with no library import.
- One sentence per function, named for what it does; one `const` per statement; named flow steps. No dense one-liners, no comma sequences, no nested ternaries, no positional boolean or bare `true`/`false`/`undefined` arguments (pass a record or a named constant).
- Lines of at most 120 characters, declarations of at most 50 lines. The new tree starts at a zero baseline on every rule; a hit is allowed only by a row in `pure/style/tree-exceptions.json` with its reason in the README.
- Comments say why. State a rule in our words and cite the register id or spec property; do not point at og source lines.
- Restyles are done by the owning thread, not by parallel line-polishing agents. Show a small before and after before a large restyle.
- og belongs under `rig/og/` only; an identifier that names og's model fails the `og-named` rule.

## Tools

Composition is the default. A lookup whose result is the input of the next lookup or of an edit is one Arrival program: ast-grep, the spec checker, rewrite, ast-edit, and jev/gate, composed in `repl-input-scheme-program`. Load `.grok/skills/arrival/SKILL.md` before that program. Ripgrep and a hand edit are the fallback when the composition cannot express the step. Do not restart the live Arrival process to bind a search.

- `.mcp.json` exposes one server, `arrival`: a Scheme REPL. The upstreams in `spec/manifold.mcp.json` are functions in that program, called as `server/tool` with keyword arguments. `rewrite/preview` returns the patched text and writes nothing; `rewrite/apply` writes that text and refuses a path outside the repo. `ast-edit/preview` returns a slot edit on a named declaration and writes nothing; `ast-edit/apply` writes that text. A body is not a slot. `jev/gate` reads the operations and a preview and returns allow, doubt, or refuse. It does not write. Only allow applies.
- Structural search is ast-grep, inside that program when the matches are an input of the next step: `ast-grep/find_code`, `ast-grep/find_code_by_rule`, `ast-grep/dump_syntax_tree`, and `ast-grep/test_match_code_rule`. A pattern that is only read may run as `ast-grep --lang <language> -p '<pattern>'`. Never `sg`, which is the Linux group tool. Relational rules (`inside`, `has`) need `stopBy: end`. Skills: `.claude/skills/ast-grep`, `.claude/skills/ast-grep-outline`.
- Before a `pure/` change, name the binding with the language server. A type, a parameter, or a named import is one program: preview the slot, then `jev/gate`, and apply only on allow. A function body is written by hand after that program has named the declaration.
- The spec checker is `spec/mcp/server.mjs`, called from the REPL as `spec/arrival_run`, `spec/arrival_check`, and `spec/arrival_guide`.
- A Scheme name across `spec/` is `node spec/map/name.mjs <name>`. A `configs/` or `bugs/` file is its own run, loaded after the page, and its top-level `define` replaces the page binding for that run. A comment is not a hit. A Solidity name is an ast-grep identifier query, and that hit is not a binding. A TypeScript binding in `pure/` is the language server. `lsp/references` asks the same question inside a program, writes nothing, and is not an argument to `ast-edit/apply`. Goldfish does not see Scheme or Solidity; do not invent a rank to stand in for it. The outline skill maps a file already open. The document graph stays off.
- Project sessions have no `gh` CLI: use the GitHub MCP tools. The backlog is GitHub issues on `adimov-eth/og_xln`.
- Use Bun. Frontend work is the exception only where a tool needs something else.

## Process

- Pull requests target `development` and open as drafts; small, one slice each. Work on your own `claude/` branch. Never push to `main` or `development` directly. Merge commits only; never force-push or rewrite history on a shared branch.
- Every pull request into `development` carries exactly one lane label: `core` (Account, Entity, Runtime), `chain` (J, Host, contracts, e2e), `spec`, or `process` (CI, infra, process files; exempt from the one-open-pull-request rule). The first pull request opened holds its lane. Details: `docs/process-lanes.md`.
- Every pull request names the e2e step it moves (`testnet-e2e`), or says none for CI and process work.
- One integration owner writes overlapping changes. A separate reviewer looks at each money-code pull request on an exact commit; a later push to money code (`pure/` Account, Entity, Runtime, J, Host) voids that clear. Non-money code merges on green fast checks. A clean merge of `development` into the branch keeps a clear.
- Merges and closes wait for Arthur's word, except that merging into `development` is delegated to the merge thread (2026-10-01): it merges whatever has its required checks passing, in the order the coordinator sets. The merge thread may push to another branch only to merge `development` into it, with merge commits, and tells the author and reviewers the new head.
- The convergence plan runs in four slices, each gated green and separately released by Arthur in words: (1) chain observation and recovery, (2) admission and timing safety, preceded by a dispute lifecycle document, (3) finalization and payment reconciliation, (4) complete real scenarios. Do not start, merge or build a slice that has not been released. Progress and the open gates are in issue #178.
- Promotion to `main` is a `promote/<sha>` snapshot pull request, never a push; see `docs/process-lanes.md`.
- A protocol rule is decided and written down before its code opens, then modelled, then coded. Do not patch a dispute or HTLC timing rule one audit round at a time.
- Do not edit another thread's branch. Preserve unfinished local work before closing anything.
- When a step does not need Arthur's input, keep going. Stop and ask only when you cannot continue without him, or before anything destructive (deleting data, force-pushing, changing anything outside this repository, live chain actions, secrets).

## Communication

- Lead with the result and recommend one path. Ask only when there is a real fork, and do not end with a permission question. No jargon.
- Cite the source of a claim (a path with line, a command and its output, a run URL). Never invent numbers. Correct your own wrong claims openly.
- A handoff (a status reply, a note to another thread, memory left for a successor) contains only: the current SHA, the last green command, the first red command and its error, the artifact path, the next single command, and the remaining final gates. Substantive design goes in docs.
- Put design in files under `plan/`, `spec/` or `docs/`, never in a handoff.

## og (`core/`, `jurisdictions/`)

og is `core/` and `jurisdictions/` at `566c850`. It is frozen reference: never edit it, not even to debug; monkeypatch from the test instead. `bun rules/checks/frozen.ts` fails on any difference. Do not move anything into `core/`.

The former rulebook of this file was og's own (TPS stands, the Rust parity path, frozen-core approval, push-to-`main`, the machine lock) and applies only to work in `core/`, which is closed. For `pure/` those rules do not apply; the project instructions above win. It stays readable in history (`git show 21f163b:AGENTS.md`), and og's invariants and lessons stay readable in `docs/` (`consensus-invariants.md`, `fints.md`, `reject-policy.md`, `wal.md`). Use them as sources of lessons. A rule enters `pure/` only through a decision in the register.

## Rule Development Process

1. Break down the user's query into smaller parts.
2. Identify sub rules that can be used to match the code.
3. Combine the sub rules into a single rule using relational rules or composite rules.
4. if rule does not match example code, revise the rule by removing some sub rules and debugging unmatching parts.
5. From the REPL, `ast-grep/dump_syntax_tree` to see the pattern or the code.
6. `ast-grep/test_match_code_rule` against the example. A fix belongs in the rule; `rewrite/preview` shows the patched text before `rewrite/apply`.

This iterative process allows the AI to "think" more like a human developer, refining its approach
until the rule is correct. Detailed prompt for this agentic rule development process:
https://github.com/ast-grep/ast-grep-mcp/blob/main/ast-grep.mdc
