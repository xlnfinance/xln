# @inhuman.tools/arrival-overridable-lens

Static, pre-eval read of Arrival Scheme knobs (`(define/overridable …)`). Parses a source string; **does not evaluate**.

## Install

```bash
pnpm add @inhuman.tools/arrival-overridable-lens
```

Requires `@inhuman.tools/arrival`.

## Usage

```ts
import { extractOverridableForms, foldSchemaTag } from "@inhuman.tools/arrival-overridable-lens";

const source = `(define/overridable tagline (s/string) "Build faster")`;
const forms = await extractOverridableForms(source); // top-level knobs; [] on parse failure
for (const f of forms) {
  const tag = foldSchemaTag(f.typeNode); // { ok: true, value: "string" }
  // f.defaultNode is the raw default parse node — evaluate or read it per your need
}
```

The surface, in two halves:

- **Walk** — `overridableFormsFromForms` (over already-parsed forms; pure, never throws) and `extractOverridableForms` (parses a source, `[]` on failure). Top-level only; hands back raw `typeNode`/`defaultNode` parse nodes. Plus `extractRequires` for the config-in-config `(require …)` edges.
- **Fold** — `foldSchemaTag`: a parse node of an `s/*` schema form → its canonical tagged-list value, with zero evaluation. The pre-eval dual of core's post-eval `tagToJsonSchema` (`@inhuman.tools/arrival/schema-tag`).

Used by hosts (form fields, an API `:input` deriver, CLI argv mapping).

## License

[MIT](./LICENSE.md).
