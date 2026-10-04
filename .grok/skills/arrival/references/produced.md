# Produced code

What a replacement, or the edit you write by hand, has to be. The program rules are in `SKILL.md`. The runs are in `examples.md`.

## What wins

`AGENTS.md` Style, then the helpers already in `pure/kernel`. The preferences below come from `code-discipline`, `pure-ts`, and `typescript`.

A form those skills demonstrate is not emitted when this tree rejects it: `throw`, `try`, `let`, a loop, a class, `kind` as the discriminant, `assertNever` called from a module, `pipe`, `chain`, `andThen`, `matchResult`, `matchLiteral`, `matchPartial`, `Option`.

## The match

A value with `_tag` is `match` from `pure/kernel/core/tagged.ts`. One arm per tag. The arm's parameter is named for the variant. A tag the arm does not read is `()`. The body is the statements you would have written, one `const` each. A guard stays inside the arm.

```ts
match(entry, {
  forward: (forwarded) => forwardOf(forwarded),
  locked: () => undefined,
})
```

`match` is exhaustive, so a new tag is a compile error. Do not add a default. The `assertNever` inside `tagged.ts` implements `match`. It is not a pattern for app code.

A `switch` that is not on `_tag` stays a `switch`.

## The function

One sentence. The name is what the value is. A line that can go is gone. No helper until a third real use. Arguments that would be bare `true`, `false`, or `undefined` are one record. A signature the file already has stays.

If reading it does not produce relief, the replacement is not applied.

A type, a parameter, or a named import is a slot edit. The steps are `references/ast-edit.md`.

## Values

A change is a new value. Fields are `readonly`.

Failure is `Result` in `pure/kernel/core/result.ts`: `{ ok: true, value }` or `{ ok: false, error }`, built with `ok` and `err`. The error is a tagged value. The folds already in that file are `map`, `flatMap`, `mapErr`, `unwrapOr`, `foldResult`, and `mapAccumResult`. A string error is not a Result. An impossible transition is `err`, not `throw`.

Absence stays what this module already returns, `undefined` or its own ADT. Do not introduce `None`.

A unit is the `Brand` the module already has, from `tagged.ts`. A parser returns `Result` or `undefined`. It does not throw.

Two booleans that can both be true are one `_tag`.

An update the file already expresses with its own helper stays on that helper. Do not add a lens, a catalog, or a template-literal parser to a patch that did not have one.
