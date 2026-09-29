# @inhuman.tools/arrival-codemirror

CodeMirror 6 for `@inhuman.tools/arrival` Scheme (Scheme + sugarcoat).

Two mounts — vanilla CM6 extensions, or `<SchemeEditor>` from `./react`.

## Install

```bash
npm i @inhuman.tools/arrival-codemirror
```

- **Vanilla:** align `@codemirror/*` with this package's pins.
- **React mount:** peer **react@19.2.0 and react-dom@19.2.0 exact**.

## Quick start

```ts
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView, lineNumbers } from "@codemirror/view";
import { createBrowserSchemeLanguageService } from "@inhuman.tools/arrival-lsp/browser";
import { schemeIde, schemeStructural, schemeSugarcoat } from "@inhuman.tools/arrival-codemirror";

new EditorView({
  parent: document.querySelector("#editor")!,
  doc: `(define (greet name)\n  (string-append "hello, " name))\n\n(greet 42)\n`,
  extensions: [
    lineNumbers(),
    syntaxHighlighting(defaultHighlightStyle), // otherwise this snippet is unstyled
    schemeSugarcoat(),
    schemeStructural(),
    schemeIde(createBrowserSchemeLanguageService()),
  ],
});
```

`schemeIde` already includes ghost unless you pass `{ ghost: false }`.
`createBrowserSchemeLanguageService()` runs `tsc` on the main thread.

`(greet 42)` gets a real type error — `tsc`'s, lifted to the `.scm` span.

### React

`<SchemeEditor>` from `./react`. Structural editing is **opt-in** — it steals
`Alt-↑` / `Mod-Shift-K`.

```tsx
import { useState } from "react";
import { SchemeEditor } from "@inhuman.tools/arrival-codemirror/react";

export function App() {
  const [value, setValue] = useState(`(define (greet name)\n  (string-append "hello, " name))\n`);
  const [view, setView] = useState<"scheme" | "sugarcoat">("scheme");
  return <SchemeEditor value={value} onChange={setValue} view={view} structuralEditing />;
}
```

## What's in the box

| Export                                         |                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `schemeSugarcoat()`                            | Language mode: Scheme _and_ Sugarcoat. Highlight _tags_ only — bring a theme. |
| `schemeStructural()`                           | Paredit on the Scheme lens. Real reader + verify-reparse net.                 |
| `schemeIde(backend)`                           | Lint, hover, completion, goto, semantic highlight, **and ghost**.             |
| `paramHintsExtension("scheme" \| "sugarcoat")` | Inlay parameter-name hints.                                                   |
| `sugarcoatIdeBackend(backend)`                 | Same IDE on the Sugarcoat face.                                               |
| `/react`                                       | `<SchemeEditor>` + `useSchemeIde()` (SharedWorker → Worker → in-thread).      |

## The seam

Every IDE extension is wired to exactly one method of a structural `SchemeIdeBackend`:

```ts
interface SchemeIdeBackend {
  getSemanticDiagnostics(scheme: string): MaybePromise<SchemeIdeDiagnostic[]>;
  getQuickInfoAtPosition(scheme: string, offset: number): MaybePromise<SchemeIdeQuickInfo | null>;
  getCompletionsAtPosition(scheme: string, offset: number): MaybePromise<SchemeIdeCompletionEntry[]>;
  getDefinitionAtPosition(scheme: string, offset: number): MaybePromise<SchemeIdeDefinition[]>;
  getSemanticClassifications?(scheme: string): MaybePromise<SchemeIdeClassifiedSpan[]>; // optional
  getCompletionContext?(scheme: string, offset: number): MaybePromise<SchemeIdeCompletionContext>; // optional
}
```

Methods may answer sync or with a Promise, so an in-process service and a worker behind a
message port satisfy the _same_ seam — `@inhuman.tools/arrival-lsp` fits directly, in either
mode. The optional methods are presence-gated feature unlocks: `getSemanticClassifications`
turns on semantic highlighting, `getCompletionContext` upgrades completion and the ghost to the
Σ∩T-ranked pipeline. Coordinates are always Scheme; Sugarcoat buffers translate through
`sugarcoatIdeBackend`.

## Structural keymap

Four transformation chords (slurp, barf, splice, kill-sexp), plus the selection
ladder and a force-delete escape hatch. Browser-safe, zero `Ctrl+Alt+char`
(AltGr-safe). A failed _transformation_ chord does nothing (falling through to a
default like Delete Line would be a destructive surprise); _selection_ chords
degrade gracefully.

| Chord                                   | Op                                                           |
| --------------------------------------- | ------------------------------------------------------------ |
| `Alt-↑` / `Alt-↓`                       | expand / contract selection (the ladder remembers its steps) |
| `Mod-Shift-K`                           | slurp forward — `(a \| b) c` → `(a b c)`                     |
| `Mod-Shift-J`                           | barf forward — `(a \| b c)` → `(a b) c`                      |
| `Alt-S`                                 | splice — `(a \| b c)` → `a b c`                              |
| `Mod-Shift-Backspace`                   | kill-sexp                                                    |
| `Alt-Backspace` (mac: `Ctrl-Backspace`) | force delete — the strict-protection escape hatch            |

Strict delete protection refuses any Backspace/Delete that would unbalance a currently-balanced
buffer — the caret steps over the delimiter instead, paredit-style.

## Honest edges

- **Structural ops are Scheme-lens-only, by design.** Sugarcoat's indentation is semantic —
  slurp/barf there would be wrong, not just unmapped.
- **The IDE on Sugarcoat goes through span alignment.** A position inside sugar that has no
  Scheme token answers empty; diagnostics inside sugar lift to the enclosing paired node.
  Unparseable Sugarcoat degrades to no answers (the editor keeps its last good state).
- **`#\…` char literals and `#|…|#` block comments are outside the structural reader's
  vocabulary** — their presence suspends structure (conservative: they would _mis_-parse rather
  than throw). Highlighting and the IDE are unaffected.
- **The ghost and the completion popup never race** — the unprompted moment at a narrowed
  argument slot belongs to the ghost; Ctrl-Space always brings the list; the popup hides the
  ghost.

## Demos

Runnable setups live in [`demos/`](./demos/README.md).

## License

[MIT](./LICENSE.md).
