# @inhuman.tools/arrival-syntax

Span-preserving Scheme s-expression forest. This is the syntax tree, not the evaluator.

`parseSexprs` answers “what did the user write, and where?” Arrival’s `Parser` answers “what does this program mean?” — it expands reader macros into `APair` / `AVector` / interned `ASymbol` and drops comments. Editors, the type-lens, and the sugarcoat round-trip need the first tree.

```ts
import { parseSexprs } from "@inhuman.tools/arrival-syntax";

parseSexprs("(map f xs) ; trailing");
// [{ list: [{ atom: "map" }, { atom: "f" }, { atom: "xs" }], span: [0, 10], trail: ["; trailing"] }]
```

`[]` and `{}` are containers (`open: "[" | "{"`), not atom glue. Racket `#:limit` mints as `:limit`. A `;` comment on its own line before a datum is that datum’s `lead`; one on the same line after is its `trail`.

`@inhuman.tools/arrival-sugarcoat` re-exports `parseSexprs` / `Node` and owns the Scheme↔sugarcoat lens on top. `@inhuman.tools/arrival`’s type-layer and `@inhuman.tools/arrival-types-bridge` import this package directly.

## Install

```bash
pnpm add @inhuman.tools/arrival-syntax
```

## License

[MIT](./LICENSE.md).
