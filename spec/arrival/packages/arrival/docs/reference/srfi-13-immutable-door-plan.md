# SRFI-13 — Immutable subset + implement-or-door plan

**Status:** **PR1–3 landed** (`126d370ddd`) — official left trim + `string-trim-both`, purity/subset doors in pack, `string-filter` moved out of stubs. Residual roadmap: optional P1+ live promotes (`string-filter`/`string-delete`/skip/index-right, …).  
**Policy:** Arrival strings are **immutable**. Every official SRFI-13 export is either **live** or a **door**. Silent absence is a bug. We do **not** implement the whole of SRFI-13; we implement a pure subset and door the rest with teaching reasons.  
**Sources of truth:**

- Official index: [SRFI 13](https://srfi.schemers.org/srfi-13/srfi-13.html) (Procedure Index)
- Pack: `src/env/srfi/srfi-13.ts` (`scheme/srfi-13`)
- Related doors: `src/env/r7rs/strings.ts` (R7RS mutators); char-sets stay `srfi-stubs` (SRFI-14)
- Inventory score: [`srfi-coverage.md`](srfi-coverage.md) § SRFI-13

---

## Policy (immutable + implement-or-door)

| Rule                  | Meaning for SRFI-13                                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Immutable**         | Mutating ops (`…!`, `string-copy!` into a target, `string-xcopy!`, …) are **never** live. They are **purity doors** that name the frozen-value / provenance reason and point at a pure constructor.                                      |
| **Implement-or-door** | Every name in the official Procedure Index is either bound live (this pack, R7RS strings, or an intentional extension) **or** bound as `symbol.notImplemented` with a teaching reason. “Not in our subset” is still a door, not silence. |
| **Subset honesty**    | Live ops may narrow scope (no char-sets; no optional `start`/`end`; no `grammar` on join) **only if** the docstring says so. Narrowing is not an excuse for missing sibling names.                                                       |
| **Pack ownership**    | SRFI-13-named gaps belong in `scheme/srfi-13` (or co-located R7RS string mutators in `scheme/strings`). `srfi-stubs` holds **cross-family** omissions (SRFI-14 char-sets, etc.), not a random half of this SRFI.                         |

### Scope narrowing already documented on live code

From `srfi-13.ts` header (keep; make doors match the same story):

1. Criteria are **char or one-arg predicate** — not SRFI-14 char-sets (char-set _API_ doored in `srfi-stubs`).
2. **No optional start/end** — use `substring` / `string-copy` first.
3. **`string-split`** is SRFI-**152**, bound here as the #1 agent miss (extension, not official SRFI-13).

---

## 1. Live symbols

### 1a. In pack `scheme/srfi-13` (`srfi-13.ts`)

| Symbol              | Kind | Official SRFI-13?          | Notes                                                        |
| ------------------- | ---- | -------------------------- | ------------------------------------------------------------ |
| `string-null?`      | live | yes                        |                                                              |
| `string-prefix?`    | live | yes                        | Affix-first order correct; no `-ci`, no start/end            |
| `string-suffix?`    | live | yes                        | same                                                         |
| `string-index`      | live | yes                        | char / 1-arg pred only                                       |
| `string-count`      | live | yes                        | same                                                         |
| `string-take`       | live | yes                        |                                                              |
| `string-drop`       | live | yes                        |                                                              |
| `string-take-right` | live | yes                        |                                                              |
| `string-drop-right` | live | yes                        |                                                              |
| `string-trim`       | live | **name yes, semantics NO** | Pack trims **both** ends; official is **left-only** → see §3 |
| `string-trim-left`  | live | **no** (extra)             | ≈ official `string-trim`                                     |
| `string-trim-right` | live | yes                        | Matches official                                             |
| `string-pad`        | live | yes                        | default space; no start/end                                  |
| `string-pad-right`  | live | yes                        | same                                                         |
| `string-reverse`    | live | yes                        | pure only; `string-reverse!` missing/silent                  |
| `string-join`       | live | yes                        | default delimiter space; **no** `grammar` arg                |
| `string-tokenize`   | live | yes                        | default non-whitespace token runs                            |
| `string-split`      | live | **no** (SRFI-152)          | Intentional extension; char delimiter accepted               |

**Count:** 17 live + 1 SRFI-152 extension = 18 pack bindings.

### 1b. Live overlap in `scheme/strings` (`r7rs/strings.ts`) — R5RS/R7RS ∩ SRFI-13

These satisfy official SRFI-13 names that re-export R5RS (or R7RS extensions). They live with the string type, not the SRFI pack.

| Symbol                              | Notes                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `string?`                           | R5RS (type predicate; elsewhere if not this file)                                          |
| `make-string`                       | R5RS                                                                                       |
| `string`                            | R5RS                                                                                       |
| `string-length`                     | R5RS                                                                                       |
| `string-ref`                        | R5RS                                                                                       |
| `string-append`                     | R5RS                                                                                       |
| `string->list`                      | R5RS+ optional start/end (R7RS form)                                                       |
| `list->string`                      | R5RS                                                                                       |
| `string-copy`                       | R5RS+ optional start/end                                                                   |
| `string-map`                        | R7RS multi-string; SRFI-13 is single-string + start/end — **close enough; document delta** |
| `string-for-each`                   | same multi-string R7RS shape                                                               |
| `string-upcase` / `string-downcase` | R7RS (also SRFI-13 pure case maps)                                                         |
| `string-foldcase`                   | R7RS only (not SRFI-13) — fine as extra                                                    |
| `string-contains`                   | **SRFI-13** verb bound in R7RS pack (historical grain completion)                          |
| `string-contains?`                  | Arrival-only boolean twin                                                                  |

**R7RS purity doors already co-located with the string type:**

| Symbol         | Where          | Reason class |
| -------------- | -------------- | ------------ |
| `string-set!`  | `r7rs/strings` | door-purity  |
| `string-fill!` | `r7rs/strings` | door-purity  |
| `string-copy!` | `r7rs/strings` | door-purity  |

### 1c. Doored today (related, asymmetric)

| Symbol                       | Where             | Issue                                                                                                     |
| ---------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| `string-filter`              | `srfi-stubs` only | Compositional redirect is good; **asymmetric** — sole SRFI-13 procedure-gap door, parked outside the pack |
| Char-set _constructors/vars_ | `srfi-stubs`      | Correct family (SRFI-14); criteria on string ops stay “char or pred”                                      |

---

## 2. Missing official exports — buckets

Official main + low-level index is ~100 names (incl. R5RS overlaps). After subtracting lives above and R7RS mutator doors, remaining names bucket as:

### 2a. `door-purity` — mutating / in-place (never implement)

Teach: _frozen values + provenance; construct a new string instead._

| Symbol              | Suggested home         | Redirect sketch                                           |
| ------------------- | ---------------------- | --------------------------------------------------------- |
| `string-set!`       | already `r7rs/strings` | `string-append` / `substring` / fresh `string`            |
| `string-fill!`      | already `r7rs/strings` | `make-string` with fill                                   |
| `string-copy!`      | already `r7rs/strings` | `string-copy`                                             |
| `string-reverse!`   | **`scheme/srfi-13`**   | `string-reverse`                                          |
| `string-titlecase!` | pack                   | `string-titlecase` (when live) or pure case map           |
| `string-upcase!`    | pack                   | `string-upcase`                                           |
| `string-downcase!`  | pack                   | `string-downcase`                                         |
| `string-map!`       | pack                   | `string-map`                                              |
| `string-xcopy!`     | pack                   | `xsubstring` (when live) or `substring` + `string-append` |

**PR invariant:** every `!` mutator name is a door; no silent `!`.

### 2b. `door-not-in-subset` — deliberate non-implementation

These are real official exports. Silence is wrong; doors should state _why_ the subset excludes them.

| Family                                                 | Symbols                                                                                                                        | Door reason (sketch)                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shared storage**                                     | `substring/shared`, `string-concatenate/shared`, `string-append/shared`, `string-concatenate-reverse/shared`                   | No shared-text substrings; use pure `string-copy` / `string-append` / `string-concatenate` (or implement pure twins without `/shared`)              |
| **Low-level start/end parse**                          | `string-parse-start+end`, `string-parse-final-start+end`, `let-string-start+end`, `check-substring-spec`, `substring-spec-ok?` | Host library internals for optional start/end; arrival omits start/end on SRFI-13 ops — slice first with `substring`                                |
| **KMP internals**                                      | `make-kmp-restart-vector`, `kmp-step`, `string-kmp-partial-search`                                                             | Low-level search machinery; use `string-contains` / `string-index`                                                                                  |
| **SRFI comparison names without `?`** (if not aliased) | `string=`, `string<>`, `string<`, `string>`, `string<=`, `string>=`, `string-ci=`, `string-ci<>`, …                            | Different binding names from R7RS `string=?` / `string-ci=?` family already live — door → use R7RS names (or thin aliases if we want zero friction) |
| **Multi-return compare core**                          | `string-compare`, `string-compare-ci`                                                                                          | Multi-value / continuation style; may conflict with multi-return doors elsewhere — door to `string=?` / `string<?` / R7RS ordering                  |
| **Join grammar**                                       | (not a separate export)                                                                                                        | Live `string-join` lacks `grammar`; optional: door is N/A; document as subset delta on live op (already partial)                                    |

Char-set **types** remain SRFI-14 doors in stubs; string ops that only _accept_ char-sets as criteria do not get separate export names — criterion narrowing is documented on each live search/trim/count op.

### 2c. `implement-candidates` — pure, agent-useful, honest subset

Priority roughly = agent reach × compositional gap cost. Prefer implement when redirect is multi-step or error-prone; door with compositional recipe when one-liner is clear.

| Priority | Symbol(s)                                                                                               | Why                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**   | Fix trim naming: live `string-trim` = left; add/live `string-trim-both`; keep/alias `string-trim-left`  | **Semantic bug** today (§3); blocks correct SRFI training                                                                                                                  |
| **P0**   | Door bulk of remaining index (purity + not-in-subset + not-yet-implemented)                             | Ends silent-absence regime; unblocks parallel implement work                                                                                                               |
| **P1**   | `string-filter`, `string-delete`                                                                        | Filter already stub-doored; delete is the dual. Prefer **implement** (thin over `string->list`/`filter`/`remove`/`list->string`) _or_ move door into pack with same recipe |
| **P1**   | `string-index-right`, `string-skip`, `string-skip-right`                                                | Same criterion machinery as live `string-index` / `string-count`                                                                                                           |
| **P1**   | `string-every`, `string-any`                                                                            | Predicates agents reach for after SRFI-1 `every`/`any`                                                                                                                     |
| **P2**   | `string-prefix-length`, `string-suffix-length`, `*-ci` / `string-prefix-ci?`, `string-suffix-ci?`       | Natural extensions of live prefix/suffix preds                                                                                                                             |
| **P2**   | `string-contains-ci`                                                                                    | Twin of live `string-contains`                                                                                                                                             |
| **P2**   | `string-concatenate`, `string-concatenate-reverse` (+ optional pure `/shared` as aliases of pure forms) | Avoid `apply string-append` argument limits; reverse-accum idiom                                                                                                           |
| **P2**   | `reverse-list->string`, `string-tabulate`                                                               | Small pure constructors                                                                                                                                                    |
| **P2**   | `string-replace`                                                                                        | Common edit without mutation                                                                                                                                               |
| **P3**   | `string-fold`, `string-fold-right`, `string-unfold`, `string-unfold-right`, `string-for-each-index`     | Fundamental iterators; higher cost, lower casual reach                                                                                                                     |
| **P3**   | `string-titlecase`                                                                                      | Pure case map; Unicode 1-1 titlecase                                                                                                                                       |
| **P3**   | `xsubstring`                                                                                            | Rotate/replicate; door-or-implement                                                                                                                                        |
| **P3**   | `string-hash`, `string-hash-ci`                                                                         | Only if something in env needs string hash keys; else door “use dict / explicit key”                                                                                       |

**Asymmetry to kill:** `string-filter` alone is doored in stubs while `string-delete`, `string-every`, … stay silent. After the bulk-door PR, either implement P1 filter/delete or door **both** in the pack with the same compositional redirect style.

---

## 3. Semantic bugs in live code

### 3.1 Critical: `string-trim` ≠ SRFI-13

| Name                | Official SRFI-13 | Arrival today (`trimImpl(…, side)`)           |
| ------------------- | ---------------- | --------------------------------------------- |
| `string-trim`       | **left** only    | **both** (`"both"`)                           |
| `string-trim-right` | right            | right ✓                                       |
| `string-trim-both`  | both             | **missing** (behavior lives under wrong name) |
| `string-trim-left`  | not in SRFI-13   | live; ≈ official left trim                    |

**Impact:** An agent (or ported SRFI sample) that calls `(string-trim s)` expecting left-only whitespace strip gets both-ends trim. That is a **wrong-answer bug**, not a subset delta.

**Fix (single atomic PR preferred):**

1. `string-trim` → `trimImpl(..., "left")` (official).
2. Bind `string-trim-both` → `trimImpl(..., "both")`.
3. Keep `string-trim-left` as **alias** of official left trim (compat / explicit name; document as non-standard synonym).
4. Update pack header + any tests/docs that assert both-ends on `string-trim`.

### 3.2 Documented partials (not bugs if docstrings stay honest)

| Area                             | Live behavior        | Official                                                     | Action                                   |
| -------------------------------- | -------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Criteria                         | char or 1-arg pred   | char / char-set / pred                                       | Keep; char-sets stay SRFI-14 doors       |
| start/end                        | omitted              | almost everywhere                                            | Keep; document; optional later implement |
| `string-join`                    | delimiter only       | + `grammar` (`infix` / `strict-infix` / `prefix` / `suffix`) | Document; optional P2 implement grammar  |
| `string-map` / `string-for-each` | R7RS multi-string    | SRFI single-string + start/end                               | Document grain completion via R7RS       |
| Comparison names                 | R7RS `string=?` etc. | SRFI `string=` etc.                                          | Door or alias SRFI names (§2b)           |

### 3.3 No known wrong-answer bugs (beyond trim)

- Prefix/suffix argument order: affix first — correct per SRFI-13.
- Pad truncation direction: left-pad truncates from left (keeps tail); right-pad truncates right — matches SRFI-13.
- Take/drop OOR: error — matches SRFI-13.
- `string-split` empty subject → `()` — intentional SRFI-152 refinement (document; not SRFI-13).

---

## 4. Where to put doors

| Class                                                                                   | Home                                   | Rationale                                                                          |
| --------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| **R5RS/R7RS string mutators** (`string-set!`, `string-fill!`, `string-copy!`)           | `scheme/strings` (`r7rs/strings.ts`)   | Own the string type; already done                                                  |
| **SRFI-13-only mutators** (`string-reverse!`, case `!`, `string-map!`, `string-xcopy!`) | **`scheme/srfi-13`**                   | Same pack agents load when they reach for SRFI-13                                  |
| **SRFI-13 pure gaps** (filter/delete until implemented, every/any, skip, …)             | **`scheme/srfi-13`** as door _or_ live | Pack is the inventory for this SRFI                                                |
| **Shared / KMP / start-end parse utilities**                                            | **`scheme/srfi-13`** doors             | Official exports of this SRFI; not “another SRFI”                                  |
| **SRFI-14 char-set API**                                                                | `scheme/srfi-stubs`                    | Cross-family; already correct                                                      |
| **`string-filter` today**                                                               | stubs → **move or mirror into pack**   | Ends pack/stubs asymmetry; stubs can drop the SRFI-13-only entry once pack owns it |

**Rule of thumb:**

- _“This name is on the SRFI-13 procedure index”_ → bind in `scheme/srfi-13` (live or door).
- _“This is another SRFI / ambient / host concern”_ → stubs or `r7rs/host`.
- _“This is the R7RS string type’s mutator”_ → `r7rs/strings`.

Do **not** grow stubs as a junk drawer for incomplete SRFI packs.

---

## 5. Atomic PR order

Each PR is independently reviewable and leaves the tree consistent with implement-or-door for the names it touches.

| #     | PR                                       | Content                                                                                                                                                                                                    | Leaves tree                                  |
| ----- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **0** | This plan                                | `docs/srfi-13-immutable-door-plan.md` only                                                                                                                                                                 | Doc only                                     |
| **1** | **Trim semantics fix**                   | `string-trim` left; add `string-trim-both`; alias `string-trim-left`; tests + docstring                                                                                                                    | Live names match SRFI; no new doors required |
| **2** | **Purity doors in pack**                 | Door `string-reverse!`, `string-titlecase!`, `string-upcase!`, `string-downcase!`, `string-map!`, `string-xcopy!` with same provenance teaching tone as `r7rs/strings` mutators                            | All SRFI-13 `!` names bound                  |
| **3** | **Bulk door remaining official exports** | Door every still-silent index name (not-in-subset + not-yet-implement) in `scheme/srfi-13`; move `string-filter` (+ door `string-delete`) into pack; remove SRFI-13-only entry from stubs if fully covered | **Zero silent SRFI-13 exports**              |
| **4** | **Implement P1 search/pred/filter**      | `string-index-right`, `string-skip`, `string-skip-right`, `string-every`, `string-any`; prefer live `string-filter` / `string-delete` (drop doors when live)                                               | High-reach pure ops                          |
| **5** | **Implement P2 affix/concat/construct**  | prefix/suffix lengths + ci, `string-contains-ci`, concatenate(+reverse), `reverse-list->string`, `string-tabulate`, optional `string-replace` / join grammar                                               | Deeper pure subset                           |
| **6** | **Optional P3**                          | fold/unfold, titlecase, xsubstring, hash                                                                                                                                                                   | Only if demand or test corpus requires       |

### PR sequencing constraints

- **1 before** any trim-related agent fixtures or chibi SRFI-13 trim tests.
- **2 and 3** can merge as one “doors pass” if small; keep **1** separate (behavior change).
- **4+** only after **3** so “implement” means replacing a door, not inventing a new name from silence.
- Do not implement mutators. Ever.
- After each implement PR: update this doc’s live table + `docs/srfi-completeness-audit.md` score for SRFI-13 (target: **COMPLETE under subset** = every official name live or door, trim fixed, purity held).

### Definition of done (SRFI-13 pack)

1. Official procedure index: no silent symbols.
2. All mutators: purity doors (pack or `r7rs/strings`).
3. `string-trim` / `string-trim-both` match SRFI-13.
4. Subset deltas (no char-set criteria, no start/end, join grammar, SRFI-152 `string-split`) documented on live symbols.
5. `string-filter` no longer the only doored pure gap, and not orphaned in stubs.

---

## Appendix A — Official index checklist (for PR 3)

Use as a gate: every row is **live** | **door** | **live-elsewhere** after PR 3.

**Predicates:** `string?` · `string-null?` · `string-every` · `string-any`  
**Constructors:** `make-string` · `string` · `string-tabulate`  
**List/string:** `string->list` · `list->string` · `reverse-list->string` · `string-join`  
**Selection:** `string-length` · `string-ref` · `string-copy` · `substring/shared` · `string-copy!` · `string-take` · `string-take-right` · `string-drop` · `string-drop-right` · `string-pad` · `string-pad-right` · `string-trim` · `string-trim-right` · `string-trim-both`  
**Modification:** `string-set!` · `string-fill!`  
**Comparison:** `string-compare` · `string-compare-ci` · `string<>` · `string=` · `string<` · `string>` · `string<=` · `string>=` · `string-ci<>` · `string-ci=` · `string-ci<` · `string-ci>` · `string-ci<=` · `string-ci>=` · `string-hash` · `string-hash-ci`  
**Prefixes/suffixes:** `string-prefix-length` · `string-suffix-length` · `string-prefix-length-ci` · `string-suffix-length-ci` · `string-prefix?` · `string-suffix?` · `string-prefix-ci?` · `string-suffix-ci?`  
**Searching:** `string-index` · `string-index-right` · `string-skip` · `string-skip-right` · `string-count` · `string-contains` · `string-contains-ci`  
**Case:** `string-titlecase` · `string-upcase` · `string-downcase` · `string-titlecase!` · `string-upcase!` · `string-downcase!`  
**Reverse/append:** `string-reverse` · `string-reverse!` · `string-append` · `string-concatenate` · `string-concatenate/shared` · `string-append/shared` · `string-concatenate-reverse` · `string-concatenate-reverse/shared`  
**Fold/map:** `string-map` · `string-map!` · `string-fold` · `string-fold-right` · `string-unfold` · `string-unfold-right` · `string-for-each` · `string-for-each-index`  
**Replicate:** `xsubstring` · `string-xcopy!`  
**Misc:** `string-replace` · `string-tokenize`  
**Filter:** `string-filter` · `string-delete`  
**Low-level:** `string-parse-start+end` · `string-parse-final-start+end` · `let-string-start+end` · `check-substring-spec` · `substring-spec-ok?` · `make-kmp-restart-vector` · `kmp-step` · `string-kmp-partial-search`

**Non-index extras (allowed):** `string-trim-left` (alias), `string-split` (SRFI-152), `string-contains?` (boolean twin), R7RS `string-foldcase` / multi-arg map.

---

## Appendix B — Quick file map

| Path                                                        | Role                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/env/srfi/srfi-13.ts`                                   | Live pure subset + (target) SRFI-13 doors                               |
| `src/env/srfi/srfi-stubs.ts`                                | Cross-family doors only; drop orphan `string-filter` after pack owns it |
| `src/env/r7rs/strings.ts`                                   | R7RS/R5RS string ops + type-owned mutator doors + `string-contains`     |
| `src/env/srfi/__tests__/srfi-13-contract-precision.test.ts` | Harvest signatures for join/tokenize/split                              |
| `docs/srfi-completeness-audit.md`                           | Older PARTIAL score — refresh after PRs 1–3                             |
