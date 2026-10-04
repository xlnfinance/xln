# Examples

Specimens from runs in this repo. The rules are in `SKILL.md`. Paths below are the checkout those runs used.

## Two results, one dict

One program, two defines, one dict. `arrival__scheme-repl-with-all-mcp-tools`.

```scheme
(define found
  (ast-grep/find_code
    :project_folder "/Users/boris/XLN/og_xln/pure/entity/paybook"
    :pattern "switch ($D._tag) { $$$BODY }"
    :language "typescript"
    :max_results 1))
(define held
  (spec/arrival_run
    :code "(require \"lib/vocabulary.scm\") (require \"lib/check.scm\") (require \"runtime/tick.scm\") (check runtime)"
    :json #t))
(dict :hit (substring (:result found) 0 80) :held held)
```

```text
{:hit "Found 1 matches:\n\n/Users/boris/XLN/og_xln/pure/entity/paybook/paybook.ts:152-167"
 :held {:ok #t :states 222 :transitions 520 :goals 6}}
```

The next message was `found, held — also available in subsequent calls.`

## A dump in the same program

The same search, a `dump_syntax_tree` of a snippet, and the same checker, returned as one dict. `shape`'s text began:

```text
Debug AST:
program (0,0)-(0,52)
  switch_statement (0,0)-(0,52)
```

`held` was the checker dict above. The note named `found, shape, held`.

```scheme
(define shape
  (ast-grep/dump_syntax_tree
    :code "switch (e._tag) { case \"locked\": return undefined; }"
    :language "typescript"
    :format "ast"))
```

## Several nodes

`case "$TAG": return $EXPR` was rejected: `Multiple AST nodes are detected.` The rule that matched used `pattern.context` and `selector: switch_case`, and `inside` with `stopBy: end`. That rewriter is the `case-return` entry in the next section.

## Source order is one rewriter

Two separate rules on `pure/entity/paybook/paybook.ts` printed the arms grouped by rule, so `locked` came out before `pass`:

```text
forward: (e) => forwardOf(state, clock, view, hashlock, e)
receive: (e) => receiveOf(state, hashlock, e)
locked: (e) => undefined
pass: (e) => { const c = incoming(state, e.from, hashlock);
    return c === undefined ? undefined : resolveUp(e.from, hashlock, c, e.secret); }
fail: (e) => { const c = incoming(state, e.from, hashlock);
    return c === undefined ? undefined : cancelUp(e.from, hashlock, c); }
```

One rewriter, `joinBy: ",\n"`, one `fix`. The scan returned one replacement, bytes 8360–8876, in source order. This scan was the CLI. The same yaml is the `yaml` argument of `rewrite/preview`.

```yaml
id: switch-tag-to-match
language: typescript
rule:
  pattern: switch ($DISC._tag) { $$$CASES }
rewriters:
  - id: case-return
    rule:
      pattern:
        context: |
          switch (e) {
            case "$TAG":
              return $EXPR
          }
        selector: switch_case
      inside:
        stopBy: end
        pattern: switch ($DISC._tag) { $$$ }
    fix: '$TAG: ($DISC) => $EXPR'
  - id: case-block
    rule:
      pattern:
        context: |
          switch (e) {
            case "$TAG": { $$$STMTS }
          }
        selector: switch_case
      inside:
        stopBy: end
        pattern: switch ($DISC._tag) { $$$ }
    fix: '$TAG: ($DISC) => { $$$STMTS }'
transform:
  ARMS:
    rewrite:
      rewriters: [case-return, case-block]
      source: $$$CASES
      joinBy: ",\n"
fix: |-
  match($DISC, {
    $ARMS,
  })
```

## Read the replacement, then refuse it

The replacement from that scan:

```text
match(e, {
    forward: (e) => forwardOf(state, clock, view, hashlock, e),
    receive: (e) => receiveOf(state, hashlock, e),
    pass: (e) => { const c = incoming(state, e.from, hashlock);
    return c === undefined ? undefined : resolveUp(e.from, hashlock, c, e.secret); },
    fail: (e) => { const c = incoming(state, e.from, hashlock);
    return c === undefined ? undefined : cancelUp(e.from, hashlock, c); },
    locked: (e) => undefined,
  })
```

Every arm rebinds `(e)`. The block arms are one line. It was not applied.

A later snippet preview returned `match(e, { forward, receive, pass, fail, locked })`, one match, and wrote nothing. `apply` of `/tmp/nope.ts` came back `isError: true` with `/tmp/nope.ts is outside the repo`. After the switch was gone, preview of `pure/entity/paybook/paybook.ts` with the same rule returned `matches: 0` and `written: false`.

## The checker, and one planted break

These two ran on the spec server, `json: true`, before the manifold. Inside a program they are `spec/arrival_run` with `:json #t`, and the ok value comes back as the dict in the first section.

Honest page, `(check runtime)` after requiring `lib/vocabulary.scm`, `lib/check.scm`, and `runtime/tick.scm`:

```text
{"ok":true,"states":222,"transitions":520,"goals":6}
```

One of the six goal traces, from `(goal-traces runtime 6)`:

```text
["init","apply :runtime","commit :runtime","apply :runtime","commit :runtime","apply :runtime","commit :runtime","apply :runtime","crash :runtime","recover :runtime","flush :runtime","flush :runtime","flush :runtime"]
```

`runtime/bugs/send-before-commit.scm` required as well. The checker stopped here:

```text
{"ok":false,"violated":"outputs leave only after their WAL row is committed","trace":["apply :runtime"],"state":{"queue":[["i2","bad",1],["i3","good",1],["i4","fatal",5]],"state":["i1@2"],"ts":2,"height":0,"staged":[1,2,"i1","ok-i1","i1@2"],"wal":[],"committed-state":[],"sent":["ok-i1"],"received":["ok-i1"],"crashed":false,"crashes":0,"halted":false,"halt-cause":false,"clock":0}}
```
