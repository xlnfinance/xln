/**
 * Compile + run Handlebars templates (JS plane). Shared by the capability verbs
 * and the pure `/handlebars/runtime` export mercury emits against.
 */
import { ANil } from "@inhuman.tools/arrival";
import Handlebars from "handlebars";
import invariant from "tiny-invariant";

import { analyzeTemplate, coerceShape, type TemplateInfo, validateShape } from "./template-analyze.js";

export interface CompiledTemplate {
  render: HandlebarsTemplateDelegate;
  info: TemplateInfo;
}

const TEMPLATE_CACHE = new Map<string, CompiledTemplate>();

/** Structural re-recognition after a scheme round-trip (borrowed box unwrap). */
const isCompiledTemplate = (v: unknown): v is CompiledTemplate =>
  v !== null &&
  typeof v === "object" &&
  typeof (v as CompiledTemplate).render === "function" &&
  typeof (v as CompiledTemplate).info === "object";

export function asCompiledTemplate(v: unknown): CompiledTemplate {
  invariant(isCompiledTemplate(v), "expected a compiled template handle (from handlebars/parse)");
  return v;
}

export function compileTemplate(source: string): CompiledTemplate {
  let tm = TEMPLATE_CACHE.get(source);
  if (!tm) {
    tm = {
      render: Handlebars.compile(source, { noEscape: true }),
      info: analyzeTemplate(source),
    };
    TEMPLATE_CACHE.set(source, tm);
  }
  return tm;
}

const isPrimitiveLike = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  Array.isArray(v) ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean";

const isDictLike = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Build the input dict from call-site args:
 *   1. (template dict) — single dict arg
 *   2. (template primitive) — single primitive + single-var template
 *   3. (template k1 v1 k2 v2 …) — alternating key/value
 */
export function resolveTemplateInput(args: unknown[], info: TemplateInfo): Record<string, unknown> {
  invariant(args.length > 0, "template: expected at least one argument");
  if (args.length === 1) {
    const a = args[0];
    if (isDictLike(a)) return a;
    if (isPrimitiveLike(a)) {
      invariant(
        !!info.singleVarName,
        () =>
          `template: single primitive arg passed to a template with ${info.rootFields.length} fields ` +
          `(${info.rootFields.join(", ")}); either pass a dict, or use alternating keyword/value args`,
      );
      return { [info.singleVarName]: a };
    }
    throw new Error(`template: unsupported single-arg type ${typeName(a)}`);
  }
  invariant(
    args.length % 2 === 0,
    () => `template: expected even number of args (alternating key/value), got ${args.length}`,
  );
  const fieldSet = new Set(info.rootFields);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (typeof k !== "string") {
      throw new TypeError(`template: key at position ${i} is not a string (got ${typeName(k)})`);
    }
    invariant(
      info.rootFields.length === 0 || fieldSet.has(k),
      () => `template: unknown field "${k}"; template root fields are: ${info.rootFields.join(", ")}`,
    );
    out[k] = args[i + 1];
  }
  return out;
}

/** Nil-like for the array→`[]` failsafe (scheme empty list / null / undefined). */
const isNilLike = (v: unknown): boolean => v == null || v instanceof ANil;

export function runCompiledTemplate(tm: CompiledTemplate, args: unknown[]): string {
  const data = coerceShape(tm.info.shape, resolveTemplateInput(args, tm.info), isNilLike);
  const ok = validateShape(tm.info.shape, data);
  if (!ok.ok) throw new Error(`template input mismatch: ${ok.message}`);
  return tm.render(data);
}

export function renderTemplateCall(source: string, args: unknown[]): string {
  return runCompiledTemplate(compileTemplate(source), args);
}
