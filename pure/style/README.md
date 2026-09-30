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

## Guide rules the ratchet also counts

These map Arthur's elegant-code guide (project files, style/arthur-elegant-code-guide.md) onto ast-grep. They start at today's counts and can only go down; each hit is a place that fails the relief test until it is reshaped.

- `no-comma-sequence`: the comma operator packs several steps into one expression (guide: one const per statement, named flow steps).
- `no-nested-ternary`: a ternary inside a ternary (name the cases with `switch (true)` or a small function).
- `no-try`: `try`/`catch` (guide: Result, not throw); a boundary that must catch is registered here like the other exceptions.
- `no-unknown-cast`: `as unknown as` (parse into the type, do not assert it; guide: make invalid states unrepresentable).
- `no-string-error`: `Result<T, string>` (an error is a tagged union, not text).
- `no-problems-list`: an array of `cond ? undefined : "text"` filtered for defined (use named checks that return a tagged error).
- `no-og-source-ref`: a comment that points at og source lines (`file.ts:123`); state the rule in our words and cite the spec property.

Not mechanically checked: the relief test itself, honest names, function bodies that fit one sentence, comments that say why, positional boolean and `undefined` arguments (`review/pure-style-drift.md` proposes counting those), and everything outside `xln.ts`.
