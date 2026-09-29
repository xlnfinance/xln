/**
 * Static analysis of a Handlebars template: walks the AST and emits a
 * required-shape tree that the call-site dispatcher uses to validate input
 * and to decide whether the template has a single "named" input slot.
 *
 *   {{name}}           → root has field `name`
 *   {{user.name}}      → root has field `user` whose field `name` exists
 *   {{#each items}}    → root has field `items` (array); inside the block,
 *     {{this}}           paths apply to the element type
 *     {{name}}
 *   {{/each}}
 *   {{#if cond}}…{{/if}} → `cond` exists; body still in outer scope
 *   {{#with x.y}}…       → body is in scope of `x.y`
 *
 * Partials, sub-expressions (helpers with args), and `@` data variables are
 * ignored for the purpose of structure inference.
 */
import Handlebars from "handlebars";
import invariant from "tiny-invariant";

export type Shape =
  | { kind: "any"; optional?: boolean }
  | { kind: "array"; element: Shape; optional?: boolean }
  | { kind: "object"; fields: Map<string, Shape>; optional?: boolean };

export interface TemplateInfo {
  /** Required input structure inferred from the template. */
  shape: Shape;
  /** When the template's root has exactly one field — its name. Used by the
   *  call-site dispatcher to wrap a single primitive arg as `{name: arg}`. */
  singleVarName: string | null;
  /** Top-level field names mentioned at the root scope (in order of first use). */
  rootFields: string[];
}

const KNOWN_BLOCK_HELPERS = new Set(["if", "unless", "each", "with"]);

interface HbsNode {
  type: string;
  [k: string]: unknown;
}

function asNode(n: unknown): HbsNode {
  return n as HbsNode;
}

function objShape(optional = false): Shape {
  return { kind: "object", fields: new Map(), optional };
}
function anyShape(optional = false): Shape {
  return { kind: "any", optional };
}

function ensureObject(s: Shape): Map<string, Shape> {
  // Caller error — an object shape MUST exist before descending.
  invariant(s.kind === "object", () => `template analyze: expected object shape, got ${s.kind}`);
  return s.fields;
}

/**
 * Add a required path to a shape tree. Returns the updated shape (mutated
 * in place — calling code keeps the root reference). For the path
 * `["user", "name"]`, we make root contain `user: object`, and `user`
 * contain `name: any`.
 *
 * `optional` makes both the leaf and any intermediate nodes created on
 * this insertion optional. Pre-existing required intermediates are not
 * downgraded; pre-existing optional intermediates stay optional.
 */
function addPath(root: Shape, path: string[], optional = false): void {
  if (path.length === 0) return;
  if (root.kind !== "object") {
    root = objShape();
  }
  let cursor = ensureObject(root);
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const last = i === path.length - 1;
    const existing = cursor.get(key);
    if (last) {
      if (!existing) cursor.set(key, anyShape(optional));
      // If existing is object/array, leave it as the more specific shape.
      // Required wins over optional: if the field was previously required,
      // keep it required even if this reference is conditional.
      else if (existing.optional && !optional) existing.optional = false;
      return;
    }
    if (!existing || existing.kind === "any") {
      const next = { kind: "object" as const, fields: new Map<string, Shape>(), optional };
      cursor.set(key, next);
      cursor = next.fields;
    } else if (existing.kind === "object") {
      if (existing.optional && !optional) existing.optional = false;
      cursor = existing.fields;
    } else {
      const el = existing.element;
      if (el.kind !== "object") {
        existing.element = objShape();
      }
      cursor = (existing.element as { fields: Map<string, Shape> }).fields;
    }
  }
}

/** Mark a path as an array root (used by {{#each items}}). Returns the
 *  array's element shape so the caller can keep adding required fields. */
function addArrayPath(root: Shape, path: string[], optional = false): Shape {
  if (root.kind !== "object" || path.length === 0) {
    return root;
  }
  let cursor = ensureObject(root);
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const existing = cursor.get(key);
    if (existing?.kind === "object") {
      cursor = existing.fields;
    } else {
      const next = { kind: "object" as const, fields: new Map<string, Shape>(), optional };
      cursor.set(key, next);
      cursor = next.fields;
    }
  }
  const last = path.at(-1)!;
  const existing = cursor.get(last);
  if (existing?.kind === "array") return existing.element;
  const arr: Shape = { kind: "array", element: anyShape(), optional };
  cursor.set(last, arr);
  return arr.element;
}

/**
 * Recursive walker. `scope` is the shape that `{{path}}` references attach
 * to (i.e. the current context as a Handlebars block would see it).
 * `optional` is true when we are inside an `{{#if}}` / `{{#unless}}` body
 * — paths added here aren't strictly required at the call-site.
 */
function walkProgram(program: unknown, scope: Shape, root: Shape, rootFields: string[], optional = false): void {
  if (!program) return;
  const body = (program as { body?: unknown[] }).body ?? [];
  for (const stmt of body) walkStatement(stmt, scope, root, rootFields, optional);
}

function pathParts(node: unknown): { parts: string[]; data: boolean } {
  const n = asNode(node);
  if (n.type !== "PathExpression") return { parts: [], data: false };
  return {
    parts: (n.parts as string[] | undefined) ?? [],
    data: Boolean(n.data),
  };
}

function trackRootField(scope: Shape, root: Shape, rootFields: string[], parts: string[]): void {
  if (scope === root && parts.length > 0 && !rootFields.includes(parts[0]!)) {
    rootFields.push(parts[0]!);
  }
}

function walkStatement(stmt: unknown, scope: Shape, root: Shape, rootFields: string[], optional = false): void {
  const n = asNode(stmt);
  switch (n.type) {
    case "MustacheStatement": {
      const { parts, data } = pathParts(n.path);
      if (data) return; // @index, @key, @first, etc.
      if (parts.length === 0) return;
      addPath(scope, parts, optional);
      trackRootField(scope, root, rootFields, parts);
      return;
    }
    case "BlockStatement": {
      const helperName = (asNode(n.path).original as string | undefined) ?? "";
      const blockArg = Array.isArray(n.params) ? n.params[0] : null;
      const { parts } = pathParts(blockArg);

      if (KNOWN_BLOCK_HELPERS.has(helperName) && parts.length > 0) {
        trackRootField(scope, root, rootFields, parts);
        if (helperName === "each") {
          const elementScope = addArrayPath(scope, parts, optional);
          walkProgram(n.program, elementScope, root, rootFields, optional);
          if (n.inverse) walkProgram(n.inverse, scope, root, rootFields, optional);
          return;
        }
        if (helperName === "with") {
          addPath(scope, parts, optional);
          let cursor: Shape = scope;
          for (const seg of parts) {
            if (cursor.kind !== "object") {
              const made = objShape(optional);
              cursor = made;
              continue;
            }
            const next = cursor.fields.get(seg);
            if (next) {
              cursor = next;
            } else {
              const made = objShape(optional);
              cursor.fields.set(seg, made);
              cursor = made;
            }
          }
          walkProgram(n.program, cursor, root, rootFields, optional);
          if (n.inverse) walkProgram(n.inverse, scope, root, rootFields, optional);
          return;
        }
        // #if / #unless: the gated path is optional, and so is every path
        // mentioned inside the body — at render time, the body only fires
        // when the gate is truthy, so its references are conditional.
        addPath(scope, parts, true);
        walkProgram(n.program, scope, root, rootFields, true);
        if (n.inverse) walkProgram(n.inverse, scope, root, rootFields, true);
        return;
      }
      // Unknown helper — best effort: treat params as required paths in scope.
      for (const p of (n.params as unknown[]) ?? []) {
        const { parts: pp, data } = pathParts(p);
        if (!data && pp.length > 0) {
          addPath(scope, pp, optional);
          trackRootField(scope, root, rootFields, pp);
        }
      }
      walkProgram(n.program, scope, root, rootFields, optional);
      if (n.inverse) walkProgram(n.inverse, scope, root, rootFields, optional);
      return;
    }
    default:
      return;
  }
}

export function analyzeTemplate(source: string): TemplateInfo {
  const ast = Handlebars.parse(source);
  const root: Shape = objShape();
  const rootFields: string[] = [];
  walkProgram(ast, root, root, rootFields);
  return {
    shape: root,
    rootFields,
    singleVarName: rootFields.length === 1 ? rootFields[0]! : null,
  };
}

// ── runtime validator ──────────────────────────────────────────────────

export interface ValidationOk {
  ok: true;
}
export interface ValidationErr {
  ok: false;
  message: string;
}

/**
 * Verify `value` satisfies the required `shape`. Errors return a human-
 * readable path (e.g. `user.name`, `items[2].name`).
 */
export function validateShape(shape: Shape, value: unknown, path = ""): ValidationOk | ValidationErr {
  // Optional + absent → no constraint. Optional + present still must match
  // the inner shape (e.g. if the field is supplied, an array stays an array).
  if (value === undefined && shape.optional) return { ok: true };
  if (shape.kind === "any") {
    if (value === undefined) return err(path || "(root)", "is missing");
    return { ok: true };
  }
  if (shape.kind === "array") {
    if (!Array.isArray(value)) return err(path || "(root)", `expected array, got ${typeName(value)}`);
    for (let i = 0; i < value.length; i++) {
      const r = validateShape(shape.element, value[i], `${path || "(root)"}[${i}]`);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return err(path || "(root)", `expected object, got ${typeName(value)}`);
  }
  for (const [key, sub] of shape.fields) {
    const child = (value as Record<string, unknown>)[key];
    const r = validateShape(sub, child, path ? `${path}.${key}` : key);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/**
 * Failsafe coercion, applied before validation/render: a field whose template
 * shape is `array` but whose value is nil-like (per `isNilLike`) becomes `[]`.
 *
 * The gap it closes is cross-language: a NON-empty scheme list crosses the rosetta
 * membrane as a JS array, but an EMPTY one crosses as `nil` (in scheme, the empty
 * list and nil are the same entity), so `toJS` can't know to make it `[]`.
 * Without this, `{{#each xs}}` over a legitimately-empty collection fails the
 * array check instead of rendering nothing. Recurses into object fields and array
 * elements; a non-nil wrong-typed value is left untouched for `validateShape` to
 * report (so real mistakes still surface).
 */
export function coerceShape(shape: Shape, value: unknown, isNilLike: (v: unknown) => boolean): unknown {
  if (shape.kind === "array") {
    if (isNilLike(value)) return [];
    if (Array.isArray(value)) return value.map((el) => coerceShape(shape.element, el, isNilLike));
    return value;
  }
  if (shape.kind === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, sub] of shape.fields) out[key] = coerceShape(sub, out[key], isNilLike);
    return out;
  }
  return value;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function err(path: string, msg: string): ValidationErr {
  return { ok: false, message: `${path} ${msg}` };
}
