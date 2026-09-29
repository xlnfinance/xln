# R7RS-small Coverage

> **Policy:** Every R7RS-small export is **implemented** or a `symbol.notImplemented` door. Silent absence is a bug. Exceptions stay implemented. Continuations / multi-return / dynamics may be doors.  
> **Immutable subset:** mutators and multi-return are doors with teaching reasons — we do not aim to make the full mutable R7RS work.  
> **Aside:** `define-record-type` / record SRFIs are **out of scope** here (separate workstream).  
> **Inventory source:** [`r7rs-symbol-map.md`](./r7rs-symbol-map.md)

---

## Executive summary

| Bucket                                                                                            | Health                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Multi-return surface (`values`, `call-with-values`, `let-values`, `let*-values`, `define-values`) | **Doors** (`r7rs/binding`)                                               |
| Host multi-product (`floor/`, `truncate/`)                                                        | **Impl as pair product** `(q . r)`                                       |
| call/cc, delay, parameters, case-lambda                                                           | **Doors** (`r7rs/control`)                                               |
| Exceptions §6.11                                                                                  | **Fully impl**                                                           |
| Mutators                                                                                          | **Doors** on type packs + `set!`                                         |
| Host §6.13 / §6.14                                                                                | **Totalized doors** (`r7rs/host` `DOORS` map, incl. `load` / `features`) |
| Eval §6.12                                                                                        | **Doors** (`r7rs/eval`)                                                  |
| Library / inclusion / feature-expand                                                              | **Doors** (`r7rs/syntax`)                                                |
| Numeric S2 (`square`, `exact-integer-sqrt`, `rationalize`)                                        | **Impl** (`exact-integer-sqrt` → pair product)                           |
| Still silent                                                                                      | `define-record-type` (records — out of scope); complex tower (separate)  |

---

## Focus clusters — current status

### §6.10 / multi-return / dynamics — done

| Symbol                                                                     | Status                                  |
| -------------------------------------------------------------------------- | --------------------------------------- |
| `apply`, `map`, `for-each`, string/vector map/for-each                     | **impl**                                |
| `call/cc`, `call-with-current-continuation`, `dynamic-wind`                | **door**                                |
| `values`, `call-with-values`, `let-values`, `let*-values`, `define-values` | **door**                                |
| `delay` / `force` / `make-promise` / `delay-force` / `promise?`            | **door**                                |
| `make-parameter` / `parameterize`                                          | **door**                                |
| `case-lambda`                                                              | **door** (not-yet; use lambda + guards) |
| `set!`                                                                     | **door**                                |

### §6.11 Exceptions — done (keep live)

`raise`, `raise-continuable`, `with-exception-handler`, `error`, `guard`, error-object surface — **impl**.

### §6.12 Eval — done (doors)

| Symbol                                                                                    | Status                           | Pack        |
| ----------------------------------------------------------------------------------------- | -------------------------------- | ----------- |
| `eval`                                                                                    | **door** (sandbox + reification) | `r7rs/eval` |
| `environment`, `null-environment`, `scheme-report-environment`, `interaction-environment` | **door** (reification)           | `r7rs/eval` |

### §6.13 / §6.14 Host — done (doors)

Full port/IO/file/system surface doored in `r7rs/host.ts` (single `DOORS` inventory), including `load`.  
Adjacent: `call-with-input-string` in `srfi-stubs` (SRFI-6).

### Library / inclusion / feature-expand — done (doors)

| Symbol                      | Status                           | Pack          |
| --------------------------- | -------------------------------- | ------------- |
| `include` / `include-ci`    | **door** (sandbox)               | `r7rs/syntax` |
| `cond-expand`               | **door** (not-yet)               | `r7rs/syntax` |
| `define-library` / `import` | **door** (reification / sandbox) | `r7rs/syntax` |
| `syntax-error`              | **door** (not-yet)               | `r7rs/syntax` |

Macro-binding aliases stay live: `define-syntax` / `let-syntax` / `letrec-syntax` (**impl** as value-binding aliases).

---

## Remaining out-of-scope / residue

**Out of scope:** `define-record-type` (records / separate SRFI); complex tower accessors (`make-rectangular`, …).

---

## Method notes

- Multi-return **names** and **host minting** are extinguished for the agent-facing surface.
- Chibi exclusions for multi-return / ports / eval / case-lambda cascade remain valid as “design omit”; numeric S2 names should no longer be excluded as “not implemented”.
- Sandbox-unification: R7RS `eval`/`load` are **doors**, not unbound; non-R7RS host verbs (`set-obj!`, …) stay unbound.
