# xln.ts style gate

`bun style/check.ts` (from `pure/`) scans `xln.ts` with the ast-grep rules in `style/rules/` and fails if any rule's hit count rises above `style/baseline.json`. After a refactor lowers a count, `bun style/check.ts --update` ratchets the baseline down.

`unreachable` counts top-level declarations of `xln.ts` that nothing reaches (`style/reach.ts`): a declaration is live when another `.ts` file under `pure/` names it, or when a live declaration or a top-level statement mentions it. Its baseline is 0, so a new export with no caller fails the gate and names itself. Delete it, or call it from the code or a test that needs it.

The rules encode the rewrite's pure style: lines of at most 120 characters (`long-line`), no `let`, no loops, no in-place mutation (`push`, `set`, `delete`, member assignment, `++`), no `throw`, no classes. The original 2.5k-line rewrite (f3ca37c) scored 164 hits, mostly in its byte and hex codecs. The equivalence port raised that to 1198; the baseline records that starting point so the count can only go down.

## Registered exceptions

`no-mutating-call` is not zero. Each hit mutates state that is local to one call or one cache and never reaches a caller as mutable:

- `mapAccumResult`: `collected.push(y)`, the vocabulary's one transient accumulator. Appending with `[...ys, y]` made every `mapAccum`, `traverse`, `strictFold` and `lenientFold` quadratic (review B1: 2.7 s at 40k items). The array is created by the call, pushed to only by that call, and handed out once, after the last push, as `readonly Y[]`. `bun bench/folds.ts` shows the helpers growing linearly. This exception raised the baseline from 4 to 5.
- `concat`: `joined.set(p, offset)` fills the fresh output buffer.
- `committedView` and the prepared-body memo: `views.set` and two `preparedBodies.add` fill module-level `WeakMap`/`WeakSet` caches of pure results.

A new exception must be listed here, with why no pure expression does the same work at the same cost.
