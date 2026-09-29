# SRFI-1 — Immutable subset + implement-or-door plan

**Pack:** [`src/env/srfi/srfi-1.ts`](../../src/env/srfi/srfi-1.ts) (`scheme/srfi-1`)  
**Policy:** Arrival is an **immutable** Scheme subset. Every official SRFI-1 export is either **live** (correct enough for our subset) or a **`symbol.notImplemented` door** with a teaching reason. Silent absence is a bug.  
**Date:** 2026-07-13  
**Status:** **PR1 landed** (`a52dd60f99`) — honest header, purity + subset doors, `any` alias of `some`. This doc remains the inventory / residual roadmap (find → `#f`, SRFI-shaped `unfold`, optional pure promotes).  
**Related:** [`srfi-coverage.md`](srfi-coverage.md) (score COMPLETE under implement-or-door).

**Official index:** [SRFI-1 Procedure Index](https://srfi.schemers.org/srfi-1/srfi-1.html#ProcedureIndex).

---

## 1. Current live symbols

### 1.1 Live in `scheme/srfi-1` (public)

| Symbol              | Kind               | Notes                                                                   |
| ------------------- | ------------------ | ----------------------------------------------------------------------- |
| `filter`            | sequence / tagless | Representation-polymorphic (list **and** vector) — SRFI is list-only    |
| `reduce`            | tagless            | Left fold dispatcher; SRFI name `reduce` (not bare `fold`)              |
| `find`              | native             | **Miss → `nil`**, not SRFI `#f` (semantic bug)                          |
| `take-while`        | tagless            | Polymorphic list/vector                                                 |
| `drop-while`        | tagless            | Polymorphic list/vector                                                 |
| `take`              | sequence           | Polymorphic; SRFI "any value at n=0" tolerance **deliberately dropped** |
| `drop`              | sequence           | Polymorphic; same loud-crash discipline                                 |
| `span`              | define             | Returns **`(list prefix rest)`**, not multi-values                      |
| `break`             | define             | Same list product                                                       |
| `partition`         | define             | Returns **`(list yes no)`**                                             |
| `find-tail`         | define             | Miss → `#f` (correct)                                                   |
| `last-pair`         | define             | Non-empty pair required at contract                                     |
| `last`              | define             |                                                                         |
| `first` … `tenth`   | define             | Via private `%list-nth`; empty → teaching `error`                       |
| `list-tabulate`     | define             |                                                                         |
| `fold-right`        | define             | Single-list body (SRFI is n-ary)                                        |
| `reduce-right`      | define             |                                                                         |
| `concatenate`       | define             |                                                                         |
| `append-reverse`    | define             |                                                                         |
| `delete`            | define             | No optional `=` comparator                                              |
| `remove`            | define             | Delegates to `filter`                                                   |
| `length+`           | define             | Floyd cycle; `#f` on circular                                           |
| `iota`              | define             |                                                                         |
| `delete-duplicates` | define             | No optional comparator                                                  |
| `filter-map`        | define             |                                                                         |
| `count`             | define             |                                                                         |
| `append-map`        | define             |                                                                         |
| `some`              | define             | **SRFI name is `any`**; result is `#t`/`#f` only                        |
| `every`             | define             | Result is `#t`/`#f` only (not last-pred-value)                          |
| `zip`               | define             |                                                                         |
| `list-index`        | define             |                                                                         |
| `unfold`            | define             | **Non-SRFI protocol** (see §2.4)                                        |

### 1.2 Doored in pack today

| Symbol | Door reason (summary)                                                      |
| ------ | -------------------------------------------------------------------------- |
| `fold` | Bare SRFI-1 `fold` not bound under that name — use `reduce` / `fold-right` |

### 1.3 Private helpers (not SRFI exports)

`%list-nth`, `%any-null?`, `%some`, `%every`

### 1.4 Arrival extras (not official SRFI-1)

| Symbol     | Role                                                                |
| ---------- | ------------------------------------------------------------------- |
| `first?`   | Safe head → `#f` on non-pair (falsy sentinel; twin of SRFI `first`) |
| `first-or` | Safe head with default                                              |
| `range`    | `(iota stop)` sugar                                                 |

### 1.5 Official SRFI-1 names live **outside** this pack

Agents can still call these via R7RS packs; under **pack-local** all-or-nothing they are still **missing from `scheme/srfi-1`** unless re-exported or doored with a "see X" message.

| Cluster             | Symbols                                                               | Where                                 |
| ------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| Constructors        | `cons`, `list`, `make-list`, `list-copy`                              | `scheme/lists`                        |
| Predicates / access | `pair?`, `null?`, `car`/`cdr`/cxr family                              | equality / kernel cxr                 |
| Selectors           | `list-ref` (`list-tail` is R7RS rename of `drop` — not SRFI-1 export) | `scheme/lists`                        |
| Misc                | `length`, `append`, `reverse`                                         | `scheme/lists`                        |
| Map                 | `map`, `for-each`                                                     | `scheme/lists`                        |
| Search              | `member`, `memq`, `memv`, `assoc`, `assq`, `assv`                     | `scheme/lists`                        |
| Mutators            | `set-car!`, `set-cdr!`, `append!`, `list-set!`                        | **doored** in `scheme/lists` (purity) |

---

## 2. Full official SRFI-1 surface — missing, bucketed

Complete export inventory from the SRFI-1 procedure index.  
**Legend:** ✅ live in pack · 🚪 doored in pack · 📦 live elsewhere · 🔇 silent missing · ✚ arrival extra

### 2.1 Door purity — linear-update / mutators (`!` family + side-effects)

Same spirit as `set-car!` / `append!` in `r7rs/lists.ts`: values are frozen; mutation would falsify provenance lineage; use pure constructors / pure twins.

| Export                    | Status             | Suggested door one-liner                                                    |
| ------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `set-car!`                | 📦 doored in lists | Mirror purity door (or "already doored in scheme/lists — pairs are frozen") |
| `set-cdr!`                | 📦 doored in lists | Same                                                                        |
| `append!`                 | 📦 doored in lists | Same → use `append`                                                         |
| `take!`                   | 🔇                 | Linear-update; use pure `take`                                              |
| `drop-right!`             | 🔇                 | Linear-update; use pure `drop-right` (once live) or rebuild                 |
| `split-at!`               | 🔇                 | Linear-update; use pure `split-at` product                                  |
| `concatenate!`            | 🔇                 | Use pure `concatenate`                                                      |
| `reverse!`                | 🔇                 | Use pure `reverse`                                                          |
| `append-reverse!`         | 🔇                 | Use pure `append-reverse`                                                   |
| `append-map!`             | 🔇                 | Use pure `append-map`                                                       |
| `map!`                    | 🔇                 | Use pure `map`                                                              |
| `filter!`                 | 🔇                 | Use pure `filter`                                                           |
| `partition!`              | 🔇                 | Use pure `partition` → `(list yes no)`                                      |
| `remove!`                 | 🔇                 | Use pure `remove`                                                           |
| `take-while!`             | 🔇                 | Use pure `take-while`                                                       |
| `span!`                   | 🔇                 | Use pure `span`                                                             |
| `break!`                  | 🔇                 | Use pure `break`                                                            |
| `delete!`                 | 🔇                 | Use pure `delete`                                                           |
| `delete-duplicates!`      | 🔇                 | Use pure `delete-duplicates`                                                |
| `alist-delete!`           | 🔇                 | Use pure `alist-delete` (once live)                                         |
| `lset-union!`             | 🔇                 | Linear-update list-set; pure twin or rebuild                                |
| `lset-intersection!`      | 🔇                 | Same                                                                        |
| `lset-difference!`        | 🔇                 | Same                                                                        |
| `lset-xor!`               | 🔇                 | Same                                                                        |
| `lset-diff+intersection!` | 🔇                 | Same                                                                        |

**Count:** ~26 purity doors (4 already taught in lists; ~22 still silent in srfi-1).

**Shared door template (reuse lists wording):**

> every value is frozen by design — linear-update / mutating list ops would falsify the provenance lineage the spine carries; use the pure twin (`X` without `!`) or rebuild with `cons` / `append` / `filter` / …

---

### 2.2 Door not-in-subset — pure but we won't ship yet

Reasons are one-liners for door text. Prefer doors over silent absence even when the name is "famous."

#### Constructors

| Export          | Reason one-liner                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `xcons`         | Tiny HOF sugar `(lambda (d a) (cons a d))` — not in agent grain; write `cons` flipped or `λ`                                         |
| `cons*`         | Rest-as-tail constructor; use nested `cons` / `list` + last cdr (candidate to promote — see §2.3)                                    |
| `circular-list` | Cycle construction is outside the immutable subset (no live spine mutation to close a ring); circular _detection_ lives in `length+` |

#### Predicates

| Export           | Reason one-liner                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `proper-list?`   | Not in shipped subset; use `list?` / pair-walk + `null?` (or promote — small)             |
| `circular-list?` | Not shipped; `length+` → `#f` is the cycle answer we expose                               |
| `dotted-list?`   | Not shipped; dotted tails are tolerated only where SRFI blesses (`take`/`drop`/`length+`) |
| `not-pair?`      | Sugar for `(not (pair? x))` — door or one-line define                                     |
| `null-list?`     | Termination helper for proper/circular lists; door or alias of careful `null?`            |
| `list=`          | Element-wise n-ary list equality with custom `elt=`; use `equal?` or write a fold         |

#### Selectors

| Export       | Reason one-liner                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `car+cdr`    | Multi-return deconstructor — multi-return is doored; use `(list (car p) (cdr p))` or `first`+`cdr` |
| `take-right` | Pure but unshipped; rebuild with `length` + `drop` / reverse-take pattern (high-value candidate)   |
| `drop-right` | Pure but unshipped; same (high-value candidate)                                                    |
| `split-at`   | Pure multi-product; ship as `(list (take xs n) (drop xs n))` when promoted                         |

#### Miscellaneous

| Export                          | Reason one-liner                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `unzip1`…`unzip5`               | Transpose inverse of `zip`; multi-return for n>1 — return list-of-lists or door as low grain                                                |
| `pair-fold` / `pair-fold-right` | Fold over **pairs** (sublists), often used with `set-cdr!`; pure use is rare here                                                           |
| `unfold-right`                  | Iterative dual of historical/`SRFI` unfold; not in grain                                                                                    |
| `map-in-order`                  | Ordered map for effectful procs; arrival `map` order is already deterministic enough for pure code — door "use `map`" or implement as alias |
| `pair-for-each`                 | Side-effect walk of pairs; use `for-each` on cars or recurse on `cdr`                                                                       |
| `any`                           | **Name missing** — live under Ramda name `some`; door: `use some` (or rebind — §2.3 / §2.4)                                                 |

#### Association lists (pure)

| Export         | Reason one-liner                                           |
| -------------- | ---------------------------------------------------------- |
| `alist-cons`   | `(cons (cons key val) alist)` — trivial; door or implement |
| `alist-copy`   | Spine copy of alist pairs; use `map`/`list-copy` patterns  |
| `alist-delete` | Filter by key; use `remove`/`filter` with `equal?` on cars |

#### List-sets (pure)

| Export                   | Reason one-liner                                                            |
| ------------------------ | --------------------------------------------------------------------------- |
| `lset<=`                 | List-as-set ⊆ with custom `=` — O(n²) set algebra not in agent grain        |
| `lset=`                  | List-as-set equality                                                        |
| `lset-adjoin`            | Set adjoin                                                                  |
| `lset-union`             | Set union                                                                   |
| `lset-intersection`      | Set intersection                                                            |
| `lset-difference`        | Set difference                                                              |
| `lset-xor`               | Symmetric difference                                                        |
| `lset-diff+intersection` | Multi-product set split — multi-return doored; list product if ever shipped |

**Note:** entire `lset*` pure family can share one reason string ("list-as-set algebra is outside the shipped SRFI-1 subset; use `member`/`delete`/`delete-duplicates`/`filter` compositions").

#### Fold name already handled

| Export | Status                                      |
| ------ | ------------------------------------------- |
| `fold` | 🚪 already doored → `reduce` / `fold-right` |

#### R5RS overlaps only outside pack

Not "not-in-subset" of Arrival — they work — but pack-local completeness still wants either **thin re-export** or **door pointing at peer pack**. Prefer **document-as-peer** doors only if re-export is undesirable (noise). Decision deferred to PR1 design note: either (A) leave R5RS names solely in lists/equality (header documents peer coverage) **or** (B) re-export aliases in srfi-1 for "one module = one index." Policy default for other SRFIs: **doors for anything not live in-pack**, including "see scheme/lists."

---

### 2.3 Implement candidates — high value, small

Ordered by agent hit-rate × implementation cost (Scheme `symbol.define` unless noted).

| Priority | Export                            | Why                                                           | Sketch                                                                      |
| -------- | --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| P0       | `any`                             | Spec name; only `some` bound → silent failure for SRFI code   | Alias `(define any some)` **or** door→`some` if boolean-only semantics stay |
| P0       | `take-right` / `drop-right`       | Natural pair with `take`/`drop`; agents reach for them        | Length + drop / reverse-take; dotted-tail care per SRFI                     |
| P0       | `split-at`                        | Natural product of take+drop                                  | `(list (take xs n) (drop xs n))` — same product style as span               |
| P1       | `cons*`                           | Common rest constructor                                       | Nested cons; last arg is tail                                               |
| P1       | `xcons`                           | One-liner HOF                                                 | `(lambda (d a) (cons a d))`                                                 |
| P1       | `null-list?` / `not-pair?`        | Termination idioms in portable SRFI code                      | Thin wrappers                                                               |
| P1       | `alist-cons` / `alist-delete`     | Alist grain without full lset                                 | Cons pair; filter by key                                                    |
| P2       | `proper-list?` / `circular-list?` | Completes the proper/circular/dotted partition with `length+` | Reuse Floyd / existing circular helpers in lists                            |
| P2       | `unzip1`                          | Inverse of single-list zip                                    | `(map car lists)`                                                           |
| P2       | `map-in-order`                    | Spec synonym when order matters                               | Alias `map` if map is L→R                                                   |

**Defer implement (door only unless demand spikes):** full `lset*`, `unzip2`–`5`, `pair-fold*`, SRFI-shaped `unfold` under a new name, `circular-list`.

---

### 2.4 Semantic bugs / deviations in live code

These are **not** silent absences — they are wrong-or-divergent behavior under the SRFI name. Fix or document-in-header **before** claiming subset honesty.

| #   | Symbol                         | SRFI expectation                                                          | Arrival today                                                                     | Severity                              | Proposed fix                                                                                                                                                         |
| --- | ------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `find`                         | Miss → **`#f`**                                                           | Miss → **`nil`** (truthy ANil)                                                    | **Critical**                          | Return `#f` on empty/miss; aligns with `find-tail` and with `first?`'s own falsy-on-empty rationale                                                                  |
| 2   | `find` pred                    | Only `#f` is false                                                        | Treats **ANil as false** in pred result (`!is_false && !(value instanceof ANil)`) | Medium                                | Pred truthiness = Scheme (`is_false` only), unless deliberate nil-as-absent policy is documented pack-wide                                                           |
| 3   | `any` vs `some`                | Export name **`any`**                                                     | Only **`some`**                                                                   | High                                  | Bind `any` (alias) and keep `some` as arrival/Ramda alias; door alone is incomplete for ported code                                                                  |
| 4   | `some` / `every`               | Return **last true pred value** (not only boolean)                        | Always `#t`/`#f`                                                                  | Medium (documented)                   | Keep as **named subset deviation** in header; optional later true SRFI return                                                                                        |
| 5   | `unfold`                       | `(p f g seed [tail-gen])`                                                 | `(fn init)` with `fn` → `(head . next)` or `#f`                                   | **Critical (name collision)**         | Either rename historical to e.g. `unfold-pair` / keep under non-SRFI name, door official `unfold`, **or** implement SRFI protocol under `unfold` and move historical |
| 6   | `fold` / `reduce`              | `fold` is the fundamental iterator; `reduce` uses ridentity only on empty | `fold` doored; `reduce` is tagless left-fold                                      | OK if door stays + header honest      | Keep door; document that n-ary `fold` is not shipped                                                                                                                 |
| 7   | `fold-right`                   | N-ary parallel lists                                                      | Single-list only                                                                  | Low                                   | Document; door n-ary or extend later                                                                                                                                 |
| 8   | `delete` / `delete-duplicates` | Optional `=`                                                              | Always `equal?` / `member`                                                        | Low                                   | Document; optional comparator later                                                                                                                                  |
| 9   | `take` / `drop`                | `(take 5 0)` → `()`                                                       | Loud TypeError                                                                    | Low (deliberate)                      | Keep; document as strict typing over SRFI tolerance                                                                                                                  |
| 10  | `filter` / `take*` / `reduce`  | List-only library                                                         | Tagless polymorphism (vectors)                                                    | Low (arrival extension)               | Header: "sequence-generic where tagged"                                                                                                                              |
| 11  | `span` / `break` / `partition` | Multi-values                                                              | `(list a b)`                                                                      | Low (deliberate; multi-return doored) | Header must say list products, not values                                                                                                                            |
| 12  | Header claim                   | —                                                                         | "whole SRFI-1 surface lives here"                                                 | **Meta bug**                          | Retract; see §3                                                                                                                                                      |

**Already correct / fixed vs older audit notes:**

- `span` / `break` / `partition` bodies return `(list …)` — **not** calling doored `values` (tests in `srfi-1-symbol-define.test.ts` / `srfi.test.ts` pin list products).
- `find-tail` miss → `#f`.
- `length+` circular → `#f`.

---

## 3. Proposed header rewrite (honest subset claim)

Replace the current "whole surface" SCOPE blurb with something that cannot lie:

```text
// SRFI-1 — list library *subset* for immutable Arrival. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via `allSrfi`) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site for the
// names it owns.
//
// SCOPE (honest): this is NOT the full SRFI-1 export set. It is the agent-reached
// completion set + parallel-list utilities + a few arrival extras, under the pack
// policy **implement-or-door**:
//   • Live: take/drop/take-while/drop-while, span/break/partition (as (list a b)),
//     first…tenth, last/last-pair, find/find-tail, filter/remove/delete*,
//     fold-right/reduce/reduce-right, concatenate/append-reverse, iota, zip,
//     some/every, list-index, count, filter-map, append-map, length+, list-tabulate,
//     unfold (HISTORICAL protocol — see DEVIATIONS), …
//   • Doored: every remaining official SRFI-1 export — mutators/linear-update (`!`)
//     with purity doors; pure-but-unshipped names with subset doors; `fold` redirects
//     to reduce/fold-right.
//   • Peer-covered (R7RS lists/equality, not re-listed here unless doored): cons, list,
//     map, for-each, member/assoc family, set-car!/append! purity doors, …
//   • Extras (not SRFI): first?, first-or, range; private %… helpers.
//
// DEVIATIONS FROM SRFI-1 (read before porting code):
//   • Multi-return is doored on binding; span/break/partition/split-at products are
//     single values: (list a b […]).
//   • some is SRFI any under a Ramda-familiar name; both some and every return #t/#f
//     only (not last-pred-value).
//   • find miss must be #f (Scheme false), not nil — [track bug if still nil].
//   • unfold is NOT SRFI's (p f g seed) protocol; historical (fn init) pair-or-#f.
//   • take/drop/filter/reduce may be representation-polymorphic (tagless); SRFI is
//     list-only. take/drop reject non-collection receivers even at n=0.
//
// DEPS: equality, numeric, exceptions, lists (no multi-return binding dependency).
// CONTRACT CONVENTIONS: [keep existing listAlike / z.value notes …]
```

**Honesty test:** if an export is neither in the live list nor a `symbol.notImplemented` key in this file, the header is still a lie.

---

## 4. Suggested atomic PR order

### PR1 — Door batch (no behavior change for live names)

1. Add **purity doors** for every linear-update `!` export still silent (§2.1), reusing lists purity language.
2. Add **subset doors** for pure unshipped names (§2.2), including **`any` → use `some`** if PR2 does not bind `any` yet (prefer PR2 same-day).
3. Optionally door R5RS-overlap names with "bound in scheme/lists" **or** document peer coverage only in header (pick one policy and stick).
4. **Header rewrite** (§3) — retract "whole surface."
5. Tests: cold call each new door throws / `notImplemented` message shape (table-driven over export list).
6. Update stale comments in `srfi-1-symbol-define.test.ts` that still mention multi-values / `binding` dep if still wrong.

**Acceptance:** pack keys ∪ documented peers cover 100% of official index; score → COMPLETE under implement-or-door.

### PR2 — Semantic bugs (behavior fixes; small, test-gated)

1. **`find` miss → `#f`** (+ decide ANil-as-pred-false).
2. **`any` live alias of `some`** (keep `some`); remove temporary door if PR1 added one.
3. **`unfold` name collision:** either
   - **(preferred)** rename historical → `unfold-pair` (or similar), door or implement true SRFI `unfold`; or
   - keep historical under `unfold`, door is impossible — must document + add `srfi-unfold` for real protocol later.
4. Pin with golden tests against SRFI examples where we claim compliance.

### PR3 — Implement candidates (optional value batch)

1. `take-right`, `drop-right`, `split-at` (list product).
2. `cons*`, `xcons`.
3. `null-list?`, `not-pair?`; maybe `alist-cons` / `alist-delete`.
4. Promote doors → live by deleting door keys and adding defines (same PR or follow-ups).

### PR4 — Optional polish

1. Optional `=` on `delete` / `delete-duplicates`.
2. N-ary `fold-right` / true last-pred-value `any`/`every` if ported code demands.
3. `proper-list?` / `circular-list?` / `dotted-list?` partition.
4. Sync [`srfi-coverage.md`](srfi-coverage.md) SRFI-1 section (span multi-return note, deps list).

---

## 5. Quick inventory counts

| Bucket                                              | Approx count                         |
| --------------------------------------------------- | ------------------------------------ |
| Live public in pack                                 | ~45 names (`first`…`tenth` = 10)     |
| Doored in pack today                                | 1 (`fold`)                           |
| Extras + private                                    | 3 extras + 4 private                 |
| Official exports (index, excl. 28 cxr compositions) | ~120 procedure names                 |
| Silent missing (no live, no door in pack)           | **~70+**                             |
| Of which purity `!` / mutators                      | ~26                                  |
| Of which pure subset doors                          | ~40+                                 |
| Semantic bugs to fix before "honest subset"         | find miss; unfold protocol; any name |

---

## 6. Policy reminders (for implementers)

- **Immutable subset:** never implement a `!` op as real mutation; door only.
- **Multi-return:** already doored elsewhere; multi-product SRFI ops that we ship use **`(list …)`** (span pattern).
- **Silent absence is a bug** even for "we don't want this."
- **Partial surface without doors is a bug.**
- **Header claiming whole surface without doors is a lie** — fix is doors or retract claim (PR1 does both).
- Prefer **one shared reason string** per family (purity `!`, lset algebra, multi-return) to keep the door batch readable.

---

## 7. Cross-links

- Pack source: `src/env/srfi/srfi-1.ts`
- Lists purity doors: `src/env/r7rs/lists.ts` (`set-car!`, `set-cdr!`, `append!`, `list-set!`)
- Multi-return doors: `scheme/r7rs/binding` + SRFI-8 `receive`
- Behavior tests: `src/env/srfi/__tests__/srfi-1-symbol-define.test.ts`, `src/__tests__/srfi.test.ts`
- Official spec: https://srfi.schemers.org/srfi-1/srfi-1.html
