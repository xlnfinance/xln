# SRFI Pack Coverage

**Policy (immutable subset + implement-or-door):** For every SRFI shipped as an `EnvCapability` under `src/env/srfi/`, every official export is either **(a) live** or **(b) a teaching door**. Silent absence is a bug.  
We do **not** aim for full mutable R7RS/SRFI. Mutators / multi-return / dynamics: **door with reason**. Partial live surface without doors for the rest is still a bug.

**Scope:** packs in [`src/env/srfi/index.ts`](../../src/env/srfi/index.ts) (`allSrfi`).  
**Aside:** record types / `define-record-type` — separate stream, not scored here.

**Score rubric:**

| Score          | Meaning                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **COMPLETE**   | Every official export is live **or** doored in this pack (or fully provided by a documented peer pack that the SRFI pack claims as coverage). |
| **PARTIAL**    | Some official exports live/doored; others missing silently. Header may document a subset ("excuse") — still scored PARTIAL under policy.      |
| **STUBS-ONLY** | Pack is deliberately doors-only for _non-shipped_ libraries (scored separately).                                                              |

**Multi-return:** surface doors on binding; `receive` door on SRFI-8; span/break/partition return `(list a b)`; floor/truncate return pair products. No live free `(values …)` consumers remaining.

---

## Legend for tables

| Column      | Meaning                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| **Live**    | Bound with a non-door kind (`native` / `define` / `defineSyntax` / `sequence` / `tagless` / …) |
| **Doored**  | `symbol.notImplemented`                                                                        |
| **Missing** | Official SRFI export, neither live nor doored in this pack                                     |
| **Extra**   | In pack, not in that SRFI's official export set                                                |

Kinds abbreviated: `nat` native · `def` define · `stx` defineSyntax · `seq` sequence · `tag` tagless · `door` notImplemented · `priv` private `%…` helper

---

## SRFI-1 — List Library (`srfi-1.ts`)

**Capability:** `scheme/srfi-1`  
**Header claim:** honest **immutable subset** + implement-or-door.  
**Explicit subset excuse:** **Yes** — live completion set; remaining official exports are purity / subset doors; peers in `scheme/lists`.  
**Deps:** `equality`, `numeric`, `exceptions`, `vectors`, `lists` (no binding)  
**Score:** **COMPLETE** under implement-or-door (pack keys cover official index; R5RS peers documented as live-elsewhere; residual: historical `unfold` protocol)

### Pack symbols (all keys)

| Symbol                                                      | Kind     | Status vs SRFI-1                                                                                                                |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `filter`                                                    | seq      | Live (also R5RS-adjacent; polymorphic tagless)                                                                                  |
| `reduce`                                                    | tag      | Live                                                                                                                            |
| `fold`                                                      | door     | **Doored** — redirects to `reduce` / `fold-right`                                                                               |
| `find`                                                      | nat      | Live (returns `#f` on miss, per SRFI)                                                                                           |
| `take-while`                                                | tag      | Live                                                                                                                            |
| `drop-while`                                                | tag      | Live                                                                                                                            |
| `take`                                                      | seq      | Live (representation-polymorphic; SRFI n=0-any-value tolerance dropped)                                                         |
| `drop`                                                      | seq      | Live                                                                                                                            |
| `span`                                                      | def      | Live — `(list prefix rest)` product                                                                                             |
| `break`                                                     | def      | Live — `(list prefix rest)` product                                                                                             |
| `partition`                                                 | def      | Live — `(list yes no)` product                                                                                                  |
| `find-tail`                                                 | def      | Live                                                                                                                            |
| `last-pair`                                                 | def      | Live                                                                                                                            |
| `last`                                                      | def      | Live                                                                                                                            |
| `%list-nth`                                                 | def/priv | Extra (private)                                                                                                                 |
| `first`…`tenth`                                             | def      | Live                                                                                                                            |
| `list-tabulate`                                             | def      | Live                                                                                                                            |
| `fold-right`                                                | def      | Live (single-list only in practice; SRFI n-ary)                                                                                 |
| `reduce-right`                                              | def      | Live                                                                                                                            |
| `concatenate`                                               | def      | Live                                                                                                                            |
| `append-reverse`                                            | def      | Live                                                                                                                            |
| `delete`                                                    | def      | Live (no optional `=` comparator)                                                                                               |
| `remove`                                                    | def      | Live                                                                                                                            |
| `first?`                                                    | def      | **Extra** (arrival safe-head)                                                                                                   |
| `first-or`                                                  | def      | **Extra**                                                                                                                       |
| `length+`                                                   | def      | Live                                                                                                                            |
| `iota`                                                      | def      | Live                                                                                                                            |
| `range`                                                     | def      | **Extra** (arrival sugar = `(iota stop)`)                                                                                       |
| `delete-duplicates`                                         | def      | Live (no optional comparator)                                                                                                   |
| `filter-map`                                                | def      | Live                                                                                                                            |
| `count`                                                     | def      | Live                                                                                                                            |
| `append-map`                                                | def      | Live                                                                                                                            |
| `%any-null?` / `%some` / `%any` / `%every` / `%every-value` | def/priv | Extra (private)                                                                                                                 |
| `any?`                                                      | def      | Live — HONEST `#t`/`#f` boolean predicate (arrival's `?`-suffixed convention)                                                   |
| `some`                                                      | alias    | **Alias of `any?`** (Ramda-familiar name), stays boolean                                                                        |
| `any`                                                       | def      | Live — SRFI-1's own value-returning quantifier: first truthy predicate RESULT, or `#f`                                          |
| `every?`                                                    | def      | Live — HONEST `#t`/`#f` boolean predicate; vacuously `#t` on empty                                                              |
| `every`                                                     | def      | Live — SRFI-1's own value-returning quantifier: LAST predicate RESULT if every tuple truthy, `#t` on empty, `#f` on first falsy |
| `zip`                                                       | def      | Live                                                                                                                            |
| `list-index`                                                | def      | Live                                                                                                                            |
| `unfold`                                                    | def      | Live but **non-SRFI shape** — `(fn init)` where `fn` → `(head . next)` or `#f`; official is `(p f g seed [tail-gen])`           |

### Provided outside this pack (R7RS / lists / equality) — still not pack-local doors

These are SRFI-1 exports that exist in the base env under other packs (so agents may succeed) but are **not** present as live-or-door keys of `scheme/srfi-1`. Under pack policy they remain **Missing from pack** (with note).

| Symbol                                                                                                                                                    | Where live                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `cons`, `list`, `make-list`, `list-copy`, `append`, `reverse`, `length`, `list-ref`, `map`, `for-each`, `member`, `memq`, `memv`, `assoc`, `assq`, `assv` | `scheme/lists` / equality      |
| `pair?`, `null?`, `car`/`cdr`/cxr                                                                                                                         | equality / kernel cxr          |
| `set-car!`, `set-cdr!`, `append!`                                                                                                                         | **doored** in `lists` (purity) |

### Missing (official SRFI-1, silent in pack)

**None.** Former silent names are purity / subset doors (see `DOORS` in `srfi-1.ts`). Remaining work is optional **implement** promotions (take-right/drop-right/split-at/cons\*/…) and a semantic bug (SRFI-shaped `unfold`).

Linear-update (`!`) family could honestly door with the same purity reason as `append!`/`set-car!` — today they are **silent**.

### Extra

`first?`, `first-or`, `range`, private `%…` helpers; `any?`/`every?` (honest boolean predicates); `some` as Ramda alias for `any?`.

### Semantic partials (not multi-return)

1. **`unfold` is not SRFI-1 `unfold`** — same name, different protocol.
2. **`fold` doored** but **`reduce` is not SRFI-1's `fold`** (different seed/`ridentity` contract) — door text explains rename; OK as door, still leaves n-ary `fold` missing.

---

## SRFI-13 — String Libraries (`srfi-13.ts`)

**Capability:** `scheme/srfi-13`  
**Header claim:** Completes grain for agent-reached subset; **explicit scope narrowing** (no char-sets; no start/end; `string-split` from SRFI-152) + implement-or-door for the rest.  
**Explicit subset excuse:** **Yes**.  
**Score:** **COMPLETE** under implement-or-door

### Pack symbols (live)

| Symbol                                                                    | Kind  | Notes                                                               |
| ------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------- |
| `string-null?`                                                            | nat   | Live                                                                |
| `string-prefix?`                                                          | nat   | Live (no `-ci`, no start/end)                                       |
| `string-suffix?`                                                          | nat   | Live                                                                |
| `string-index`                                                            | nat   | Live (char or 1-arg pred; no char-set; no start/end)                |
| `string-count`                                                            | nat   | Live (same criterion limits)                                        |
| `string-take` / `string-drop` / `string-take-right` / `string-drop-right` | nat   | Live                                                                |
| `string-trim`                                                             | nat   | **Official left-only**                                              |
| `string-trim-both`                                                        | nat   | Official both-ends                                                  |
| `string-trim-left`                                                        | alias | Non-index synonym of `string-trim`                                  |
| `string-trim-right`                                                       | nat   | Live (matches official)                                             |
| `string-pad` / `string-pad-right`                                         | nat   | Live (no start/end)                                                 |
| `string-reverse`                                                          | nat   | Live                                                                |
| `string-join`                                                             | nat   | Live (default space delimiter; no `grammar` arg)                    |
| `string-tokenize`                                                         | nat   | Live (no char-set; default non-whitespace)                          |
| `string-split`                                                            | nat   | **Extra** — SRFI-**152**, intentional                               |
| _(remaining index)_                                                       | door  | Purity / subset / shared / KMP / compare-name doors in pack `DOORS` |

### Doored elsewhere (related, not this pack)

| Symbol                                          | Where                        |
| ----------------------------------------------- | ---------------------------- |
| `string-set!` / `string-fill!` / `string-copy!` | `r7rs/strings` purity doors  |
| Char-set API used by SRFI-13 criteria           | `srfi-stubs` (SRFI-14 doors) |

### R7RS strings overlap (not in this pack)

Live elsewhere: `string?`, `make-string`, `string`, `string-length`, `string-ref`, `string-append`, `string-copy`, `string->list`, `list->string`, `string-map`, `string-for-each`, `string-upcase`/`downcase`/`foldcase`, comparisons (`string=?`… + ci), `string-contains` (+ arrival `string-contains?`).

### Missing (silent)

**None** for official SRFI-13 index names after door batch. Optional next: promote a few
live implementations (`string-filter`/`string-delete`/`string-index-right`/…).

### Documented partials (not silent gaps)

1. **No start/end** on any op (documented).
2. **Criteria:** char or pred only — char-sets doored in stubs.
3. **`string-join`** no `grammar` arg.

---

## SRFI-2 — `and-let*` (`srfi-2.ts`)

**Official exports:** `and-let*` only.  
**Pack:** `and-let*` → `defineSyntax` (`macroAttribute: "binder"`).  
**Header excuse:** n/a (full).  
**Score:** **COMPLETE**

| Status  | Symbols    |
| ------- | ---------- |
| Live    | `and-let*` |
| Doored  | —          |
| Missing | —          |
| Extra   | —          |

---

## SRFI-8 — `receive` (`srfi-8.ts`)

**Official exports:** `receive` only.  
**Pack:** `receive` → **door** (multi-return family; all-or-nothing for this SRFI).  
**Score:** **COMPLETE** (doors-only).

---

## SRFI-26 — `cut` / `cute` (`srfi-26.ts`)

**Official exports:** `cut`, `cute` (plus placeholder tokens `<>` / `<...>` as syntax, not bindings).  
**Pack:** both `defineSyntax`, `macroAttribute: "opaque"`.  
**Score:** **COMPLETE**

| Status  | Symbols       |
| ------- | ------------- |
| Live    | `cut`, `cute` |
| Missing | —             |
| Extra   | —             |

Note: `<>` is also a polyglot-stubs door elsewhere; cut's opaque attribute avoids false unbound diagnostics.

---

## SRFI-28 — Basic Format Strings (`srfi-28.ts`)

**Official exports:** `format` only (`~a` `~s` `~%` `~~`).  
**Pack:** `format` native; admits `(format #f fmt …)`; adds `~d` and bounded `~F`/`~w,dF`; non-`#f` destinations throw teaching error (not a `notImplemented` symbol door).  
**Header excuse:** Yes — string-only subset + SRFI-48-ish extensions.  
**Score:** **COMPLETE** (single official export is live)

| Status           | Symbols                             |
| ---------------- | ----------------------------------- |
| Live             | `format`                            |
| Extra (behavior) | `#f` destination, `~d`, `~F` family |
| Missing symbols  | —                                   |

Directive gaps vs SRFI-48 are not SRFI-28 export gaps.

---

## SRFI-43 — Vector Library (`srfi-43.ts`)

**Header:** _"pure ops only; arrival vectors are immutable"_. Partial set of 8 defines; **no doors** for the rest.  
**Explicit subset excuse:** Implied ("pure ops only"), not a full export checklist.  
**Score:** **PARTIAL**

### Pack symbols (all Live `def`)

| Symbol                        | Notes                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `vector-fold`                 | **Arity deviation:** pack `(kons acc elt)`; SRFI-43 `(kons i state elt …)` **includes index** and multi-vector |
| `vector-fold-right`           | Same kons-shape deviation                                                                                      |
| `vector-count`                | Single-vector; SRFI multi-vector + index to pred                                                               |
| `vector-index`                | Single-vector                                                                                                  |
| `vector-binary-search`        | Live                                                                                                           |
| `vector-empty?`               | Live                                                                                                           |
| `vector-any` / `vector-every` | Single-vector                                                                                                  |

### R7RS vectors (elsewhere)

Live: `make-vector`, `vector`, `vector?`, `vector-length`, `vector-ref`, `vector-append`, `vector-copy`, `vector->list`, `list->vector`, `vector->string`, `string->vector`, `vector-map`, `vector-for-each`  
Doored purity: `vector-set!`, `vector-fill!`, `vector-copy!`

### Missing (silent) — non-exhaustive

`vector-unfold`, `vector-unfold-right`, `vector-reverse-copy`, `vector-concatenate`, `vector=`, `vector-index-right`, `vector-skip`, `vector-skip-right`, `vector-map!`, mutators (`vector-swap!`, `vector-reverse!`, `vector-reverse-copy!`), `reverse-vector->list`, `reverse-list->vector`, multi-vector variants of fold/map/count/index/any/every.

Mutators should door with purity reason; pure constructors/search siblings should live or door.

### Purity partials

Kons/pred **index-first** SRFI protocol not followed — silent semantic drift under same names.

---

## SRFI-95 — Sorting and Merging (`srfi-95.ts`)

**Official exports:** `sorted?`, `merge`, `merge!`, `sort`, `sort!` (optional `key` on all).  
**Pack:** only `sort` (`sequence` → tagless term). Optional `less?`; **no `key`**. Default order = elements' `lte` when comparator omitted (SRFI requires `less?`).  
**Header:** describes `sort` only — no full-SRFI claim.  
**Score:** **PARTIAL**

| Status         | Symbols                                      |
| -------------- | -------------------------------------------- |
| Live           | `sort`                                       |
| Missing silent | `sorted?`, `merge`, `merge!`, `sort!`        |
| Should-door    | `merge!`, `sort!` (mutation / linear-update) |

### Purity / contract

`sort!`/`merge!` fit purity doors; `sorted?`/`merge` are pure and simply absent.

---

## SRFI-128 — Comparators (`srfi-128.ts`)

**Official surface:** large (predicates, constructors, hash suite, bounds/salt, default comparator machinery, accessors/invokers, `=?`…, `comparator-if<=>`).  
**Pack:** compact subset + private helpers.  
**Header:** no "full SRFI" claim; documents hash ignored.  
**Score:** **PARTIAL**

### Pack symbols

| Symbol                           | Kind | Notes                                                                                                        |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `make-comparator`                | def  | Live; 4th hash arg accepted & **ignored**                                                                    |
| `comparator?`                    | def  | Live (tag-list encoding, not disjoint type)                                                                  |
| `comparator-type-test-predicate` | def  | Live                                                                                                         |
| `comparator-equality-predicate`  | def  | Live                                                                                                         |
| `comparator-ordering-predicate`  | def  | Live                                                                                                         |
| `comparator-hashable?`           | def  | Always `#f`                                                                                                  |
| `%chain-rel`                     | priv | Extra                                                                                                        |
| `=?` `<?` `>?` `<=?` `>=?`       | def  | Live                                                                                                         |
| `%type-rank` / `%default-less`   | priv | Extra                                                                                                        |
| `make-default-comparator`        | def  | Live (limited type order)                                                                                    |
| `default-comparator`             | def  | **0-arg procedure** re-calling `make-default-comparator` — not a shared value; header says "shared instance" |

### Missing (silent) — high-value

`comparator-ordered?`, `comparator-hash-function`, `comparator-test-type`, `comparator-check-type`, `comparator-hash`,  
`make-pair-comparator`, `make-list-comparator`, `make-vector-comparator`, `make-eq-comparator`, `make-eqv-comparator`, `make-equal-comparator`,  
`boolean-hash`…`number-hash`, `hash-bound`, `hash-salt`, `default-hash`, `comparator-register-default!`,  
`comparator-if<=>`.

Hash-related symbols could door with "no value-hash" (consistent with `comparator-hashable?`).

---

## SRFI-151 — Bitwise Operations (`srfi-151.ts`)

**Header excuse:** **Yes** — core five already in `scheme/numeric`; pack adds only `bit-count`.  
**Score:** **PARTIAL** (excuse explicit; policy still wants doors for the rest)

### Pack

| Symbol      | Kind     |
| ----------- | -------- |
| `bit-count` | nat Live |

### Live outside pack (`r7rs/numeric`)

`bitwise-and`, `bitwise-ior`, `bitwise-xor`, `bitwise-not`, `arithmetic-shift` (+ `<<` `>>` aliases)

### Missing silent (official index remainder)

`bitwise-eqv`, `bitwise-nand`, `bitwise-nor`, `bitwise-andc1`, `bitwise-andc2`, `bitwise-orc1`, `bitwise-orc2`,  
`integer-length`, `bitwise-if`,  
`bit-set?`, `copy-bit`, `bit-swap`, `any-bit-set?`, `every-bit-set?`, `first-set-bit`,  
full **bit-field** suite, **bits conversion** (`bits->list`, …), `bitwise-fold` / `for-each` / `unfold`, `make-bitwise-generator`.

---

## SRFI-189 — Maybe & Either (`srfi-189.ts`)

**Header:** no full-SRFI claim; tagged-list encoding; multi-value payloads not supported.  
**Score:** **PARTIAL** (large SRFI; ~¼ of surface)

### Pack symbols (all `def` Live)

**Constructors:** `just`, `nothing`, `left`, `right`  
**Predicates:** `just?`, `nothing?`, `maybe?`, `left?`, `right?`, `either?`  
**Maybe:** `maybe-ref`, `maybe-ref/default`, `maybe-bind`, `maybe-map`, `maybe->list`, `list->maybe`, `maybe->either`  
**Either:** `either-ref`, `either-ref/default`, `either-bind`, `either-map`, `either->list`, `either-swap`

### Missing silent (large)

Constructors: `list->just`, `list->left`, `list->right`, `either->maybe`  
Predicates: `maybe=`, `either=`  
Accessors: multi-value / success-callback forms of ref  
Join/bind: `maybe-join`, `either-join`, `maybe-compose`, `either-compose`, multi-mproc bind  
Sequence: `maybe-length`, `either-length`, `maybe-filter`/`remove`, `either-filter`/`remove`, `maybe-sequence`, `either-sequence`  
Protocol conversions: truth/list-truth/generation/values/two-values/exception families (most)  
Map/fold: `maybe-for-each`, `either-for-each`, `maybe-fold`, `either-fold`, unfolds  
**Syntax:** `maybe-if`, `maybe-and`/`or`, `either-and`/`or`, `maybe-let*`, `either-let*`, `*-let*-values`, `either-guard`  
**Trivalent:** `tri-not`, `tri=?`, `tri-and`, `tri-or`, `tri-merge`

### Contract / semantic deltas

- Payloads are **single-value** tagged lists; SRFI allows multi-value Just/Left/Right.
- `maybe-ref`: failure optional (defaults `error`); SRFI requires failure, optional success (`values`).
- No disjoint types — `pair?` predicates on tags.

---

## SRFI-235 — Combinators (`srfi-235.ts`)

**Header excuse:** **Yes** — "combinator survivors" from arrival-extensions; documents `always` ≠ SRFI `always`.  
**Score:** **PARTIAL**

### Pack symbols

| Symbol                | Kind | vs SRFI-235                                                 |
| --------------------- | ---- | ----------------------------------------------------------- |
| `complement`          | def  | Live (matches)                                              |
| `constantly`          | def  | Live (single-value form; SRFI variadic objs)                |
| `always`              | def  | Live — SRFI-235 (`#t` regardless of args); not `constantly` |
| `never`               | def  | Live — SRFI-235 (`#f` regardless of args)                   |
| `curry`               | def  | **Extra** (not SRFI-235)                                    |
| `procedure-min-arity` | nat  | **Extra** (support for curry)                               |

### Missing silent (most of SRFI-235)

`flip`, `swap`, `on-left`, `on-right`, `conjoin`, `disjoin`, `each-of`, `all-of`, `any-of`, `on`, `left-section`, `right-section`, `apply-chain`, `arguments-drop`/`drop-right`/`take`/`take-right`, `group-by`,  
syntax-like procedure forms, `boolean`, … (rest of SRFI-235).

`always` and `never` are SRFI-235-faithful: constant regardless of arguments, distinct from `constantly` (which returns one fixed value).

---

## SRFI-stubs (`srfi-stubs.ts`) — STUBS-ONLY (not scored as incomplete SRFI-1/13/…)

**Capability:** `scheme/srfi-stubs` — deliberate teaching doors for libraries **not** shipped as real packs.

| Family                  | Doors                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SRFI-69/125 hash tables | `make-hash-table`, `hash-table?`, `hash-table-ref`, `hash-table-ref/default`, `hash-table-set!`, `hash-table-delete!`, `hash-table-update!`, `hash-table->alist`, `alist->hash-table`, `hash-table-keys`, `hash-table-values`, `hash-table-walk`, `hash-table-fold`, `hash-table-count`, `hash-table-exists?`, `hash-table-contains?` |
| SRFI-27 random          | `random-integer`, `random-real`, `random-source-make-integers`                                                                                                                                                                                                                                                                        |
| SRFI-14 char-sets       | `char-set`, `char-set?`, `char-set-contains?`, `string->char-set`, `char-set:whitespace`, `char-set:alphabetic`, `char-set:numeric`                                                                                                                                                                                                   |
| SRFI-19 time            | `current-date`, `current-time`, `date->string`, `string->date`, `time-utc->date`, `current-julian-day`                                                                                                                                                                                                                                |
| SRFI-113 sets           | `list->set`, `set-contains?`                                                                                                                                                                                                                                                                                                          |
| SRFI-6 string ports     | `call-with-input-string`                                                                                                                                                                                                                                                                                                              |

**Score:** **STUBS-ONLY** (by design). Cross-family only — SRFI-13 pure gaps live in `scheme/srfi-13` now.

---

## Final summary (worst gaps first)

| Rank | Pack           | Score      | Severity    | Headline                                           |
| ---- | -------------- | ---------- | ----------- | -------------------------------------------------- |
| 1    | **SRFI-189**   | PARTIAL    | High        | Core Maybe/Either subset; rest silent              |
| 2    | **SRFI-128**   | PARTIAL    | High        | Comparator core; hash/constructor surface silent   |
| 3    | **SRFI-151**   | PARTIAL    | High        | Explicit thin subset; rest silent                  |
| 4    | **SRFI-43**    | PARTIAL    | Medium-High | Pure ops only; mutators undooored in pack          |
| 5    | **SRFI-235**   | PARTIAL    | Medium      | `always`/`never` fixed; rest of combinators silent |
| 6    | **SRFI-95**    | PARTIAL    | Medium      | Only `sort`; mutators/siblings silent              |
| 7    | **SRFI-1**     | COMPLETE   | Low         | Subset + doors; residual `unfold` semantics        |
| 8    | **SRFI-13**    | COMPLETE   | Low         | Trim fixed; purity/subset doors; peers in strings  |
| 9    | **SRFI-8**     | COMPLETE   | Low         | Doors-only `receive`                               |
| 10   | **SRFI-28**    | COMPLETE   | Low         | `format` live                                      |
| 11   | **SRFI-26**    | COMPLETE   | Low         | `cut`/`cute` live                                  |
| 12   | **SRFI-2**     | COMPLETE   | Low         | `and-let*` live                                    |
| —    | **srfi-stubs** | STUBS-ONLY | n/a         | Deliberate non-shipped library doors               |

### Method notes

- Official lists taken from finalized SRFI HTML (srfi-1, 2, 8, 13, 26, 28, 43, 95, 128, 151, 189, 235).
- "Live elsewhere" (R7RS) is noted but **does not** count as pack-local compliance unless the SRFI pack re-exports or doors the name.
- Private `%…` symbols count as Extra, not Missing.
