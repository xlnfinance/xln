# Round ledger — language-guide custdev

Living notes. Metrics are panel-level (4 models × tasks) unless noted.
**Card under test:** `docs/llm-agent-card.md` (single source; no dual copy).

## Seed card (v0)

- 56 lines / 1584 B — preferred surface + short "do not use"
- No `null?` / `take` order / `frequencies` / sort-field pattern

## Round 1 — full panel (v0 card)

| Model     |     exec |   oracle |       odd | under |
| --------- | -------: | -------: | --------: | ----: |
| longcat   |     8/10 |     7/10 |         0 |     0 |
| grok-4.5  |     9/10 |     8/10 |         0 |     0 |
| fable     |     7/10 |     6/10 |         1 |     0 |
| sonnet    |     8/10 |     7/10 |         0 |     0 |
| **panel** | **0.80** | **0.70** | **0.025** | **0** |

`invite_hit` = 1.0 on all models (preferred features used when oracle passed).

**Cross-model failure families (guide bugs):**

1. `pipeline-topn` — models emit `(sort xs lambda)` and/or `(take n xs)` Clojure order
2. `group-count` — `(or (@ acc k) 0)` / `(if n …)` treats `nil` as truthy → `+` on nil
3. `safe-default` — `(if (:timeout cfg) … 30)` same truthiness trap; one model used `nil?`

## Patch → v1 card

Added: `null?` for absence; `(take xs n)` order; `(sort nums >)` + project-then-sort;
`frequencies` for counts; explicit `nil?` ban; ✗ examples for the three families.
~67 lines / ~2.2 KB.

## Round 2 — failed-task retest (v1)

| Task family   | Outcome                                               |
| ------------- | ----------------------------------------------------- |
| group-count   | 3/4 models ORACLE_OK; sonnet still reduce-manual      |
| safe-default  | 4/4 ORACLE_OK                                         |
| pipeline-topn | grok+fable OK; longcat+sonnet still lambda-sort       |
| zip-enrich    | all OK (fable named-let `loop` false-positive oddity) |

## Patch → v2 card (current)

Stronger ✗ block for lambda-sort / Clojure take / reduce-for-count.
Dropped `loop` from oddity scanner (named let is legal). Comments stripped before oddity scan.

## Round 3 — hard-task only (v2)

`pipeline-topn` + `group-count` × all 4 models: **16/16 ORACLE_OK**, odd=0, under=0.

## Confirmation — full panel (v2 + let\* line)

| Model     |      exec |    oracle |   odd | under |
| --------- | --------: | --------: | ----: | ----: |
| longcat   |      9/10 |      9/10 |     0 |     0 |
| grok-4.5  |     10/10 |     10/10 |     0 |     0 |
| fable     |     10/10 |     10/10 |     0 |     0 |
| sonnet    |     10/10 |     10/10 |     0 |     0 |
| **panel** | **0.975** | **0.975** | **0** | **0** |

`invite_hit` = **1.0**. Acceptance **PASS**.

Sole residual: longcat `zip-enrich` used parallel `let` where `stat` init referenced `user-id` → unbound. Patch: one `let*` sequential-binding line (v2.1). Not re-run as a full panel (single-model, non-family); optional.

### Delta vs Round 1

| Metric      |                R1 |            Confirm |
| ----------- | ----------------: | -----------------: |
| oracle_pass |              0.70 |          **0.975** |
| oddity_rate |             0.025 |              **0** |
| invite_hit  |               1.0 |                1.0 |
| guide size  | 56 lines / 1.6 KB | ~70 lines / 2.4 KB |

## Minimal redundancy cut (audit ranks 1–3 + inventory hygiene)

**Card cuts:** header drop `call/cc`/multi-value (ban list keeps them); drop Sugarcoat
parenthetical; drop ban-list `Clojure (take n xs)` (pipeline line still teaches take).
**Inventory:** drop Preferred prose re-teach; fix `->` out of “not card-core”.

| Model     |      exec |   oracle |   odd | under |
| --------- | --------: | -------: | ----: | ----: |
| longcat   |      9/10 |     9/10 |     0 |     0 |
| grok-4.5  |     10/10 |    10/10 |     0 |     0 |
| fable     |     10/10 |    10/10 |     0 |     0 |
| sonnet    |     10/10 |     9/10 |     0 |     0 |
| **panel** | **0.975** | **0.95** | **0** | **0** |

`invite_hit` = **1.0**. Acceptance **PASS**. Residual: longcat `pipeline-topn` (sort/lambda
or take shape — not Sugarcoat); sonnet `group-count` oracle drift. No cross-model family.
Vs pre-cut confirm (0.975 oracle): −0.025, still well above 0.70 threshold.

## Path B micro-safe size pass (committed)

Card: drop dialect footer; strip map-line comments; drop `-> first-arg` note.
Keep load-bearing blocks (nil/null?, take/sort/freq examples, ban list, reduce line).

| Model     |    exec |  oracle |   odd | under |
| --------- | ------: | ------: | ----: | ----: |
| longcat   |   10/10 |   10/10 |     0 |     0 |
| grok-4.5  |   10/10 |   10/10 |     0 |     0 |
| fable     |   10/10 |   10/10 |     0 |     0 |
| sonnet    |   10/10 |   10/10 |     0 |     0 |
| **panel** | **1.0** | **1.0** | **0** | **0** |

`invite_hit` = **1.0**. Acceptance **PASS**. Full clean — path B safe.

## Full-cut experiment + `str` hoist

Aggressive slim (drop Values, fat ban, `@`/`get-in`, `->>` invite, bare filter/map/reduce).
Recovered **`(str …)` / `(join …)`** on the card after sonnet `string-report` invented `fold-left`.
Runtime: `str` hoisted to `scheme/polyglot` (native, next to `join`).

### Full-cut only (no str line) — longcat/grok/sonnet

| Model    |                                                    oracle |
| -------- | --------------------------------------------------------: |
| longcat  |                                                     10/10 |
| grok-4.5 |                                                     10/10 |
| sonnet   | 8/10 (pipeline-topn lambda-sort; string-report fold-left) |
| panel    |                                                      0.93 |

### After str line + hoist — longcat/grok/sonnet

| Model     |   oracle | notes                                              |
| --------- | -------: | -------------------------------------------------- |
| longcat   |    10/10 |                                                    |
| grok-4.5  |    10/10 |                                                    |
| sonnet    |     9/10 | group-count still invents fold-left vs frequencies |
| **panel** | **0.97** | string-report recovered; oddity 0                  |

Card ≈ 46 lines. Residual: frequencies underuse (sonnet only).

## Compression loop (hypothesis → cut → test)

### Loop 1 — ~28% crop (46 → 33 lines)

Cut: section headers, fat Control section, most ban wall, reduce-for-counts bad line,
Clojure-long glosses. Kept: `(:k d)`, nil/`null?`, take/sort/frequencies/str/join,
good/bad sort+take, assoc-in, set!/mutators.

| Model              |                          oracle |
| ------------------ | ------------------------------: |
| longcat / grok-4.5 |                           10/10 |
| sonnet             | 9/10 (group-count alist invent) |
| **panel**          |                        **0.97** |

### Loop 2 — further crop (33 → 22 lines) — **regressed**

Also dropped standalone `(:status row)`, inlined defaults, dropped `nil?` ban line.
Panel oracle **0.90**. Failures:

- longcat safe-default: `(cfg :timeout)` (dict as operator) — **recover `(:k d)` demo**
- sonnet group-count / reduce-sum: `fold-left` invent

**Ship Loop 1 card.** Loop 2 teaches: keyword accessor form is load-bearing; further cuts should not remove the only `(:k d)` example.
