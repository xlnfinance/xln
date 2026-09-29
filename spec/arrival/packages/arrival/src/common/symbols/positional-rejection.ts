// positional-rejection — positional sibling of kwargs-rejection.ts's humanizer.
//
// Rosetta's decode gate would otherwise propagate raw ZodError: zod v4's message is
// pretty-printed JSON of .issues — no verb, no argument. Models misread that dump as
// invented constraints. kwargs-rejection solves the named-param shape; this file solves
// positional/variadic (1-indexed arg labels). Local helpers (not imported from kwargs-rejection)
// — each file owns its rejection-string contract.

import { ZodError, type ZodType } from "zod";
import * as z from "../scheme-zod/index.js";
import { AValue } from "../../values/primitives/AValue.js";
import { is_callable_value } from "../../values/value-guards.js";

const PREVIEW_MAX = 60;

/** Truncation rule shared with kwargs-rejection / manifold bind (independent copies). */
function previewOf(v: unknown): string {
  const rendered = JSON.stringify(v) ?? String(v);
  return rendered.length > PREVIEW_MAX ? `${rendered.slice(0, PREVIEW_MAX)}...` : rendered;
}

/** Scheme-visible type word: AValue.kind, else typeof (+ array/null). */
function kindOf(v: unknown): string {
  if (v instanceof AValue) return v.kind;
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/** JS face for preview — AValue via toJS (callable via print; toJS is reverse-membrane). */
function faceOf(v: unknown): unknown {
  if (v instanceof AValue) {
    if (is_callable_value(v)) return v["arrival/print"]();
    try {
      return v["arrival/toJS"]();
    } catch {
      return String(v);
    }
  }
  return v;
}

/** Zod `_zod.def` via the sanctioned `z.defOf` doorway (E2 consolidation) — same
 *  introspection schema-to-ts uses for tuple items + rest. */
function zodDef(schema: unknown): { type?: string; items?: readonly ZodType[]; rest?: ZodType } {
  return z.defOf(schema) as { type?: string; items?: readonly ZodType[]; rest?: ZodType };
}

/** Declared schema for positional slot argIndex (fixed item or variadic rest). */
function schemaAt(inSchema: unknown, argIndex: number): unknown {
  const def = zodDef(inSchema);
  if (def?.type !== "tuple") return undefined;
  const items = def.items ?? [];
  return argIndex < items.length ? items[argIndex] : def.rest;
}

function declaredTypeAt(inSchema: unknown, argIndex: number): string {
  const fieldSchema = schemaAt(inSchema, argIndex);
  if (fieldSchema === undefined) return "the declared type";
  return (
    z.lookupName(fieldSchema as never) ?? (fieldSchema as { def?: { type?: string } })?.def?.type ?? "the declared type"
  );
}

/** One rendered line: `  arg N — <detail>` (1-indexed). Nested path → `arg N.<rest>`. */
function positionalIssueLine(issue: ZodError["issues"][number], args: readonly unknown[], inSchema: unknown): string {
  const argIndex = typeof issue.path[0] === "number" ? issue.path[0] : undefined;
  const label = argIndex === undefined ? "args" : `arg ${argIndex + 1}`;
  const restPath = issue.path.slice(1).map(String).join(".");
  const full = restPath ? `${label}.${restPath}` : label;
  const sentVal = argIndex === undefined ? undefined : args[argIndex];

  if (argIndex !== undefined && issue.path.length === 1 && sentVal === undefined) {
    return `  ${full} — missing (required)`;
  }
  if (issue.code === "invalid_type") {
    return `  ${full} — expected ${issue.expected}, got ${kindOf(sentVal)}: ${previewOf(faceOf(sentVal))}`;
  }
  // invalid_union / custom: name declared type from slot schema. custom is load-bearing —
  // z.lambda / z.listAlike are z.custom; without it every miss is bare "Invalid input".
  if (issue.code === "invalid_union" || issue.code === "custom") {
    const declared = argIndex === undefined ? "the declared type" : declaredTypeAt(inSchema, argIndex);
    return `  ${full} — expected ${declared}, got ${kindOf(sentVal)}: ${previewOf(faceOf(sentVal))}`;
  }
  return `  ${full} — ${issue.message}`;
}

/** Format positional/variadic decode rejection into the same head grammar as formatKwargsRejection. */
export function formatPositionalRejection(
  qualifiedName: string,
  error: ZodError,
  args: readonly unknown[],
  inSchema: unknown,
): string {
  const lines = error.issues.map((issue) => positionalIssueLine(issue, args, inSchema));
  const head = qualifiedName === "" ? "arguments rejected" : `${qualifiedName}: arguments rejected`;
  return `${head} — ${lines.length} problem(s):\n${lines.join("\n")}`;
}
