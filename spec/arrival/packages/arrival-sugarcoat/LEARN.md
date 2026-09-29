# Learn Sugarcoat in Y minutes

Sugarcoat is a view, not a language: everything below is canonical Scheme wearing familiar
syntax, and every form shown folds back to the s-expression next to it. `;; ≡` marks the
canonical form a line lowers to. Every example here is real renderer output.

Plain Scheme is always valid input — parens never stop working. Sugarcoat is what the
renderer _chooses_ to show you, and what the reader accepts back.

## Indentation

A line plus its more-indented children form one expression. That's the whole rule —
what other Lisps spend parens on, Sugarcoat spends layout on.

```scheme
define (score user)
  {user[:karma] * 2}

;; ≡ (define (score user)
;;     (* (:karma user) 2))
```

Bracket balance beats layout: a `{…}` or `(…)` may span physical lines freely.
Indentation is regenerated on every render — you can't save a "wrong layout".

The rule runs one way: indentation groups code, but **inside any bracket you are in
plain code context** — layout is just whitespace there. A multi-line lambda body can't
use indentation forms; write them delimited:

```scheme
rows.map{(r) => (dict :id r[:id] :label r[:label].strip)}
;; ≡ (map (lambda (r) (dict :id (:id r) :label (strip (:label r)))) rows)
```

## Curly-infix

`{…}` switches to infix with the precedence ladder you already know
(`or` < `and` < comparisons < `+ -` < `* / modulo`):

```scheme
{a + b + c}              ;; ≡ (+ (+ a b) c)
{v == "a" or v == "b"}   ;; ≡ (or (equal? v "a") (equal? v "b"))
{a - b < c}              ;; ≡ (< (- a b) c)   — tighter child needs no braces
{{a + b} * c}            ;; ≡ (* (+ a b) c)   — looser child keeps them
```

`==` is `equal?`; `and`/`or`, `=`, `eq?`, `eqv?` render as themselves, so equality _kind_
and logical intent survive the round-trip.

`and` / `or` prefer a **flat n-expr** (associative collapse) for the _same_ op:

```scheme
{a and b and c}          ;; ≡ (and a b c)
;; also from (and (and a b) c) — nesting is intent-erased on purpose
{a or b or c}            ;; ≡ (or a b c)
```

**Boolean mixing is licenseless** — mixed `and`/`or` always keeps braces (render never
emits the flat ambiguous form; bare mixed input is a door):

```scheme
{{a and b} or c}         ;; ≡ (or (and a b) c)   — NOT {a and b or c}
{a or {b and c} or d}    ;; ≡ (or a (and b c) d)
;; {a and b or c}        ;; ✗ brace the groups
```

Word-form comparisons (`lt`/`gt`/`lte`/`gte` — a common agent/JS habit) prefer n-expr and
rewrite to the R7RS glyphs on save:

```scheme
{a < b}                  ;; ≡ (< a b)     — also from (lt a b) / {a lt b}
{x >= 0}                 ;; ≡ (>= x 0)    — also from (gte x 0)
```

**Infix exists only inside `{…}`.** A naked operator line is an application, not arithmetic:

```scheme
{item[:votes] * item[:weight] + item[:bonus]}
;; ≡ (+ (* (:votes item) (:weight item)) (:bonus item))

item[:votes] * item[:weight]   ;; ✗ CALLS (:votes item) with args * and (:weight item)
adults.fold(0){…} / count      ;; ✗ same trap — wrap it whole: {adults.fold(0){…} / count}
```

## Subscripts

`[n]` walks pairs, `[:key]` reads keyed data. The whole `c[ad]+r` alphabet dissolves:

```scheme
x[0]        ;; ≡ (car x)
x[1]        ;; ≡ (cadr x)
x[1:]       ;; ≡ (cdr x)
x[0][0]     ;; ≡ (caar x)
it[:verdict]  ;; ≡ (:verdict it)
```

## Method-dot chains

`.symbol` seats the receiver in the _last_ argument slot of the call it chains into:

```scheme
x.f.g                       ;; ≡ (g (f x))
xs.map{ it * 2 }            ;; ≡ (map (lambda (it) (* it 2)) xs)
evidence.map{ it[0].normalize[:family] }
;; ≡ (map (lambda (it) (:family (normalize (car it)))) evidence)
```

Extra positional arguments (a fold seed, a default) go in `(…)` **between** the method
name and the trailing lambda — never after the braces:

```scheme
items.fold(0){(acc it) => acc + it[:price]}
;; ≡ (fold (lambda (acc it) (+ acc (:price it))) 0 items)

items.fold{(acc it) => acc + it}  0   ;; ✗ NOT a seed — this APPLIES the fold result to 0
```

One rule covers unary pipes, higher-order calls with a trailing lambda, and seeded folds.
The brackets must be _tight_ (no space before `(` or `{`) — a spaced `{…}` is a sibling
operand, not a trailing lambda.

## `it` and arrow lambdas

A trailing lambda whose parameter is named `it` elides it, Kotlin-style. Any other
signature renders as an arrow:

```scheme
users.filter{ it[:age] < 30 }
;; ≡ (filter (lambda (it) (< (:age it) 30)) users)

users.filter{(u) => u[:age] < 30}
;; ≡ (filter (lambda (u) (< (:age u) 30)) users)

(fold {(acc x) => acc + x} knil xs)
;; ≡ (fold (lambda (acc x) (+ acc x)) knil xs)
```

The lens never renames _your_ parameters — `u` stays `u`. When you want `it`-ification
(or `items` → `item` recovery), that's the explicit opt-in `tidyBoundNames` pass from
`@inhuman.tools/arrival-sugarcoat/names`, or its no-touch twin `boundNameHints` for editor
inlays.

`=>` is just an alias of `lambda` — `(=> (y) y)` is legal — but `{(y) => y}` is the face.

## Binding forms

Arrival accepts polyglot bracket bindings (Racket `[a 1]` per pair, Clojure
`[a 1 b 2]` whole-list — see arrival `docs/grammar.md` §BINDINGS). `schemeToSugarcoat`
lowers them to the paren image first; the view never keeps the tolerant spelling.
Intent (names + values) is preserved:

```scheme
;; Scheme or polyglot input — same sugar face
(let* ([a 1] [b 2]) (+ a b))
(let  [a 1 b 2] (+ a b))
(let* ((a 1) (b 2)) (+ a b))
;; all render as:
let*
  a
    1
  b
    2
  {a + b}
```

`let*`/`let` elide the binding parens — each binding is a name line with its value
indented; the body follows as a sibling:

```scheme
let*
  base
    (fetch url)
  rows
    base[:rows]
  rows.map{ it[:id] }

;; ≡ (let* ((base (fetch url))
;;          (rows (:rows base)))
;;     (map (lambda (it) (:id it)) rows))
```

`cond` renders vertical, test then consequence:

```scheme
cond
  {n < 0}
    "neg"
  {n = 0}
    "zero"
  else
    "pos"

;; ≡ (cond ((< n 0) "neg") ((= n 0) "zero") (else "pos"))
```

## Dicts, lists, and kwargs

`{}` and `[]` are collection literals on the sugarcoat surface (same glyphs as arrival's
reader). They fold to `(dict …)` / `(list …)`:

```scheme
{:name "Ada" :age 36}     ;; ≡ (dict :name "Ada" :age 36)
{}                        ;; ≡ (dict)
[1 2 3]                   ;; ≡ (list 1 2 3)
[]                        ;; ≡ (list)
[{:a 1} {:b 2}]           ;; ≡ (list (dict :a 1) (dict :b 2))
[a b]                     ;; ≡ (list a b)  — also from (cons a b); save normalizes to list
```

**`{}` is shared with n-expr.** Discrimination is odd/even at the top level:

| shape                      | meaning              |
| -------------------------- | -------------------- |
| even forms (incl. empty)   | dict — kv pairs      |
| odd, `operand op operand…` | n-expr — curly-infix |
| single form                | unwrap (`{x}` ≡ `x`) |

```scheme
{a + b}                   ;; ≡ (+ a b)          — odd, op in the middle
{:a 1 :b 2}               ;; ≡ (dict :a 1 :b 2) — even, no ops
{a and b or c}            ;; ≡ (or (and a b) c)
```

Suffix keys flip inside braces: `{name: "Ada"}` ≡ `{:name "Ada"}`.

**`[]` is free list only when not tight.** Tight postfix is still subscript access:

```scheme
xs[0]                     ;; ≡ (car xs)         — tight subscript
(f [1 2])                 ;; ≡ (f (list 1 2))   — spaced free list
```

Kwarg-taking heads other than `dict` (e.g. a `.prompt` require) still use the block
colon-pair form under the head name. The legacy unbraced dict block still reads:

```scheme
dict
  name: "Ada Lovelace"
  age: 36
;; ≡ (dict :name "Ada Lovelace" :age 36)
```

## At-expressions — prose without escaping

`@head{…}` is a flat tagged template: quotes and newlines inside the braces are literal,
`@x` interpolates a value, `@(expr)` grafts a full form, `@|x|` marks a boundary when
prose glues to the name:

```scheme
@{hello, @|name|!}          ;; ≡ (str "hello, " name "!")
@str{hello, @|name|!}       ;; ≡ same — explicit alias of headless @{}

;; Scheme (string-append …) with scalar casts projects as @{…}:
;;   (string-append "a " (number->string x) " b")  →  @{a @x b}
;; (str already coerces; number->string / symbol->string / ->string drop)
;; Strict surface (opt-out): @string-append{a @x b} ≡ (string-append "a " x " b")

@dedent{
  multi-line prose
  with interpolated @x values
}                            ;; ≡ (str …) with the common indent stripped
```

**Inside a body, `@x` interpolates a bare name.** A tight trailing subscript chain
rides along — `@s[:baseline]` / `@xs[0]` — the same accessor surface as code context.
For calls and anything richer, graft a form with `@(…)`; inside the graft you are
writing **prefix Scheme** (the parens are the form's own envelope, not a
wrapper — so postfix sugar like `persona[:id]` must stay bare, not `@(persona[:id])`):

```scheme
@{Visit #@(+ visits 1)}       ;; ≡ (str "Visit #" (+ visits 1))
@{from @s[:baseline]}         ;; ≡ (str "from " (:baseline s))
@{/@config/hero-id@persona[:id]@replay-idx}

@{Visit #@(visits + 1)}       ;; ✗ calls `visits` — graft is prefix context, no infix
@{from @s [:baseline]}        ;; ✗ space breaks the chain — "[:baseline]" is prose
```

Headless `@{…}` defaults to `(str …)`; `@str{…}` is the same head. Racket's `at-exp`
is the ancestor.

---

That's the surface. The machinery behind it — the round-trip law, span alignment for
editors (`alignSugarcoatScheme`), parameter hints, the `parseSexprs` forest
(`@inhuman.tools/arrival-syntax`, re-exported here) — is in the [README](./README.md).
