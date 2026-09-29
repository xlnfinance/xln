# Language-guide custdev — arrival-scheme

Customer development where the customer is an LLM writing **Scheme programs**, and
the product under test is the **language guide** (not a tool API).

Adapted from `inhuman/docs/inhuman-custdev.md`. Same loop, different surface:

| Inhuman custdev                 | This experiment                         |
| ------------------------------- | --------------------------------------- |
| Tool/API naming                 | Guide content + size                    |
| Phantom = failed tool call      | Phantom = failed/odd/underusing program |
| Fix the API                     | Fix (or shrink) the guide               |
| Cross-model = naming robustness | Cross-model = guide load-bearing lines  |

## Goal

Find the **minimal** `docs/llm-agent-card.md` such that, for typical agent Scheme tasks:

1. **Feature use is default** — programs reach for dict / keyword access / threading /
   `str` when the task invites them (not pure-R7RS alist gymnastics).
2. **Oddities are rare** — no hallucinated IO/mutation/continuations; dialect mess stays
   inside the _tolerated_ set (popular aliases/recoveries).
3. **Size stays small** — every line must earn its keep across ≥2 model lineages.

Tolerance is deliberate: the runtime accepts polyglot spellings so the guide does **not**
need to police every alias. It only needs to (a) name preferred forms once and (b) wall off
the real dead ends.

## Non-goals

- Teaching Sugarcoat (human view). Agents write prefix s-expressions.
- Full R7RS inventory. Gaps are doors at runtime; the guide names only what agents need.
- Per-model custom guides (v1 is one shared card).

---

## Process

### Phase A — Surface under test

`docs/llm-agent-card.md` is the only language doc the model sees (harness default;
override with `GUIDELINES=`). `docs/llm-language-guide.md` is the human inventory —
preferred vs _runtime_ loose recovery; the card does not teach loose spellings.

### Phase B — Task suite

Natural-language tasks over fixed Scheme fixtures (no tools, no IO). Each task declares:

- `fixture` — Scheme forms that bind data (evaluated before the solution)
- `prompt` — what to implement (one top-level expression or a small `define` + use)
- `invite` — preferred features the task is designed to pull
- `oracle` — expected JS value of the last form (via `exec` + membrane)

See `tasks.json`.

### Phase C — Multi-model harvest

Same guidelines + same tasks, four models (intelligence × lineage):

| Runner                     | Model    | Role             |
| -------------------------- | -------- | ---------------- |
| `grok -p -m longcat`       | longcat  | weak / cheap     |
| `grok -p -m grok-4.5`      | grok-4.5 | strong Grok      |
| `claude -p --model fable`  | fable    | weak Anthropic   |
| `claude -p --model sonnet` | sonnet   | strong Anthropic |

Each run: model receives **only** the agent card + one task (fixture shown as data
bindings + NL prompt). Returns a single Scheme program (fenced). Harness executes it
prepended to the fixture.

### Phase D — Score (two axes + pass)

| Axis              | Signal                                           | Good when                 |
| ----------------- | ------------------------------------------------ | ------------------------- |
| **Pass**          | `exec` succeeds and deep-equals oracle           | high                      |
| **Underuse (U)**  | pass (or near-pass) without any `invite` feature | low                       |
| **Oddity (O)**    | banned / hallucinated form in source             | ~0                        |
| **Tolerated (T)** | compat alias/recovery only                       | free — not scored against |

Classifiers live in `score.mts` (regex + keyword scans; good enough for guide feedback).

**Cross-model rule (from inhuman custdev):** a failure family seen on ≥2 lineages is a
**guide bug**. A failure on one weak model only is optional polish.

### Phase E — Patch the guide

From the round report, add or reword **only** lines that:

1. Fix a cross-model oddity (name the door + alternative), or
2. Fix cross-model underuse of an invited feature (one short preferred example),

and delete lines that no model needed (zero underuse when the line is ablated — later
rounds).

### Phase F — Stop

Acceptance criteria (below) met for two consecutive rounds, or size budget exhausted
with residual failures logged as known gaps.

---

## Acceptance criteria

Measured on one full panel (4 models × N tasks). Round report is the source of truth.

| Metric                            | Threshold                                               | Notes                       |
| --------------------------------- | ------------------------------------------------------- | --------------------------- |
| **Guide size**                    | ≤ 90 lines and ≤ 3.5 KB                                 | hard budget                 |
| **Exec pass rate**                | ≥ 0.80 overall; ≥ 0.70 on weak models                   | weak = longcat, fable       |
| **Oracle pass rate**              | ≥ 0.70 overall                                          | value match after `exec`    |
| **Oddity rate**                   | ≤ 0.10 of programs have any O-class hit                 | O = banned list             |
| **Invite hit rate**               | ≥ 0.60 of _passing_ programs use ≥1 invited feature     | underuse inverse            |
| **Cross-model oddity families**   | 0 open families                                         | same O-pattern on ≥2 models |
| **Cross-model underuse families** | 0 for core invites (`dict`, `keyword-access`, `thread`) | optional invites may lag    |

**Primary product claim:** under the accepted card, "not using language features" and
"producing oddities" are both non-default — measured, not hoped.

### Failure taxonomy (scoring)

**O — Oddity (penalize)**

```
set!  set-car!  set-cdr!  vector-set!  string-set!
call/cc  call-with-current-continuation  dynamic-wind
values  call-with-values  let-values  define-values
println  print  display  write  newline  load  eval
open-input-file  with-output-to-file  read-line
make-hash  hash-ref  hash-set!  gethash
defun  setf  loop  nreverse  for/list  for/fold
delay  force  parameterize  case-lambda
define-library  import  include
; free list commas: (list 1, 2)   ; curly-infix: {a + b}
; sugarcoat agent output: .map{  .filter{  xs[0]
```

**T — Tolerated (no penalty)**

```
mapcar  remove-if  remove-if-not  nth  rest  empty?
comp  flow  ~>  ~>>  assoc-ref
true  false  nil
{name: v}  #:name  bracket let/cond  commas inside {…}/[…]
```

**P — Preferred (invite credit)**

```
dict  {:…}  (:k …)  (@ …)  @?  @keys
->  ->>  get-in  assoc-in  update-in
str  join  zipmap  frequencies  group-by  partial  juxt
filter  map  reduce  cut
```

**U — Underuse**

Program passes oracle (or fails only on a minor equality drift) but uses **zero** of the
task's `invite` set. Example: filter/project task solved with alists and `assoc` only.

---

## Round report shape

`__custdev-output__/round-<iso>.json`:

```json
{
  "guidelines_sha": "…",
  "guidelines_bytes": 0,
  "guidelines_lines": 0,
  "models": ["longcat", "grok-4.5", "fable", "sonnet"],
  "tasks": ["filter-project", "…"],
  "cells": [
    {
      "model": "longcat",
      "task": "filter-project",
      "program": "(…)",
      "exec_ok": true,
      "oracle_ok": true,
      "value": …,
      "error": null,
      "preferred": ["dict", "keyword-access"],
      "tolerated": [],
      "oddities": [],
      "underuse": false
    }
  ],
  "summary": {
    "exec_pass": 0.0,
    "oracle_pass": 0.0,
    "oddity_rate": 0.0,
    "invite_hit": 0.0,
    "cross_model_oddity_families": [],
    "cross_model_underuse_families": []
  }
}
```

---

## How to run

```bash
# from packages/arrival
node --experimental-strip-types src/__custdev__/language-guide/run-round.mts
# optional:
GUIDELINES=./docs/llm-agent-card.md \
MODELS=longcat,fable \
TASKS=filter-project,nested-path \
node --experimental-strip-types src/__custdev__/language-guide/run-round.mts
```

Opt-in only (real model calls). Not a CI gate.

---

## Iteration discipline

1. Round 0 baseline may use an empty/minimal card to measure cold priors.
2. Each patch: one concern (e.g. "keyword access underuse") — not a bulk dump from the full inventory.
3. Prefer **one worked micro-example** over a table of aliases.
4. Never document a tolerated alias unless underuse of the _preferred_ twin is still high after the preferred is taught.
5. If a line does not move a metric in the next round, cut it.
