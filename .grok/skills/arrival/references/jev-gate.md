# The check before apply

`jev/gate` never writes. It builds the diff from the file and the preview, so a prettier diff cannot be handed in. One Noul asks whether that diff carries out the operations and nothing else. The words are `FAITHFUL` in `spec/mcp/jev-gate.mjs`.

## Call

```scheme
(define seen (ast-edit/preview :path path :operations ops))
(define held (jev/gate :path path :operations ops :after (:preview seen)))
(if (eq? (:verdict held) 'allow)
    (ast-edit/apply :path path :operations ops)
    held)
```

`allow` applies. `doubt` and `refuse` are the result, and the file stays. Pass `:path` or `:before`, not both. `:path` is the file on disk.

## Verdicts

| verdict | when | what you do |
|---|---|---|
| `allow` | the file is unchanged, or the Noul is at or above `ALLOW_AT` | apply. The return has no diff. |
| `doubt` | the diff is too wide to judge, or the Noul sits between the bars | you decide. The return has `probability` and, when a diff was built, `diff`. |
| `refuse` | a requested name or value is absent, a removed parameter is not on a deleted line, or the Noul is at or below `REFUSE_AT` | do not apply. |

`ALLOW_AT` and `REFUSE_AT` live in `spec/mcp/jev-gate.mjs`. A false allow writes, so the allow bar is the high one. A Noul has no confidence field. `probabilities` is that Noul and one minus it, derived here.

## What it will not catch

A request for the wrong type, carried out exactly, is `allow`. The mistake was the request. An obvious miss is refused before any call. A spread is not a yes.

## Checked

`jev-1.13.0`. `set_return_type` of `load` to `Promise<string>`, body untouched: `allow`, noul 0.95. The same operation with the body changed to `return Number(id)`: `refuse`, noul 0.05.
