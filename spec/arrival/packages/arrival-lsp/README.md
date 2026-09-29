# @inhuman.tools/arrival-lsp

Scheme→TS type lens: lower Scheme to virtual TypeScript, type-check it with
tsc's `LanguageService` (never execute), and lift diagnostics, hover,
completions, and definitions onto `.scm` spans.

This is **not** the Language Server Protocol. The same surface ships as Node,
browser, and worker entries.

## Install

```bash
pnpm add @inhuman.tools/arrival-lsp
```

Depends on TypeScript 6.

## Usage (Node)

```ts
import { createSchemeLanguageService } from "@inhuman.tools/arrival-lsp";

const ls = createSchemeLanguageService();
const diags = ls.getSemanticDiagnostics(`(define z (car 5))`);
```

`(car 5)` is a tsc error on the `5` in the Scheme source — `start` / `length` /
`line` / `character` are Scheme coordinates, not the emitted TS. Hover,
completions, and go-to-definition use the same lift:

- `getQuickInfoAtPosition(scheme, offset)`
- `getCompletionsAtPosition(scheme, offset)` / `getCompletionContext(scheme, offset)`
- `getDefinitionAtPosition(scheme, offset)`

Virtual TS is type-checked, never executed.

## Subpaths

| Export        | Runtime                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `.`           | Node — disk prelude + the installed `typescript` package libs.                                                                  |
| `./browser`   | Browser — bundled prelude + inlined TS libs; no `fs`. `createBrowserSchemeLanguageService`.                                     |
| `./worker`    | (Shared)Worker entry. Importing it inside the worker attaches the server to the worker's ports.                                 |
| `./ls-client` | Light main-thread client (`connectSchemeLs`). Talks to a worker-hosted service without pulling `typescript` into the UI bundle. |

Do **not** import `./ls-protocol` from the UI thread — that barrel includes the
heavy serve side. Use `./ls-client` on the main thread and `./worker` inside the
worker.

Advanced (host wiring, incomplete prefixes, Scheme↔TS spans, `(require …)`):

| Export           | For                                                   |
| ---------------- | ----------------------------------------------------- |
| `./host-prelude` | Assemble a `host` option from a host type registry.   |
| `./balance`      | Close an incomplete Scheme prefix for cursor queries. |
| `./span-map`     | Bidirectional position map over the lowered TS.       |
| `./require-path` | Resolve `(require …)` against a project file table.   |

## Related

- [`@inhuman.tools/arrival-internals-types-prelude`](../arrival-internals-types-prelude) —
  builtin `.d.ts` the lens declaration-merges so Scheme programs type-check under tsc.
- [`@inhuman.tools/arrival-types-bridge`](../arrival-types-bridge) — lowering
  (Scheme → virtual TS).
- [`@inhuman.tools/arrival-codemirror`](../arrival-codemirror) — CodeMirror 6
  editor that consumes this service.

## Develop

From this package:

```bash
pnpm typecheck   # tsc -p tsconfig.test.json --noEmit
pnpm test
```

## License

[MIT](./LICENSE.md).
