/**
 * Pure JS runtime surface for mercury emit — no scheme membrane, no EnvCapability.
 * Emitted modules import from `@inhuman.tools/arrival-modules/handlebars/runtime`.
 *
 * Matches RUNTIME_MANIFEST rows (source: "pkg") for:
 *   template/handlebars → templateHandlebars
 *   handlebars/parse    → handlebarsParse
 *   handlebars/run      → handlebarsRun
 */
import {
  asCompiledTemplate,
  compileTemplate,
  type CompiledTemplate,
  renderTemplateCall,
  runCompiledTemplate,
} from "./compile.js";

/** `(template/handlebars source args)` — one-shot compile+render. */
export function templateHandlebars(source: string, args: unknown): string {
  const a = Array.isArray(args) ? args : [args];
  return renderTemplateCall(String(source), a);
}

/** `(handlebars/parse source)` — compile once; returns an opaque handle. */
export function handlebarsParse(source: string): CompiledTemplate {
  return compileTemplate(String(source));
}

/** `(handlebars/run compiled args)` — render a previously compiled handle. */
export function handlebarsRun(compiled: unknown, args: unknown): string {
  const a = Array.isArray(args) ? args : [args];
  return runCompiledTemplate(asCompiledTemplate(compiled), a);
}

export { type CompiledTemplate } from "./compile.js";
