# R7RS-small — Symbol → Chapter/Section Index

> Reference artifact for the `@inhuman.tools/arrival` Scheme interpreter. For every symbol in the
> Revised⁷ Report on the Algorithmic Language Scheme (small language, 2013), this maps **where it is
> normatively introduced** and **where else it is mentioned/explained**, plus **which standard library exports it**.

## Source & method

Primary source: the official LaTeX source of R7RS-small, `johnwcowan/r7rs-spec`, branch `errata`
(the published-with-errata text), directory `spec/` — <https://github.com/johnwcowan/r7rs-spec/tree/errata/spec>.
Canonical PDF for page cross-reference: <https://small.r7rs.org/attachment/r7rs.pdf>.

Column semantics, taken from the report's own index macros: **Introduced at** = the defining index
occurrence (a procedure/syntax entry, or a standalone keyword/lexical-syntax entry) — the
bold/primary entries in the report's printed alphabetic index. **Also-mentioned-at** = every
secondary index occurrence in a different section. **Kind** = the entry's own category (`syntax`,
`auxiliary syntax`, `procedure`, `lexical syntax`, `… library procedure`). **Library** = the export
lists in Appendix A, the authoritative `(scheme …)` → symbol mapping.

Caveats: a few forms (`syntax-rules`, `...`, `unquote`, `unquote-splicing`, and the R5RS aliases
`exact->inexact`/`inexact->exact`) carry no index entry in the source; their "introduced at" was
set by hand and is marked `_(curated)_` below. "Also-mentioned-at" reflects the report's own index
granularity, not every textual appearance — plain prose mentions outside the index are not
counted. Reader/lexical tokens are listed under their glyph (`'`, `` ` ``, `,`, `,@`, `;`);
datum-label notation (`#n=`/`#n#`) is grammar, not a callable symbol, and is omitted. Chapter 7
(Formal syntax and semantics) introduces no new symbols — it is grammar + denotational semantics
over forms defined in ch. 4–6, and appears only in "also-mentioned-at" columns.

## Chapter map

| §   | Title                             | Symbols introduced here                 |
| --- | --------------------------------- | --------------------------------------- |
| 1   | Overview of Scheme                | 0                                       |
| 2   | Lexical conventions               | 1                                       |
| 3   | Basic concepts                    | 0                                       |
| 4   | Expressions                       | 45                                      |
| 5   | Program structure                 | 6                                       |
| 6   | Standard procedures               | 294                                     |
| 7   | Formal syntax and semantics       | 0                                       |
| A   | Standard Libraries (export lists) | — (16 libraries · 339 distinct exports) |
| B   | Standard Feature Identifiers      | 26 feature ids                          |

## Symbols by section

Each table = one section; rows = symbols **introduced** there. Columns: **symbol · kind · also-mentioned-at · exporting library(ies)**.

## 2. Lexical conventions

### 2.2 Whitespace and comments

| Symbol | Kind           | Also mentioned at | Library |
| ------ | -------------- | ----------------- | ------- |
| `;`    | lexical syntax | —                 | —       |

## 4. Expressions

### 4.1.2 Literal expressions

| Symbol  | Kind           | Also mentioned at | Library    |
| ------- | -------------- | ----------------- | ---------- |
| `'`     | lexical syntax | 6.4               | —          |
| `quote` | syntax         | 6.4               | base, r5rs |

### 4.1.4 Procedures

| Symbol   | Kind   | Also mentioned at | Library    |
| -------- | ------ | ----------------- | ---------- |
| `lambda` | syntax | 5.3.2, 7.2.3      | base, r5rs |

### 4.1.5 Conditionals

| Symbol | Kind   | Also mentioned at | Library    |
| ------ | ------ | ----------------- | ---------- |
| `if`   | syntax | 7.2.3             | base, r5rs |

### 4.1.6 Assignments

| Symbol | Kind   | Also mentioned at | Library    |
| ------ | ------ | ----------------- | ---------- |
| `set!` | syntax | 5.3.1, 7.2.3      | base, r5rs |

### 4.1.7 Inclusion

| Symbol       | Kind   | Also mentioned at | Library |
| ------------ | ------ | ----------------- | ------- |
| `include`    | syntax | 5.6.1             | base    |
| `include-ci` | syntax | 5.6.1             | base    |

### 4.2.1 Conditionals

| Symbol        | Kind             | Also mentioned at | Library    |
| ------------- | ---------------- | ----------------- | ---------- |
| `=>`          | auxiliary syntax | —                 | base, r5rs |
| `and`         | syntax           | 7.3               | base, r5rs |
| `case`        | syntax           | 7.3               | base, r5rs |
| `cond`        | syntax           | 4.3.2, 7.3        | base, r5rs |
| `cond-expand` | syntax           | 5.6.1             | base       |
| `else`        | auxiliary syntax | —                 | base, r5rs |
| `or`          | syntax           | 7.3               | base, r5rs |
| `unless`      | syntax           | 7.3               | base       |
| `when`        | syntax           | 7.3               | base       |

### 4.2.2 Binding constructs

| Symbol        | Kind   | Also mentioned at        | Library    |
| ------------- | ------ | ------------------------ | ---------- |
| `let`         | syntax | 4.2.4, 4.3.2, 5.3.2, 7.3 | base, r5rs |
| `let-values`  | syntax | 5.3.2, 7.3               | base       |
| `let*`        | syntax | 5.3.2, 7.3               | base, r5rs |
| `let*-values` | syntax | 5.3.2, 7.3               | base       |
| `letrec`      | syntax | 5.3.2, 7.3               | base, r5rs |
| `letrec*`     | syntax | 5.3.2, 7.3               | base       |

### 4.2.3 Sequencing

| Symbol  | Kind   | Also mentioned at      | Library    |
| ------- | ------ | ---------------------- | ---------- |
| `begin` | syntax | 5.1, 5.3.2, 5.6.1, 7.3 | base, r5rs |

### 4.2.4 Iteration

| Symbol | Kind   | Also mentioned at | Library    |
| ------ | ------ | ----------------- | ---------- |
| `do`   | syntax | 7.3               | base, r5rs |

### 4.2.5 Delayed evaluation

| Symbol         | Kind      | Also mentioned at | Library    |
| -------------- | --------- | ----------------- | ---------- |
| `delay`        | syntax    | —                 | lazy, r5rs |
| `delay-force`  | syntax    | —                 | lazy       |
| `force`        | procedure | —                 | lazy, r5rs |
| `make-promise` | procedure | —                 | lazy       |
| `promise?`     | procedure | —                 | lazy       |

### 4.2.6 Dynamic bindings

| Symbol           | Kind      | Also mentioned at | Library |
| ---------------- | --------- | ----------------- | ------- |
| `make-parameter` | procedure | —                 | base    |
| `parameterize`   | syntax    | 5.3.2             | base    |

### 4.2.7 Exception handling

| Symbol  | Kind   | Also mentioned at | Library |
| ------- | ------ | ----------------- | ------- |
| `guard` | syntax | 5.3.2             | base    |

### 4.2.8 Quasiquotation

| Symbol                         | Kind             | Also mentioned at | Library    |
| ------------------------------ | ---------------- | ----------------- | ---------- |
| `,`                            | lexical syntax   | 6.4               | —          |
| `,@`                           | lexical syntax   | —                 | —          |
| `` ` ``                        | lexical syntax   | —                 | —          |
| `quasiquote`                   | syntax           | 6.4               | base, r5rs |
| `unquote` _(curated)_          | auxiliary syntax | 6.4               | base       |
| `unquote-splicing` _(curated)_ | auxiliary syntax | 6.4               | base       |

### 4.2.9 Case-lambda

| Symbol        | Kind   | Also mentioned at | Library     |
| ------------- | ------ | ----------------- | ----------- |
| `case-lambda` | syntax | 5.3.2, 7.3        | case-lambda |

### 4.3.1 Binding constructs for syntactic keywords

| Symbol          | Kind   | Also mentioned at | Library    |
| --------------- | ------ | ----------------- | ---------- |
| `let-syntax`    | syntax | 5.3.2             | base, r5rs |
| `letrec-syntax` | syntax | 5.3.2             | base, r5rs |

### 4.3.2 Pattern language

| Symbol                     | Kind             | Also mentioned at | Library    |
| -------------------------- | ---------------- | ----------------- | ---------- |
| `_`                        | auxiliary syntax | —                 | base, r5rs |
| `...` _(curated)_          | auxiliary syntax | —                 | base, r5rs |
| `syntax-rules` _(curated)_ | syntax           | 5.4               | base, r5rs |

### 4.3.3 Signaling errors in macro transformers

| Symbol         | Kind   | Also mentioned at | Library |
| -------------- | ------ | ----------------- | ------- |
| `syntax-error` | syntax | —                 | base    |

## 5. Program structure

### 5.2 Import declarations

| Symbol   | Kind   | Also mentioned at | Library |
| -------- | ------ | ----------------- | ------- |
| `import` | syntax | 5.6.1             | —       |

### 5.3 Variable definitions

| Symbol   | Kind   | Also mentioned at | Library    |
| -------- | ------ | ----------------- | ---------- |
| `define` | syntax | —                 | base, r5rs |

### 5.3.3 Multiple-value definitions

| Symbol          | Kind   | Also mentioned at | Library |
| --------------- | ------ | ----------------- | ------- |
| `define-values` | syntax | 7.3               | base    |

### 5.4 Syntax definitions

| Symbol          | Kind   | Also mentioned at | Library    |
| --------------- | ------ | ----------------- | ---------- |
| `define-syntax` | syntax | —                 | base, r5rs |

### 5.5 Record-type definitions

| Symbol               | Kind   | Also mentioned at | Library |
| -------------------- | ------ | ----------------- | ------- |
| `define-record-type` | syntax | —                 | base    |

### 5.6.1 Library Syntax

| Symbol           | Kind   | Also mentioned at | Library |
| ---------------- | ------ | ----------------- | ------- |
| `define-library` | syntax | —                 | —       |

## 6. Standard procedures

### 6.1 Equivalence predicates

| Symbol   | Kind      | Also mentioned at | Library    |
| -------- | --------- | ----------------- | ---------- |
| `eq?`    | procedure | 4.1.4             | base, r5rs |
| `equal?` | procedure | —                 | base, r5rs |
| `eqv?`   | procedure | 3.4, 4.1.4, 7.2.4 | base, r5rs |

### 6.2.6 Numerical operations

| Symbol                       | Kind      | Also mentioned at | Library       |
| ---------------------------- | --------- | ----------------- | ------------- |
| `-`                          | procedure | —                 | base, r5rs    |
| `*`                          | procedure | —                 | base, r5rs    |
| `/`                          | procedure | —                 | base, r5rs    |
| `+`                          | procedure | 7.2.4             | base, r5rs    |
| `<`                          | procedure | 7.2.4             | base, r5rs    |
| `<=`                         | procedure | —                 | base, r5rs    |
| `=`                          | procedure | —                 | base, r5rs    |
| `>`                          | procedure | —                 | base, r5rs    |
| `>=`                         | procedure | —                 | base, r5rs    |
| `abs`                        | procedure | —                 | base, r5rs    |
| `acos`                       | procedure | —                 | inexact, r5rs |
| `angle`                      | procedure | —                 | complex, r5rs |
| `asin`                       | procedure | —                 | inexact, r5rs |
| `atan`                       | procedure | —                 | inexact, r5rs |
| `ceiling`                    | procedure | —                 | base, r5rs    |
| `complex?`                   | procedure | 6.2.1             | base, r5rs    |
| `cos`                        | procedure | —                 | inexact, r5rs |
| `denominator`                | procedure | —                 | base, r5rs    |
| `even?`                      | procedure | —                 | base, r5rs    |
| `exact`                      | procedure | 6.2.2             | base          |
| `exact->inexact` _(curated)_ | procedure | —                 | r5rs          |
| `exact-integer-sqrt`         | procedure | —                 | base          |
| `exact-integer?`             | procedure | —                 | base          |
| `exact?`                     | procedure | —                 | base, r5rs    |
| `exp`                        | procedure | —                 | inexact, r5rs |
| `expt`                       | procedure | —                 | base, r5rs    |
| `finite?`                    | procedure | —                 | inexact       |
| `floor`                      | procedure | —                 | base, r5rs    |
| `floor-quotient`             | procedure | —                 | base          |
| `floor-remainder`            | procedure | —                 | base          |
| `floor/`                     | procedure | —                 | base          |
| `gcd`                        | procedure | —                 | base, r5rs    |
| `imag-part`                  | procedure | —                 | complex, r5rs |
| `inexact`                    | procedure | —                 | base          |
| `inexact->exact` _(curated)_ | procedure | —                 | r5rs          |
| `inexact?`                   | procedure | —                 | base, r5rs    |
| `infinite?`                  | procedure | —                 | inexact       |
| `integer?`                   | procedure | 6.2.1             | base, r5rs    |
| `lcm`                        | procedure | —                 | base, r5rs    |
| `log`                        | procedure | —                 | inexact, r5rs |
| `magnitude`                  | procedure | —                 | complex, r5rs |
| `make-polar`                 | procedure | —                 | complex, r5rs |
| `make-rectangular`           | procedure | —                 | complex, r5rs |
| `max`                        | procedure | —                 | base, r5rs    |
| `min`                        | procedure | —                 | base, r5rs    |
| `modulo`                     | procedure | —                 | base, r5rs    |
| `nan?`                       | procedure | —                 | inexact       |
| `negative?`                  | procedure | —                 | base, r5rs    |
| `number?`                    | procedure | 3.2, 6.2.1        | base, r5rs    |
| `numerator`                  | procedure | —                 | base, r5rs    |
| `odd?`                       | procedure | —                 | base, r5rs    |
| `positive?`                  | procedure | —                 | base, r5rs    |
| `quotient`                   | procedure | —                 | base, r5rs    |
| `rational?`                  | procedure | 6.2.1             | base, r5rs    |
| `rationalize`                | procedure | —                 | base, r5rs    |
| `real-part`                  | procedure | —                 | complex, r5rs |
| `real?`                      | procedure | 6.2.1             | base, r5rs    |
| `remainder`                  | procedure | —                 | base, r5rs    |
| `round`                      | procedure | —                 | base, r5rs    |
| `sin`                        | procedure | —                 | inexact, r5rs |
| `sqrt`                       | procedure | —                 | inexact, r5rs |
| `square`                     | procedure | —                 | base          |
| `tan`                        | procedure | —                 | inexact, r5rs |
| `truncate`                   | procedure | —                 | base, r5rs    |
| `truncate-quotient`          | procedure | —                 | base          |
| `truncate-remainder`         | procedure | —                 | base          |
| `truncate/`                  | procedure | —                 | base          |
| `zero?`                      | procedure | —                 | base, r5rs    |

### 6.2.7 Numerical input and output

| Symbol           | Kind      | Also mentioned at | Library    |
| ---------------- | --------- | ----------------- | ---------- |
| `number->string` | procedure | —                 | base, r5rs |
| `string->number` | procedure | —                 | base, r5rs |

### 6.3 Booleans

| Symbol      | Kind      | Also mentioned at | Library    |
| ----------- | --------- | ----------------- | ---------- |
| `boolean?`  | procedure | 3.2               | base, r5rs |
| `boolean=?` | procedure | —                 | base       |
| `not`       | procedure | —                 | base, r5rs |

### 6.4 Pairs and lists

| Symbol      | Kind      | Also mentioned at | Library    |
| ----------- | --------- | ----------------- | ---------- |
| `append`    | procedure | —                 | base, r5rs |
| `assoc`     | procedure | —                 | base, r5rs |
| `assq`      | procedure | —                 | base, r5rs |
| `assv`      | procedure | —                 | base, r5rs |
| `caaaar`    | procedure | —                 | cxr, r5rs  |
| `caaadr`    | procedure | —                 | cxr, r5rs  |
| `caaar`     | procedure | —                 | cxr, r5rs  |
| `caadar`    | procedure | —                 | cxr, r5rs  |
| `caaddr`    | procedure | —                 | cxr, r5rs  |
| `caadr`     | procedure | —                 | cxr, r5rs  |
| `caar`      | procedure | —                 | base, r5rs |
| `cadaar`    | procedure | —                 | cxr, r5rs  |
| `cadadr`    | procedure | —                 | cxr, r5rs  |
| `cadar`     | procedure | —                 | cxr, r5rs  |
| `caddar`    | procedure | —                 | cxr, r5rs  |
| `cadddr`    | procedure | —                 | cxr, r5rs  |
| `caddr`     | procedure | —                 | cxr, r5rs  |
| `cadr`      | procedure | —                 | base, r5rs |
| `car`       | procedure | 7.2.4             | base, r5rs |
| `cdaaar`    | procedure | —                 | cxr, r5rs  |
| `cdaadr`    | procedure | —                 | cxr, r5rs  |
| `cdaar`     | procedure | —                 | cxr, r5rs  |
| `cdadar`    | procedure | —                 | cxr, r5rs  |
| `cdaddr`    | procedure | —                 | cxr, r5rs  |
| `cdadr`     | procedure | —                 | cxr, r5rs  |
| `cdar`      | procedure | —                 | base, r5rs |
| `cddaar`    | procedure | —                 | cxr, r5rs  |
| `cddadr`    | procedure | —                 | cxr, r5rs  |
| `cddar`     | procedure | —                 | cxr, r5rs  |
| `cdddar`    | procedure | —                 | cxr, r5rs  |
| `cddddr`    | procedure | —                 | cxr, r5rs  |
| `cdddr`     | procedure | —                 | cxr, r5rs  |
| `cddr`      | procedure | —                 | base, r5rs |
| `cdr`       | procedure | —                 | base, r5rs |
| `cons`      | procedure | —                 | base, r5rs |
| `length`    | procedure | 6.2.3             | base, r5rs |
| `list`      | procedure | —                 | base, r5rs |
| `list-copy` | procedure | —                 | base       |
| `list-ref`  | procedure | —                 | base, r5rs |
| `list-set!` | procedure | —                 | base       |
| `list-tail` | procedure | —                 | base, r5rs |
| `list?`     | procedure | —                 | base, r5rs |
| `make-list` | procedure | —                 | base       |
| `member`    | procedure | —                 | base, r5rs |
| `memq`      | procedure | —                 | base, r5rs |
| `memv`      | procedure | —                 | base, r5rs |
| `null?`     | procedure | —                 | base, r5rs |
| `pair?`     | procedure | 3.2               | base, r5rs |
| `reverse`   | procedure | —                 | base, r5rs |
| `set-car!`  | procedure | —                 | base, r5rs |
| `set-cdr!`  | procedure | —                 | base, r5rs |

### 6.5 Symbols

| Symbol           | Kind      | Also mentioned at | Library    |
| ---------------- | --------- | ----------------- | ---------- |
| `string->symbol` | procedure | —                 | base, r5rs |
| `symbol->string` | procedure | 3.4               | base, r5rs |
| `symbol?`        | procedure | 3.2               | base, r5rs |
| `symbol=?`       | procedure | —                 | base       |

### 6.6 Characters

| Symbol             | Kind      | Also mentioned at | Library    |
| ------------------ | --------- | ----------------- | ---------- |
| `char->integer`    | procedure | —                 | base, r5rs |
| `char-alphabetic?` | procedure | —                 | char, r5rs |
| `char-ci<?`        | procedure | —                 | char, r5rs |
| `char-ci<=?`       | procedure | —                 | char, r5rs |
| `char-ci=?`        | procedure | —                 | char, r5rs |
| `char-ci>?`        | procedure | —                 | char, r5rs |
| `char-ci>=?`       | procedure | —                 | char, r5rs |
| `char-downcase`    | procedure | —                 | char, r5rs |
| `char-foldcase`    | procedure | —                 | char       |
| `char-lower-case?` | procedure | —                 | char, r5rs |
| `char-numeric?`    | procedure | —                 | char, r5rs |
| `char-upcase`      | procedure | —                 | char, r5rs |
| `char-upper-case?` | procedure | —                 | char, r5rs |
| `char-whitespace?` | procedure | —                 | char, r5rs |
| `char?`            | procedure | 3.2               | base, r5rs |
| `char<?`           | procedure | —                 | base, r5rs |
| `char<=?`          | procedure | —                 | base, r5rs |
| `char=?`           | procedure | —                 | base, r5rs |
| `char>?`           | procedure | —                 | base, r5rs |
| `char>=?`          | procedure | —                 | base, r5rs |
| `digit-value`      | procedure | —                 | char       |
| `integer->char`    | procedure | —                 | base, r5rs |

### 6.7 Strings

| Symbol            | Kind      | Also mentioned at | Library    |
| ----------------- | --------- | ----------------- | ---------- |
| `list->string`    | procedure | —                 | base, r5rs |
| `make-string`     | procedure | —                 | base, r5rs |
| `string`          | procedure | —                 | base, r5rs |
| `string->list`    | procedure | —                 | base, r5rs |
| `string-append`   | procedure | —                 | base, r5rs |
| `string-ci<?`     | procedure | —                 | char, r5rs |
| `string-ci<=?`    | procedure | —                 | char, r5rs |
| `string-ci=?`     | procedure | —                 | char, r5rs |
| `string-ci>?`     | procedure | —                 | char, r5rs |
| `string-ci>=?`    | procedure | —                 | char, r5rs |
| `string-copy`     | procedure | —                 | base, r5rs |
| `string-copy!`    | procedure | —                 | base       |
| `string-downcase` | procedure | —                 | char       |
| `string-fill!`    | procedure | —                 | base, r5rs |
| `string-foldcase` | procedure | —                 | char       |
| `string-length`   | procedure | 6.2.3             | base, r5rs |
| `string-ref`      | procedure | —                 | base, r5rs |
| `string-set!`     | procedure | 6.5               | base, r5rs |
| `string-upcase`   | procedure | —                 | char       |
| `string?`         | procedure | 3.2               | base, r5rs |
| `string<?`        | procedure | —                 | base, r5rs |
| `string<=?`       | procedure | —                 | base, r5rs |
| `string=?`        | procedure | —                 | base, r5rs |
| `string>?`        | procedure | —                 | base, r5rs |
| `string>=?`       | procedure | —                 | base, r5rs |
| `substring`       | procedure | —                 | base, r5rs |

### 6.8 Vectors

| Symbol           | Kind      | Also mentioned at | Library    |
| ---------------- | --------- | ----------------- | ---------- |
| `list->vector`   | procedure | —                 | base, r5rs |
| `make-vector`    | procedure | —                 | base, r5rs |
| `string->vector` | procedure | —                 | base       |
| `vector`         | procedure | —                 | base, r5rs |
| `vector->list`   | procedure | —                 | base, r5rs |
| `vector->string` | procedure | —                 | base       |
| `vector-append`  | procedure | —                 | base       |
| `vector-copy`    | procedure | —                 | base       |
| `vector-copy!`   | procedure | —                 | base       |
| `vector-fill!`   | procedure | —                 | base, r5rs |
| `vector-length`  | procedure | 6.2.3             | base, r5rs |
| `vector-ref`     | procedure | —                 | base, r5rs |
| `vector-set!`    | procedure | —                 | base, r5rs |
| `vector?`        | procedure | 3.2               | base, r5rs |

### 6.9 Bytevectors

| Symbol               | Kind      | Also mentioned at | Library |
| -------------------- | --------- | ----------------- | ------- |
| `bytevector`         | procedure | —                 | base    |
| `bytevector-append`  | procedure | —                 | base    |
| `bytevector-copy`    | procedure | —                 | base    |
| `bytevector-copy!`   | procedure | —                 | base    |
| `bytevector-length`  | procedure | 6.2.3             | base    |
| `bytevector-u8-ref`  | procedure | —                 | base    |
| `bytevector-u8-set!` | procedure | —                 | base    |
| `bytevector?`        | procedure | 3.2               | base    |
| `make-bytevector`    | procedure | —                 | base    |
| `string->utf8`       | procedure | —                 | base    |
| `utf8->string`       | procedure | —                 | base    |

### 6.10 Control features

| Symbol                           | Kind      | Also mentioned at | Library    |
| -------------------------------- | --------- | ----------------- | ---------- |
| `apply`                          | procedure | 3.5, 7.2.4        | base, r5rs |
| `call-with-current-continuation` | procedure | 3.5, 7.2.4        | base, r5rs |
| `call-with-values`               | procedure | 3.5, 7.2.4        | base, r5rs |
| `call/cc`                        | procedure | —                 | base       |
| `dynamic-wind`                   | procedure | —                 | base, r5rs |
| `for-each`                       | procedure | —                 | base, r5rs |
| `map`                            | procedure | —                 | base, r5rs |
| `procedure?`                     | procedure | 3.2               | base, r5rs |
| `string-for-each`                | procedure | —                 | base       |
| `string-map`                     | procedure | —                 | base       |
| `values`                         | procedure | 4.1.3             | base, r5rs |
| `vector-for-each`                | procedure | —                 | base       |
| `vector-map`                     | procedure | —                 | base       |

### 6.11 Exceptions

| Symbol                   | Kind      | Also mentioned at | Library |
| ------------------------ | --------- | ----------------- | ------- |
| `error`                  | procedure | —                 | base    |
| `error-object-irritants` | procedure | —                 | base    |
| `error-object-message`   | procedure | —                 | base    |
| `error-object?`          | procedure | —                 | base    |
| `file-error?`            | procedure | —                 | base    |
| `raise`                  | procedure | 4.2.7             | base    |
| `raise-continuable`      | procedure | —                 | base    |
| `read-error?`            | procedure | —                 | base    |
| `with-exception-handler` | procedure | —                 | base    |

### 6.12 Environments and evaluation

| Symbol                      | Kind      | Also mentioned at | Library    |
| --------------------------- | --------- | ----------------- | ---------- |
| `environment`               | procedure | —                 | eval       |
| `eval`                      | procedure | 3.5               | eval, r5rs |
| `interaction-environment`   | procedure | —                 | repl, r5rs |
| `null-environment`          | procedure | —                 | r5rs       |
| `scheme-report-environment` | procedure | —                 | r5rs       |

### 6.13.1 Ports

| Symbol                    | Kind      | Also mentioned at | Library    |
| ------------------------- | --------- | ----------------- | ---------- |
| `binary-port?`            | procedure | —                 | base       |
| `call-with-input-file`    | procedure | —                 | file, r5rs |
| `call-with-output-file`   | procedure | —                 | file, r5rs |
| `call-with-port`          | procedure | —                 | base       |
| `close-input-port`        | procedure | —                 | base, r5rs |
| `close-output-port`       | procedure | —                 | base, r5rs |
| `close-port`              | procedure | —                 | base       |
| `current-error-port`      | procedure | —                 | base       |
| `current-input-port`      | procedure | —                 | base, r5rs |
| `current-output-port`     | procedure | —                 | base, r5rs |
| `get-output-bytevector`   | procedure | —                 | base       |
| `get-output-string`       | procedure | —                 | base       |
| `input-port-open?`        | procedure | —                 | base       |
| `input-port?`             | procedure | —                 | base, r5rs |
| `open-binary-input-file`  | procedure | —                 | file       |
| `open-binary-output-file` | procedure | —                 | file       |
| `open-input-bytevector`   | procedure | —                 | base       |
| `open-input-file`         | procedure | —                 | file, r5rs |
| `open-input-string`       | procedure | —                 | base       |
| `open-output-bytevector`  | procedure | —                 | base       |
| `open-output-file`        | procedure | —                 | file, r5rs |
| `open-output-string`      | procedure | —                 | base       |
| `output-port-open?`       | procedure | —                 | base       |
| `output-port?`            | procedure | —                 | base, r5rs |
| `port?`                   | procedure | 3.2               | base       |
| `textual-port?`           | procedure | —                 | base       |
| `with-input-from-file`    | procedure | —                 | file, r5rs |
| `with-output-to-file`     | procedure | —                 | file, r5rs |

### 6.13.2 Input

| Symbol             | Kind      | Also mentioned at | Library    |
| ------------------ | --------- | ----------------- | ---------- |
| `char-ready?`      | procedure | —                 | base, r5rs |
| `eof-object`       | procedure | —                 | base       |
| `eof-object?`      | procedure | 3.2               | base, r5rs |
| `peek-char`        | procedure | —                 | base, r5rs |
| `peek-u8`          | procedure | —                 | base       |
| `read`             | procedure | 6.4, 7.1.2        | read, r5rs |
| `read-bytevector`  | procedure | —                 | base       |
| `read-bytevector!` | procedure | —                 | base       |
| `read-char`        | procedure | —                 | base, r5rs |
| `read-line`        | procedure | —                 | base       |
| `read-string`      | procedure | —                 | base       |
| `read-u8`          | procedure | —                 | base       |
| `u8-ready?`        | procedure | —                 | base       |

### 6.13.3 Output

| Symbol              | Kind      | Also mentioned at | Library     |
| ------------------- | --------- | ----------------- | ----------- |
| `display`           | procedure | —                 | write, r5rs |
| `flush-output-port` | procedure | —                 | base        |
| `newline`           | procedure | —                 | base, r5rs  |
| `write`             | procedure | 4.2.8             | write, r5rs |
| `write-bytevector`  | procedure | —                 | base        |
| `write-char`        | procedure | —                 | base, r5rs  |
| `write-shared`      | procedure | —                 | write       |
| `write-simple`      | procedure | —                 | write       |
| `write-string`      | procedure | —                 | base        |
| `write-u8`          | procedure | —                 | base        |

### 6.14 System interface

| Symbol                      | Kind      | Also mentioned at | Library         |
| --------------------------- | --------- | ----------------- | --------------- |
| `command-line`              | procedure | —                 | process-context |
| `current-jiffy`             | procedure | —                 | time            |
| `current-second`            | procedure | —                 | time            |
| `delete-file`               | procedure | —                 | file            |
| `emergency-exit`            | procedure | —                 | process-context |
| `exit`                      | procedure | —                 | process-context |
| `features`                  | procedure | —                 | base            |
| `file-exists?`              | procedure | —                 | file            |
| `get-environment-variable`  | procedure | —                 | process-context |
| `get-environment-variables` | procedure | —                 | process-context |
| `jiffies-per-second`        | procedure | —                 | time            |
| `load`                      | procedure | —                 | load, r5rs      |

## Chapter 7 — primitive vs derived (no new symbols)

§7 defines the formal grammar and denotational semantics. Relevant for an interpreter:

- **Primitive (core) expression types** — §4.1, the irreducible forms the semantics is given over: `quote` (`'`), `lambda`, `if`, `set!`, procedure call, variable reference, `include`. Definitions (`define`, `define-syntax`, `define-values`, `define-record-type`) and `let-syntax`/`letrec-syntax`/`syntax-rules` round out the core.
- **Derived expression types** — §4.2 and §7.3 give macro expansions (to the primitives above) for forms such as: `and`, `begin`, `case`, `case-lambda`, `cond`, `define-values`, `do`, `let`, `let*`, `let*-values`, `let-values`, `letrec`, `letrec*`, `or`, `unless`, `when` (and `delay`/`delay-force`/`make-promise`, `parameterize`, `guard`, `quasiquote`, named `let`, shown by expansion in §7.3 but not separately index-tagged).

## Appendix A — standard library exports

The authoritative `(scheme …)` → symbol map (from `stdmod.tex`). Counts in parentheses.

### `(scheme base)` (238)

`*` · `+` · `-` · `...` · `/` · `<` · `<=` · `=` · `=>` · `>` · `>=` · `_` · `abs` · `and` · `append` · `apply` · `assoc` · `assq` · `assv` · `begin` · `binary-port?` · `boolean=?` · `boolean?` · `bytevector` · `bytevector-append` · `bytevector-copy` · `bytevector-copy!` · `bytevector-length` · `bytevector-u8-ref` · `bytevector-u8-set!` · `bytevector?` · `caar` · `cadr` · `call-with-current-continuation` · `call-with-port` · `call-with-values` · `call/cc` · `car` · `case` · `cdar` · `cddr` · `cdr` · `ceiling` · `char->integer` · `char-ready?` · `char<=?` · `char<?` · `char=?` · `char>=?` · `char>?` · `char?` · `close-input-port` · `close-output-port` · `close-port` · `complex?` · `cond` · `cond-expand` · `cons` · `current-error-port` · `current-input-port` · `current-output-port` · `define` · `define-record-type` · `define-syntax` · `define-values` · `denominator` · `do` · `dynamic-wind` · `else` · `eof-object` · `eof-object?` · `eq?` · `equal?` · `eqv?` · `error` · `error-object-irritants` · `error-object-message` · `error-object?` · `even?` · `exact` · `exact-integer-sqrt` · `exact-integer?` · `exact?` · `expt` · `features` · `file-error?` · `floor` · `floor-quotient` · `floor-remainder` · `floor/` · `flush-output-port` · `for-each` · `gcd` · `get-output-bytevector` · `get-output-string` · `guard` · `if` · `include` · `include-ci` · `inexact` · `inexact?` · `input-port-open?` · `input-port?` · `integer->char` · `integer?` · `lambda` · `lcm` · `length` · `let` · `let*` · `let*-values` · `let-syntax` · `let-values` · `letrec` · `letrec*` · `letrec-syntax` · `list` · `list->string` · `list->vector` · `list-copy` · `list-ref` · `list-set!` · `list-tail` · `list?` · `make-bytevector` · `make-list` · `make-parameter` · `make-string` · `make-vector` · `map` · `max` · `member` · `memq` · `memv` · `min` · `modulo` · `negative?` · `newline` · `not` · `null?` · `number->string` · `number?` · `numerator` · `odd?` · `open-input-bytevector` · `open-input-string` · `open-output-bytevector` · `open-output-string` · `or` · `output-port-open?` · `output-port?` · `pair?` · `parameterize` · `peek-char` · `peek-u8` · `port?` · `positive?` · `procedure?` · `quasiquote` · `quote` · `quotient` · `raise` · `raise-continuable` · `rational?` · `rationalize` · `read-bytevector` · `read-bytevector!` · `read-char` · `read-error?` · `read-line` · `read-string` · `read-u8` · `real?` · `remainder` · `reverse` · `round` · `set!` · `set-car!` · `set-cdr!` · `square` · `string` · `string->list` · `string->number` · `string->symbol` · `string->utf8` · `string->vector` · `string-append` · `string-copy` · `string-copy!` · `string-fill!` · `string-for-each` · `string-length` · `string-map` · `string-ref` · `string-set!` · `string<=?` · `string<?` · `string=?` · `string>=?` · `string>?` · `string?` · `substring` · `symbol->string` · `symbol=?` · `symbol?` · `syntax-error` · `syntax-rules` · `textual-port?` · `truncate` · `truncate-quotient` · `truncate-remainder` · `truncate/` · `u8-ready?` · `unless` · `unquote` · `unquote-splicing` · `utf8->string` · `values` · `vector` · `vector->list` · `vector->string` · `vector-append` · `vector-copy` · `vector-copy!` · `vector-fill!` · `vector-for-each` · `vector-length` · `vector-map` · `vector-ref` · `vector-set!` · `vector?` · `when` · `with-exception-handler` · `write-bytevector` · `write-char` · `write-string` · `write-u8` · `zero?`

### `(scheme case-lambda)` (1)

`case-lambda`

### `(scheme char)` (22)

`char-alphabetic?` · `char-ci<=?` · `char-ci<?` · `char-ci=?` · `char-ci>=?` · `char-ci>?` · `char-downcase` · `char-foldcase` · `char-lower-case?` · `char-numeric?` · `char-upcase` · `char-upper-case?` · `char-whitespace?` · `digit-value` · `string-ci<=?` · `string-ci<?` · `string-ci=?` · `string-ci>=?` · `string-ci>?` · `string-downcase` · `string-foldcase` · `string-upcase`

### `(scheme complex)` (6)

`angle` · `imag-part` · `magnitude` · `make-polar` · `make-rectangular` · `real-part`

### `(scheme cxr)` (24)

`caaaar` · `caaadr` · `caaar` · `caadar` · `caaddr` · `caadr` · `cadaar` · `cadadr` · `cadar` · `caddar` · `cadddr` · `caddr` · `cdaaar` · `cdaadr` · `cdaar` · `cdadar` · `cdaddr` · `cdadr` · `cddaar` · `cddadr` · `cddar` · `cdddar` · `cddddr` · `cdddr`

### `(scheme eval)` (2)

`environment` · `eval`

### `(scheme file)` (10)

`call-with-input-file` · `call-with-output-file` · `delete-file` · `file-exists?` · `open-binary-input-file` · `open-binary-output-file` · `open-input-file` · `open-output-file` · `with-input-from-file` · `with-output-to-file`

### `(scheme inexact)` (12)

`acos` · `asin` · `atan` · `cos` · `exp` · `finite?` · `infinite?` · `log` · `nan?` · `sin` · `sqrt` · `tan`

### `(scheme lazy)` (5)

`delay` · `delay-force` · `force` · `make-promise` · `promise?`

### `(scheme load)` (1)

`load`

### `(scheme process-context)` (5)

`command-line` · `emergency-exit` · `exit` · `get-environment-variable` · `get-environment-variables`

### `(scheme read)` (1)

`read`

### `(scheme repl)` (1)

`interaction-environment`

### `(scheme time)` (3)

`current-jiffy` · `current-second` · `jiffies-per-second`

### `(scheme write)` (4)

`display` · `write` · `write-shared` · `write-simple`

### `(scheme r5rs)` (222)

`*` · `+` · `-` · `...` · `/` · `<` · `<=` · `=` · `=>` · `>` · `>=` · `_` · `abs` · `acos` · `and` · `angle` · `append` · `apply` · `asin` · `assoc` · `assq` · `assv` · `atan` · `begin` · `boolean?` · `caaaar` · `caaadr` · `caaar` · `caadar` · `caaddr` · `caadr` · `caar` · `cadaar` · `cadadr` · `cadar` · `caddar` · `cadddr` · `caddr` · `cadr` · `call-with-current-continuation` · `call-with-input-file` · `call-with-output-file` · `call-with-values` · `car` · `case` · `cdaaar` · `cdaadr` · `cdaar` · `cdadar` · `cdaddr` · `cdadr` · `cdar` · `cddaar` · `cddadr` · `cddar` · `cdddar` · `cddddr` · `cdddr` · `cddr` · `cdr` · `ceiling` · `char->integer` · `char-alphabetic?` · `char-ci<=?` · `char-ci<?` · `char-ci=?` · `char-ci>=?` · `char-ci>?` · `char-downcase` · `char-lower-case?` · `char-numeric?` · `char-ready?` · `char-upcase` · `char-upper-case?` · `char-whitespace?` · `char<=?` · `char<?` · `char=?` · `char>=?` · `char>?` · `char?` · `close-input-port` · `close-output-port` · `complex?` · `cond` · `cons` · `cos` · `current-input-port` · `current-output-port` · `define` · `define-syntax` · `delay` · `denominator` · `display` · `do` · `dynamic-wind` · `else` · `eof-object?` · `eq?` · `equal?` · `eqv?` · `eval` · `even?` · `exact->inexact` · `exact?` · `exp` · `expt` · `floor` · `for-each` · `force` · `gcd` · `if` · `imag-part` · `inexact->exact` · `inexact?` · `input-port?` · `integer->char` · `integer?` · `interaction-environment` · `lambda` · `lcm` · `length` · `let` · `let*` · `let-syntax` · `letrec` · `letrec-syntax` · `list` · `list->string` · `list->vector` · `list-ref` · `list-tail` · `list?` · `load` · `log` · `magnitude` · `make-polar` · `make-rectangular` · `make-string` · `make-vector` · `map` · `max` · `member` · `memq` · `memv` · `min` · `modulo` · `negative?` · `newline` · `not` · `null-environment` · `null?` · `number->string` · `number?` · `numerator` · `odd?` · `open-input-file` · `open-output-file` · `or` · `output-port?` · `pair?` · `peek-char` · `positive?` · `procedure?` · `quasiquote` · `quote` · `quotient` · `rational?` · `rationalize` · `read` · `read-char` · `real-part` · `real?` · `remainder` · `reverse` · `round` · `scheme-report-environment` · `set!` · `set-car!` · `set-cdr!` · `sin` · `sqrt` · `string` · `string->list` · `string->number` · `string->symbol` · `string-append` · `string-ci<=?` · `string-ci<?` · `string-ci=?` · `string-ci>=?` · `string-ci>?` · `string-copy` · `string-fill!` · `string-length` · `string-ref` · `string-set!` · `string<=?` · `string<?` · `string=?` · `string>=?` · `string>?` · `string?` · `substring` · `symbol->string` · `symbol?` · `syntax-rules` · `tan` · `truncate` · `values` · `vector` · `vector->list` · `vector-fill!` · `vector-length` · `vector-ref` · `vector-set!` · `vector?` · `with-input-from-file` · `with-output-to-file` · `write` · `write-char` · `zero?`

## Appendix B — standard feature identifiers

For `cond-expand` / `features` (from `features.tex`): `r7rs`, `exact-closed`, `exact-complex`, `ieee-float`, `full-unicode`, `ratios`, `posix`, `windows`, `unix`, `darwin`, `gnu-linux`, `bsd`, `freebsd`, `solaris`, `i386`, `x86-64`, `ppc`, `sparc`, `jvm`, `clr`, `llvm`, `ilp32`, `lp64`, `ilp64`, `big-endian`, `little-endian`.

Plus open-ended OS/CPU/endianness flags and the implementation name/version (e.g. `unix`, `darwin`, `x86-64`, `big-endian`, `<name>`, `<name-version>`).

## Cross-check & completeness

- **346** distinct symbols have a normative definition site (procedures, syntax, auxiliary/lexical syntax, reader glyphs), across **41** sections.
- **16** standard libraries; `(scheme base)` exports 238, `(scheme r5rs)` re-exports 222.
- Every library-listed symbol has a body entry (accounted for by the curation above).
- `let` is the only symbol with more than one defining section (4.2.2, 4.2.4).
