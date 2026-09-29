# Sugarcoat — formal grammar

Normative surface grammar of the Sugarcoat face. The reader of record is
[`src/sugarcoat-read.ts`](./src/sugarcoat-read.ts); this document states what it accepts, precisely
enough to derive an editor grammar (TextMate, tree-sitter, CodeMirror mode) without reading the
implementation. Where the two disagree, the reader wins and this file has a bug.

A ready-made TextMate derivation ships next to this file:
[`editors/sugarcoat.tmLanguage.json`](./editors/sugarcoat.tmLanguage.json). The full-fidelity
reference integration (highlighting + LSP over the lens) is `@inhuman.tools/arrival-codemirror`.

**Notation** — PEG-style: `←` defines, `/` is _ordered_ choice, `*`/`+`/`?` repeat, terminals are
quoted, `[…]` is a character class. Lexing is maximal-munch. Grammar is three stacked passes, each
consuming the previous one's output:

```
text ──(1. layout)──▶ logical-line tree ──(2. tokens)──▶ token stream ──(3. forms)──▶ s-expressions
```

---

## 1. Layout (I-expressions)

Sugarcoat is indentation-structured. Layout runs _before_ tokenization, on physical lines:

```
Program      ← LogicalLine*
LogicalLine  ← physical line + continuation lines        ; see coalescing
```

1. **Comment / blank stripping.** A line whose first non-space character is `;` is trivia
   (attached to the next form as `lead`); blank lines end nothing and start nothing.
2. **Bracket-balance coalescing.** A physical line with unbalanced `(` `{` `[` (or an open
   at-expression body, §5) absorbs following physical lines until balanced — bracket balance beats
   layout. Inside code context the joined boundary is whitespace; inside an at-expression body the
   newline is literal content.
3. **The offside rule.** After coalescing, a logical line's _indent_ is its count of leading
   spaces. A line plus all following lines with strictly greater indent form one group:

```
Group  ← Line⟨i⟩ Line⟨>i⟩*         ; children = the maximal run of deeper lines
```

4. **Group → form.**
   - Line with no children, one datum → that datum.
   - Line with children (or several datums) → a list: line's datums followed by each child
     group's forms. `define (f x)` ⏎ `{x + 1}` ⇒ `(define (f x) (+ x 1))`.
   - **StepLine exception**: a child line whose first token is a method-DOT is not an argument —
     it is a postfix step folded onto the parent line's value (§4, method chains).
   - **Let-family regroup**: after grouping, `(let|let*|letrec|letrec*)` whose leading children
     are binding-shaped pairs re-collects them into the canonical bindings list (the render
     elides the `(( ))`; the reader restores it).

Indentation is _view-only_: it never reaches the canonical form and is regenerated on render.

## 2. Lexical grammar

Token kinds (the reader's `Tok`): `(` `)` `{` `}` `[` `]` · method-`.` · quote prefix · word ·
at-expression.

```
Token      ← Bracket / AtExpr / Quote / String / Word
Bracket    ← '(' / ')' / '{' / '}' / '[' / ']'          ; each records TIGHT (see below)
Quote      ← "'" / '`' / ',@' / ','
String     ← '"' (escape / [^"])* '"'                    ; R7RS string syntax
Word       ← wchar+                                      ; wchar = not whitespace, not delimiter
delimiters :  ( ) { } [ ] " ;  and whitespace
Comment    ← ';' …end-of-line                            ; trivia, carried as lead/trail
```

**TIGHT.** Every bracket records whether whitespace separated it from the preceding token.
Load-bearing for capture: `xs.map{…}` (tight `{` = trailing lambda of `.map`) vs `xs.map {…}`
(loose `{` = sibling operand). Same for `(` after a method word (`fold(knil)`).

**Method-dot split.** Each Word is rewritten once: split at every `.` that is
(a) not word-initial, (b) single (next char is not `.` — `..`/`...` stay whole), and
(c) followed by ident-start `[A-Za-z!$%&*/:<=>?^_~]`, not a digit.
`xs.map` ⇒ `Word(xs) DOT Word(map)`; `0.5`, `.5`, `x.5`, `(a . b)`, `(x ...)` untouched.
`\.` is a literal dot in a symbol (unescaped in the word, re-escaped on render).

**At-marker.** `@` starts an at-expression **only** as `@word{` / `@{` / `@(` (tight). Bare `@foo`
is a plain symbol; `(@ x k)` is the dynamic accessor; `,@` is lexed off `,` first.

**Keywords.** `:name` (prefix) is the canonical keyword. `name:` (suffix, line- or arg-leading)
is the kwarg spelling — see §6.

## 3. Surface forms

`List`, `Quote`, `String`, `Word` datums are R7RS §7.1.2, unchanged. Non-R7RS productions:

```
Form           ← ColonPair / Expr
ColonPair      ← KWSUFFIX Expr                    ; leading `name:` — kwarg pair (§6)
Expr           ← Postfix
Postfix        ← Primary Step*                    ; steps bind tighter than infix & application
Step           ← Subscript / Method
Subscript      ← '[' Index ']'                    ; NOT tight-gated (x[0] ≡ x [0])
Method         ← DOT Word Args? TrailingLambda?
Args           ← TIGHT '(' Expr* ')'              ; extra positionals: fold(knil)
TrailingLambda ← TIGHT '{' (ArrowLambda / Form) '}'
Primary        ← List / Quote / Curly / AtExpr / String / Word
Curly          ← '{' Infix⟨0⟩ '}'
StepLine       ← INDENT DOT Word Args? TrailingLambda?   ; child line starting with DOT (§1.4)
```

**Method lowering — receiver-last fold.** `recv.op(a₁ … aₖ){Λ}` ⇒ `(op Λ a₁ … aₖ recv)` — the
receiver seats in the _last_ argument slot; a trailing lambda seats first. Chains fold left:
`x.f.g` ⇒ `(g (f x))`. StepLines produce the identical CST — layout only.

**Render gate.** Read is unconditional; render emits a dot/subscript chain iff it peels **≥ 2
steps**, or the single step is an accessor, key, or braced method. A lone bare unary `(op recv)`
stays prefix — `(not p)` is never `p.not`, but `x.f.g` and `xs.map{…}` both surface.

**Index classification** (inside `Subscript`):

```
Index  ← INT           ; x[0] → (car x), x[1] → (cadr x) … pull-k accessor
       / INT ':'       ; x[1:] → (cdr x) … drop-k accessor (k ≥ 1)
       / ':' wchar+    ; x[:k] → (:k x) — static keyword read
       / String / Word ; x[k], x["k"] → (@ x k) — dynamic key
```

The `c[ad]+r` family is the accessor codec (`decodeAccessor`/`encodeAccessor`): any composition
of pulls and drops round-trips to the fused canonical word (`x[0][0]` ⇔ `caar`). Fusion caps at
`R7RS_ACCESSOR_DEPTH` (4) letters — a longer run splits into nested portable words rather than one
non-portable `caddadar`; a keyed step (`[:k]`, `[k]`) always breaks the run.

## 4. Curly braces — dict vs n-expr (odd/even)

A free `{…}` is classified from its **flat top-level form sequence** (ops are ordinary atoms
during classification):

| kind   | rule                                                   | folds to                      |
| ------ | ------------------------------------------------------ | ----------------------------- |
| dict   | empty, or even length with no operator on an odd index | `(dict …)`                    |
| unwrap | exactly one form                                       | that form (SRFI-105 identity) |
| n-expr | odd length ≥ 3, operators exactly at odd indices       | Pratt infix fold              |
| error  | anything else (e.g. `{a b c}`, truncated `{a +}`)      | door                          |

Suffix keys flip in dict key slots: `name:` → `:name`. Nested `{…}`/`[…]`/`(…)` count as one form.

### 4.1 N-expr (curly-infix)

`Infix⟨p⟩`: read one operand; while the next token is an operator `g` with `prec(g) ≥ p`, fold a
maximal same-glyph run (`{a + b + c}` is one n-ary node), operands read at `Infix⟨prec(g)+1⟩`.

| level | canonical                                   | glyph                    |
| ----- | ------------------------------------------- | ------------------------ |
| 5     | `*` `/` `modulo` `quotient` `remainder`     | same                     |
| 4     | `+` `-`                                     | same                     |
| 3     | `<` `>` `<=` `>=` `=` `eq?` `eqv?` `equal?` | `equal?`→`==`, rest same |
| 2     | `and`                                       | same                     |
| 1     | `or`                                        | same                     |
| 0     | `=>`                                        | `=>`                     |

The glyph map is injective for equality (`==`→`equal?`); `and`/`or` stay as scheme symbols.
Word-form comparisons are a deliberate one-way rewrite: `lt`/`gt`/`lte`/`gte` → `<`/`>`/`<=`/`>=`
(prefer n-expr; save normalizes to R7RS). Unknown ops render at level 3. The reader still
accepts legacy `&&`/`||` and math-skin `∧`/`∨` as aliases.

**Associative flatten (`and` / `or` only).** Nested same-op trees render as one n-ary chain:
`(and (and a b) c)` → `{a and b and c}` → `(and a b c)`. Conjunction/disjunction _intent_
survives; binary nesting does not — that is an intentional sugarcoat quotient, not a bug.

**Boolean mixing is LICENSELESS.** `and` under `or` (and vice versa) never elides braces,
even though `and` binds tighter — render emits `{{a and b} or c}`, never `{a and b or c}`.
A human-typed bare mix is a reader door ("brace each group"). Same-operator runs stay flat.

### 4.2 Free lists `[…]`

A free-standing `[…]` (not tight against a preceding value) folds to `(list …)`. Tight postfix
`xs[0]` / `f[:k]` remains subscript access (§3). Adjacency is the discriminator — same rule as
method-arg `(` and trailing-lambda `{`.

**Arrow lambda.** At level 0, `{(p₁ … pₖ) => body}` ⇒ `(lambda (p₁ … pₖ) body)`. A TrailingLambda
body without a top-level `=>` is the implicit-`it` form: `{body}` ⇒ `(lambda (it) body)`.

## 5. At-expressions

```
AtExpr    ← '@' Head? '{' Body '}'
Head      ← Word                                 ; @dedent is a reader special-case, not a binding
Body      ← (Literal / Interp)*
Interp    ← '@' Ident                            ; stops at '.' — prose periods stay literal
          / '@' '|' Ident '|'                    ; explicit boundary: @|name|!
          / '@' '(' Datum ')'                    ; graft a full form
Literal   ← any char except '@'                  ; quotes & newlines are literal, no escaping
```

Lowering: headless `@{…}` ⇒ `(str part…)`; `@head{…}` ⇒ `(head part…)`; `@dedent{…}` strips the
common indent then lowers to `(str …)` (dedent never exists in canonical form). Adjacent string
literals coalesce on read — which is exactly the render-side representability gate.

The graft body is **prefix Scheme context**: the parens are the grafted form's own parens
(`@(+ x 1)` grafts `(+ x 1)`), so `@(x + 1)` grafts a _call of `x`_ and `@({x + 1})` grafts a
call of the sum — no infix, no postfix steps attach to a bare `@id` interp (`@s[:k]` leaves
`[:k]` as literal prose; write `@(:k s)`).

Inside a body, brace depth is tracked (a balanced `{…}` inside prose is literal); the body may
span physical lines (§1.2).

## 6. Colon kwargs

`name:` at pair position is the kwarg spelling of the keyword `:name` — but inflation is
**head-aware**, not lexical: only kwarg-taking heads (`dict`, and names bound to `.prompt`
requires) inflate `name: v` back to `:name v` on read. Under an unknown head, `name:` stays the
literal symbol it is in R7RS. (Symmetrically the render only emits `k: v` pair lines under those
same heads — unknown heads keep the Scheme call shape.) An editor grammar can safely highlight
every `name:`/`:name` as a keyword — the distinction is semantic, not lexical.

### KWARGS LAW

When the head is a **known** kwarg-taker, the application’s remaining arguments are kwargs
territory:

1. **Never n-expr** — do not rewrite the call to curly-infix, even if the head is also an
   infix operator (e.g. a `.prompt` bound as `gt`). Kwargs are not `operand · op · operand`.
2. **Never neoteric** — do not rewrite to `f(…)`; the call stays a prefix application (or
   pair-line block when broken).
3. **Unknown head** — no pair-line layout; leave the original expression shape.

## 7. What is deliberately NOT in the grammar

- **No neoteric** `f(x)`/`f[x]` glue-calls (SRFI-105 tier 2) — collides with subscripts and
  trailing lambdas. A tight `(` binds only after a method-DOT word.
- **No `$nfx$` / `$bracket-apply$`** — the precedence ladder (§4) and index classification (§3)
  replace them.
- **No `??`** — `(if x x y)` renders as a plain `if`.
- **No indentation in the store** — §1 exists only in this face.

## 8. Editor wiring — the minimal token classes

A basic highlighter needs exactly these classes (this is what the shipped TextMate grammar and
the CodeMirror mode emit):

| class      | matches                                                           |
| ---------- | ----------------------------------------------------------------- |
| comment    | `;` to end of line                                                |
| string     | `"…"`                                                             |
| at-head    | `@word{`, `@{`, `@dedent{`                                        |
| at-body    | prose inside at-braces (string-ish)                               |
| at-interp  | `@id`, `@\|id\|`, `@(…)` inside a body                            |
| keyword    | `:name`, `name:`                                                  |
| method     | `.word` after a value                                             |
| subscript  | `[0]`, `[1:]`, `[:key]`                                           |
| operator   | infix glyphs incl. `=>`, `==`, `and`, `or`                        |
| definition | `define`, `lambda`, `let` family, `cond`, `if`, `else` head words |
| constant   | numbers, `#t` `#f`, `#\char`                                      |

Fidelity beyond coloring (fold ranges, structural selection, hover, rename) should not be
re-derived from this grammar — align spans via `alignSugarcoatScheme` and drive the canonical
tooling through the lens, the way `arrival-codemirror` does.

## Conformance

The grammar above is exercised by the package tests (`src/__tests__/`), which double as the
round-trip corpus: every construct must satisfy `read(render(x)) ≡ x` on the corpus. A grammar
change without a corpus change is suspect.
