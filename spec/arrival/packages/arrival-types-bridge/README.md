# @inhuman.tools/arrival-types-bridge

Scheme → virtual TypeScript for the type lens: `emitTypes`, lossless ident serde
(`encodeSchemeIdent` / `schemeifyTsText`), and the parse/desugar/scope front
those run on.

Arrival-lsp and arrival-codemirror consume this package. The Mercury compiler
re-exports the same emitter (and keeps `narrowsMembersOf`, which reads the
compiler registry).

## Install

```bash
pnpm add @inhuman.tools/arrival-types-bridge
```

```typescript
import { emitTypes, schemeifyTsText } from "@inhuman.tools/arrival-types-bridge";

const { ts, mappings } = emitTypes(`(define (f x) (string-append x "!"))`);
schemeifyTsText("string$dash$append"); // "string-append"
```

## License

[MIT](./LICENSE.md)
