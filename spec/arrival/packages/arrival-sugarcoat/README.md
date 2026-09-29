# @inhuman.tools/arrival-sugarcoat

**Sugarcoat** is the reversible view of Scheme.

```
canonical: (map
              (lambda (it)
                (:family
                  (normalize
                     (car it))))
              evidence)
sugarcoat: evidence.map{ it[0].normalize[:family] }
```

One program, two faces. The stored form is always canonical s-expressions; Sugarcoat is a bidirectional lens over it — render for reading, fold edits back, intent preserved exactly.

## Who this is for

You have Scheme programs — stored, generated, or agent-written — and humans who need to read and edit them without breathing parentheses. Sugarcoat renders the stored s-expressions as syntax a JS/Python/Kotlin programmer parses at a glance, and folds their edits back losslessly. The human edits what they can read; the store keeps what the machine can prove.

The original driver is AI–human collaboration: the LLM writes canonical Scheme, the editor sweetens it for the person reviewing, their tweaks convert back for the agent to continue. Neither side ever holds a lossy translation of the other's work. Nothing requires the AI, though — it works fine as a plain readability lens.

## Install

```bash
pnpm add @inhuman.tools/arrival-sugarcoat
```

## Quick start

```ts
import { schemeToSugarcoat, sugarcoatToScheme } from "@inhuman.tools/arrival-sugarcoat";

const scheme = "(map (lambda (it) (* it 2)) xs)";
schemeToSugarcoat(scheme); // → "xs.map{ it * 2 }"
sugarcoatToScheme("xs.map{ it * 2 }", scheme); // → "(map (lambda (it) (* it 2)) xs)"
```

`@inhuman.tools/arrival-codemirror` wires this into an editor: you type Sugarcoat, the buffer stores Scheme, live.

**The full syntax — indentation, infix, subscripts, method chains, `it`, dicts, at-expressions — is a 5-minute read: [LEARN.md](./LEARN.md).**

## API

| Export                                    | Role                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`schemeToSugarcoat(text)`**             | Canonical Scheme → Sugarcoat view.                                                                                                                                                                                         |
| **`sugarcoatToScheme(text, prevScheme)`** | Fold an edited view back. The second argument is the previous stored Scheme — unchanged top-level forms splice byte-for-byte; only changed forms reprint. Malformed Sugarcoat **throws** (keep the buffer; skip the save). |
| **`readSugarcoat(text)`**                 | Sugarcoat → Scheme AST nodes (the reader half of the lens).                                                                                                                                                                |
| **`alignSugarcoatScheme(text)`**          | Sugarcoat ↔ Scheme span pairing for IDE features on the sweet face.                                                                                                                                                        |
| **`paramHints` / `paramHintsSugarcoat`**  | Parameter-name inlay hints over Scheme / Sugarcoat text.                                                                                                                                                                   |
| **`tidyBoundNames`**                      | Bound-name recovery (`it` / singular noun). Import from the names subpath: `import { tidyBoundNames } from "@inhuman.tools/arrival-sugarcoat/names"`.                                                                      |

## The guarantee

`ast(sugarcoatToScheme(schemeToSugarcoat(x), x)) ≡ ast(x)` — render then read gives back the original intent, always. Every transform is an isolated deterministic rule with an inverse, and the pair is verified by round-tripping a real program corpus byte-for-byte.

> **Why not byte-identity of the source?** Byte round-trip would preserve _spelling_ — whether you wrote `caar` or `(car (car x))` — and spelling is exactly the noise a view should absorb. The lens quotients spelling and keeps intent: `(car (car x))` fuses to `caar`, formatting regenerates, and view-then-save never changes what a program means. What IS byte-stable is the stored file: saving an unedited view writes back the identical bytes.

> **Why isn't indentation stored?** Sugarcoat is indentation-structured (a line plus its deeper-indented children form one expression), but the canonical form carries zero layout semantics. The primary author of stored programs is a machine — it reads structure and gains nothing from layout, while inheriting every invisible-wrong-parse risk significant whitespace brings. So the store keeps visible delimiters; layout lives only in the human-facing view, regenerated on every render, impossible to corrupt.

## Two things in one package

1. **The lens** — `schemeToSugarcoat` / `sugarcoatToScheme`, everything above.
2. **Re-export of the syntax forest** — `parseSexprs` / `Node` from `@inhuman.tools/arrival-syntax`, plus `printScheme` (the Scheme printer the lens uses to write a changed form back).

The forest is a separate package so the interpreter type-layer and the type-lens emitter can parse Scheme without depending on this formatter — and so this package never depends on the eval engine. The main entry tree-shakes to `arrival-syntax` + `tiny-invariant`. The package still depends on `@here.build/lexical-namer` and `pluralize` for the `./names` subpath (`tidyBoundNames`); consumers of `.` do not pull those.

## Going deeper

- [LEARN.md](./LEARN.md) — the whole syntax, learn-x-in-y-minutes style.
- [GRAMMAR.md](./GRAMMAR.md) — the formal grammar (layout → tokens → forms), precise enough to derive an editor mode; a ready TextMate grammar sits in [`editors/`](./editors/).

## License

[MIT](./LICENSE.md).
