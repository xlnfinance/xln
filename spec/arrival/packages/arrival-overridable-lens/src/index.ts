// @inhuman.tools/arrival-overridable-lens — the static (pre-eval) substrate for reading a
// program's `(define/overridable …)` surface: the canonical parse-tree walk + `foldSchemaTag`,
// the pre-eval dual of core's post-eval `tagToJsonSchema`. Consumed one-way by the out-of-core
// overridable lenses (studio form fields, the API `:input` schema, the CLI argv mapper); core
// itself never holds parse nodes, so this lives OUT of core, depping it downward.

export { foldSchemaTag, type SourceLocation } from "./schema-fold.js";
export {
  OVERRIDABLE_DEFINE_HEAD,
  overridableFormsFromForms,
  extractOverridableForms,
  extractRequires,
  type OverridableForm,
} from "./walk.js";
