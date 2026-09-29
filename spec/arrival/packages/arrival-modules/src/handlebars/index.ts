// `@inhuman.tools/arrival-modules/handlebars`
//
// Opt-in EnvCapability: owns the handlebars dep (optional peer), teaches
// `.hbs` require (import-executable pretreat → scheme lambda), and exposes
// pure convert + `/handlebars/runtime` for mercury.

export { arrivalHandlebarsCapability } from "./capability.js";
export {
  asCompiledTemplate,
  compileTemplate,
  type CompiledTemplate,
  renderTemplateCall,
  resolveTemplateInput,
  runCompiledTemplate,
} from "./compile.js";
export { hbsContentsToSchemeSource } from "./scheme.js";
export { analyzeTemplate, coerceShape, type Shape, type TemplateInfo, validateShape } from "./template-analyze.js";
