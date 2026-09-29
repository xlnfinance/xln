# Polyglot grammar specs — executable index

These `*.spec.ts` / `*.test.ts` files pin arrival's non-standard reader/eval grammar. **The
model — what each superset IS and why — lives in `docs/grammar.md`.** This file is the index:
which spec pins which section, plus the runner conventions the tables follow.

## Which spec pins which section

| spec file                             | grammar.md section                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `curly-braces.spec.ts`                | §LITERALS (`{…}` dicts), §COMMA, §SUFFIX-FLIP, §INFIX                         |
| `vector-bracket.spec.ts`              | §LITERALS (`[…]` vectors), §COMMA                                             |
| `vector-hash.spec.ts`                 | §LITERALS (`#(…)` constant vs `[…]` literal — the `evalElements` distinction) |
| `macro-special-brackets.spec.ts`      | §BINDINGS (well-formed let-family bracket bindings)                           |
| `let-bracket-binding-door.test.ts`    | §BINDINGS (malformed-shape doors, BG4)                                        |
| `cond-case-do-bracket-clause.test.ts` | §CLAUSES                                                                      |
| `member-accessor.spec.ts`             | §MEMBER-ACCESS                                                                |
| `reader-baseline.spec.ts`             | §COMMA (position-scoping — specials outside `[…]`/`{…}` retain base meaning)  |

Error codes asserted in these tables (`E-DICT-INFIX-BANNED`, `E-LET-BRACKET-*`, …) are the
door taxonomy of `docs/grammar.md §ERRORS`; each spec hard-codes the code it expects, so the
canonical meaning of every code is the grammar.md table.

## Runner conventions (`_harness.ts`)

The three helpers reproduce the retired JSONL corpus runner's conventions so the inline
`it.each` tables stay uniform:

- **`readAst(input)`** — parse, return the canonical AST string of the last datum. Lists print
  `(a b c)`, dotted tails `(a . b)`; quote-family macros print expanded (`(quote x)`,
  `(unquote x)`, …). A `[…]` literal prints `[form …]`, an R7RS `#(…)` constant prints
  `#(form …)`, a `{…}` literal prints `{form …}` (flat key/value sequence, post
  comma-absorption). Strings print JSON-quoted, booleans `#t`/`#f`, nil `()`; numbers and
  symbols bare. Rendering is recursive (not each node's own print protocol) so the AST face,
  not the value face, is what's asserted.
- **`evalJson(input)`** — eval, fold the last result to JSON: numbers → numbers, strings →
  strings, booleans → booleans, nil/absent → `null`, vectors → arrays, dicts → objects
  (string keys, values folded), symbols → `{"$sym": "<name>"}`.
- **`errorClass(e)`** — the stable `.code` of a thrown error, or the nearest one up the cause
  chain (eval wraps parse/throw sites in `ArrivalError` layers). Specs match ONLY the class;
  messages stay free to teach. A code-less door (the `:key` non-dict path) is asserted via the
  any-error convention (`errorClass` returns `undefined`).
