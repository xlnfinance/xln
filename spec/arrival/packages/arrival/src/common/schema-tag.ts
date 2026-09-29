// schema-tag — the schema DSL's ONE canonical lowering: a tagged-list type tag (the shape
// `s/object`/`s/array`/`s/enum`/`s/optional`/`s/field*` build — see `env/schema/schema.ts`) → JSON
// Schema. Lives here (not in arrival-inference) because a CORE capability (`arrival/overridable`,
// `env/overridable/overridable.ts`) needs this exact lowering and cannot depend on `@here.build/llm-plane`
// without inverting the package DAG (core is upstream of inference, never the reverse) — this is
// the one place both core and inference can reach it. Three consumers — the OpenAI/Anthropic wire
// schema, the HTTP validator, and the `define/overridable` runtime validator — share exactly one
// recursion over the tag, so none can drift from the others.
//
// Per `env/schema/schema.ts`'s header, s/* is the language's explicit-type syntax; this file is its
// runtime/operational projection (the static projection is the type-layer/tsc bridge). A schema
// tag is a PROPOSITION — this is how it discharges as a validator.

import { SchemaFieldShapeError } from "../errors.js";

export type JsonSchema = Record<string, unknown>;

/**
 * The `/optional` compositor suffix (`s/string` vs `s/string/optional`). An EXPLICIT,
 * bounded suffix on a tag's HEAD — one recognised literal, not a generic split-on-"/"
 * parser. A second named suffix would get its own literal check beside this one.
 *
 * Only meaningful on an object FIELD's tag ({@link isOptionalTag}, read only in the
 * `"object"` case below) — a bare/nested tag has no "required" slot to drop. Everywhere
 * else `tagToJsonSchema` strips it unconditionally and lowers the base type, matching
 * this file's lenient posture toward shape it doesn't recognise (an unknown `kind` falls
 * through to `{}` rather than throwing). `invariant` stays reserved for structurally
 * malformed input (wrong-length field tuples), not an inert suffix.
 */
const OPTIONAL_SUFFIX = "/optional";

export function isOptionalTag(tag: unknown): boolean {
  if (typeof tag === "string") return tag.endsWith(OPTIONAL_SUFFIX);
  if (Array.isArray(tag) && tag.length > 0 && typeof tag[0] === "string") return tag[0].endsWith(OPTIONAL_SUFFIX);
  return false;
}

/** Strip the `/optional` compositor suffix from a tag's head, if present. Idempotent. */
export function stripOptionalSuffix(tag: unknown): unknown {
  if (typeof tag === "string") {
    return tag.endsWith(OPTIONAL_SUFFIX) ? tag.slice(0, -OPTIONAL_SUFFIX.length) : tag;
  }
  if (Array.isArray(tag) && tag.length > 0 && typeof tag[0] === "string" && tag[0].endsWith(OPTIONAL_SUFFIX)) {
    return [tag[0].slice(0, -OPTIONAL_SUFFIX.length), ...tag.slice(1)];
  }
  return tag;
}

/**
 * The SINGLE lowering from the schema DSL's tagged-list form to JSON Schema. Exported so every
 * consumer stays a thin wrapper over this one recursion (see the file header for the consumers and
 * the no-drift guarantee) rather than a second recursion that could drift from it.
 */
export function tagToJsonSchema(tag: unknown): JsonSchema {
  // `/optional` is only meaningful at an object-field position (handled below,
  // in the "object" case, BEFORE recursing here) — everywhere else it's inert:
  // strip it and lower the base type.
  tag = stripOptionalSuffix(tag);
  if (typeof tag === "string") return { type: tag };
  if (!Array.isArray(tag) || tag.length === 0) return {};
  const [kind, ...rest] = tag as [string, ...unknown[]];
  switch (kind) {
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const field of rest) {
        if (!Array.isArray(field) || (field.length !== 2 && field.length !== 3)) {
          throw new SchemaFieldShapeError();
        }
        const [name, type, description] = field as [string, unknown, string?];
        const schema = tagToJsonSchema(type); // strips the field's own `/optional` suffix internally
        if (description) schema.description = description;
        properties[name] = schema;
        if (!isOptionalTag(type)) required.push(name);
      }
      return { type: "object", properties, required, additionalProperties: false };
    }
    case "array":
      return { type: "array", items: tagToJsonSchema(rest[0]) };
    case "enum": {
      // Derive `type` from the values rather than hardcoding "string": a numeric enum
      // with type:"string" is internally inconsistent (the wire schema OpenAI/Anthropic
      // receive contradicts itself, and a spec-conformant validator rejects it).
      // All-strings ⇒ "string"; all-integers ⇒ "integer"; any non-integer number ⇒
      // "number"; mixed-kind drops `type` entirely (the `enum` constraint alone carries
      // the meaning).
      const type = enumValuesType(rest);
      return type === undefined ? { enum: rest } : { type, enum: rest };
    }
    default:
      return {};
  }
}

function enumValuesType(values: readonly unknown[]): "string" | "number" | "integer" | undefined {
  if (values.length > 0 && values.every((v) => typeof v === "string")) return "string";
  if (values.length > 0 && values.every((v) => typeof v === "number")) {
    return values.every((v) => Number.isInteger(v)) ? "integer" : "number";
  }
  return undefined; // empty or mixed: let `enum` alone constrain (no contradictory `type`)
}
