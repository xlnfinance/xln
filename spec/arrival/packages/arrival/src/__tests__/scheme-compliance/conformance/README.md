# Conformance suite — chibi corpus harness

One vitest row per Scheme test form from the chibi-scheme corpora
(`vendor/chibi-scheme/tests/r7rs-tests.scm`, ~1087 forms; SRFI-1 corpus beside it). The
submodule gitlink is the full chibi tree (alignment); `pnpm install` sparse-checkouts the
working tree to those two files. This is the value layer's coherence law against the spec
(F4, `docs/test-suite-architecture.md`).

## Dual pass (strict / golden-loose)

Arrival's default product mode is **loose** (zimmerframe: nil-tolerant `car`/`cdr`, list-like
ops on vectors, etc.). R7RS/chibi goldens need **strict**. Dual pass replaces "permanent
`it.fails` under the wrong mode":

| Pass           | How                                                       | Golden                             |
| -------------- | --------------------------------------------------------- | ---------------------------------- |
| **A — strict** | `CorpusRunner.create(manifest, { strict: true })`         | Chibi / R7RS expected outcomes     |
| **B — loose**  | Explicit pins (e.g. `golden-loose-car-cdr-empty.test.ts`) | **Current** Arrival loose behavior |

v1 mode-split: `(car '())` / `(cdr '())` only.

- Pass A: SRFI-1 corpus runs strict — chibi `(test-error (car '()))` / `(cdr '())` are green.
- Pass B: golden-loose asserts loose → nil via scheme `equal?`.
- Inventory seed: `chibi/registries-srfi1.ts` → `MODE_SPLIT_INVENTORY`.

**Growing the fail-if registry:** append inventory row → ensure Pass A rides chibi under
strict → add Pass B golden-loose pin. Do not re-add permanent EXPECTED_FAILURE only because
the harness defaulted loose. Class B protocol forks (`unfold`, …) are out of scope for dual
run.

**Load-bearing harness detail:** `js-run-test` must use `testCallCtx({ runCtx: this.runCtx })`
(plain `function`, not arrow) so deferred test/test-error thunks see Pass A's strict bit.
Bare `testCallCtx()` is `CONSTANT_CTX` (`strict: false`) and collapses dual pass.

Main R7RS corpus (`chibi-r7rs-v2.spec.ts`) still uses the runner default (`strict: false`)
until a form needs Pass A; pass `{ strict: true }` the same way when promoting a corpus.

## Architecture

Collection time (top-level `await`): `chibi/manifest.ts` splits the corpus into ordered
_steps_ — `setup`, `test`, `block`, `unreadable` (reader door), `section` — parses each form,
and assigns a verdict from `chibi/registries.ts`: `it` / `it.fails` (known gap, flips loudly
when fixed) / `it.skip` / `it.todo`.

Test time: `chibi/runner.ts` (CorpusRunner) drives one shared env per spec file with a
monotone cursor — `outcomeFor(step)` executes pending setups, then the form itself, through a
one-slot harness sink (`chibi/harness-capability.ts`). Comparison is scheme `equal?`, never a
JS-side duck-tolerance (P4). `CorpusRunnerOptions.strict` stamps every step's
`execOverFrame` for that pass.

## Env-state strategy — sequential `it`s, one shared env

The corpus is genuinely stateful (`force`/`delay` counters), so execution order must match
registration order — a plain ordered loop, not `it.each` partitioning. Rejected alternatives:
fork-per-test gives false isolation (closures capture creation frames by reference) at real
cost; prefix-replay is O(n²) and re-runs side effects; dependency analysis is unsound through
macro expansion. A setup failure stamps every downstream row with the poisoning step, so
poisoning is loud and attributed.

## Block steps

A top-level `(let () (define …) (test …) …)` is one _evaluation_ with k _outcome slots_: the
first member's `it` triggers the block, each member consumes its slot, and members after a
mid-block abort get an explicit `block-aborted` outcome. The unit of evaluation is the
top-level form; the unit of verdict is the test form.

## Budgets and ordering guard

Every step runs under `budgetMs` — a wedge becomes a red row with a budget error, not a hung
run. The cursor throws on any out-of-order request ("corpus steps executed out of order —
check vitest sequence config"), so ordering is guarded, not assumed.

## Editing registries

A red row is either a real interpreter bug (fix the interpreter) or a registry row (known gap
with a cited reason). Registry rows are the anti-vacuity floor: a form that starts passing
while registered `it.fails` fails the suite — expected-failures flip loudly, never pass
silently.
