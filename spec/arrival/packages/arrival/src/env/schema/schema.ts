// arrival/schema — s/* type constructors: s/object, s/array, s/enum, s/optional,
// s/field, s/field/<type>. No config, no resources, no native verbs — every symbol is
// symbol.define (scheme-bodied).
//
// One type language, one lowering. Hand-rolled per-consumer scalar subsets drift from wire
// schema and HTTP validator — every overridable/hosted type tag goes through the SAME s/*
// vocabulary and the SAME tagToJsonSchema recursion (common/schema-tag.js).
//
// CORE, not "schema DSL for endpoints": s/* expressions are Curry-Howard propositions,
// discharging statically (type-layer bridge) and at runtime (zod). zod is one projection,
// not the definition.
//
// OUTSIDE BASE_PACKS (domain-specific): ordinary capability + overridable's dep, so (s/enum …)
// as a type tag resolves wherever overridable is applied.
//
// WIRE FORMAT (load-bearing): consumers read the TAGGED-LIST shape bodies produce — bare
// string, or ("object" …) / ("array" …) / ("enum" …). Bake validates via z.decode for
// throw-on-mismatch and DISCARDS the decoded value — original scheme value handed back.
// Over-approximate contracts; opaque-forward positions stay z.schemeValue.
//
// DEPS: cons/list, pair?/null?, string-append, =, error — every free name bodies reach.
// car/cdr need no edge (resolver-synth c[ad]+r).
import { EnvCapability } from "../../common/capability.js";
import lists from "../r7rs/lists.js";
import equality from "../r7rs/equality.js";
import strings from "../r7rs/strings.js";
import numeric from "../r7rs/numeric.js";
import exceptions from "../r7rs/exceptions.js";

// Type-tag shape: z.union([z.string, z.cons(z.string, z.schemeValue)]) — one level (what
// s/optional branches on). cdr stays z.schemeValue (arbitrarily recursive; no body reads past).
// Shared by s/optional and s/array element; s/field type/rest forward opaquely as z.schemeValue.
//
// DEPS ORDER: equality, numeric, exceptions, strings, lists — matches the partial order
// BASE_PACKS members already agree on (equality before numeric before exceptions before
// strings before lists last). Order is load-bearing: this capability C3-linearizes with the
// base roster in one closure walk (env/base-roster.ts).
export const schemaCapability = EnvCapability.define("arrival/schema", {
  deps: [equality, numeric, exceptions, strings, lists],
  symbols: (symbol, z) => {
    const tag = z.union([z.string, z.cons(z.string, z.schemeValue)]);
    // The s/field-shape output every s/field* body returns: two fixed heads (name, type) then a
    // string tail. Over-approximates (tolerates >1 trailing desc, none produced) rather than under —
    // never rejecting a value a body returns.
    const fieldShape = z.list([z.string, z.schemeValue], z.string);
    return {
      "s/object":
        symbol.define`s/object: an object type tag from field-tag entries — (s/object (s/field name type)...)`(
          { input: z.array(z.schemeValue), output: [z.list([z.string], z.schemeValue)] },
          `(lambda fields (cons "object" fields))`,
        ),

      "s/array": symbol.define`s/array: an array type tag whose elements are all shaped by element — (s/array tag)`(
        { input: [tag], output: [z.list([z.string, z.schemeValue])] },
        `(lambda (element) (list "array" element))`,
      ),

      "s/enum": symbol.define`s/enum: an enum type tag over the given literal values — (s/enum value...)`(
        { input: z.array(z.schemeValue), output: [z.list([z.string], z.schemeValue)] },
        `(lambda values (cons "enum" values))`,
      ),

      // The `/optional` compositor: marks a tag's HEAD so the object-field lowering
      // (tagToJsonSchema) drops that field from `required`. Composes onto ANY tag, bare ("string"
      // → "string/optional") or list-headed (("enum" …) → ("enum/optional" …)) — one bounded
      // suffix, not a chain. Meaningful only on an object field's tag.
      "s/optional": symbol.define`s/optional: mark a tag's head /optional — meaningful only on an object field's tag`(
        { input: [tag], output: [tag] },
        `(lambda (tag)
         (if (pair? tag)
             (cons (string-append (car tag) "/optional") (cdr tag))
             (string-append tag "/optional")))`,
      ),

      "s/field": symbol.define`s/field: (name type [description]) — an object field entry for s/object`(
        { input: [z.string, z.schemeValue], inputRest: z.string, output: [fieldShape] },
        `(lambda (name type . desc)
         (if (null? desc) (list name type) (list name type (car desc))))`,
      ),

      // Top-level scalar constructors — leaf primitives spelled as s/* calls so a bare
      // "string"/"number"/"integer"/"boolean" literal never has to appear in authored code. Each
      // lowers to the SAME bare string tagToJsonSchema understands — authoring surface, not a new representation.
      "s/string": symbol.define`s/string: the "string" scalar type tag`(
        { input: [], output: [z.string] },
        `(lambda () "string")`,
      ),
      "s/number": symbol.define`s/number: the "number" scalar type tag`(
        { input: [], output: [z.string] },
        `(lambda () "number")`,
      ),
      "s/integer": symbol.define`s/integer: the "integer" scalar type tag`(
        { input: [], output: [z.string] },
        `(lambda () "integer")`,
      ),
      "s/boolean": symbol.define`s/boolean: the "boolean" scalar type tag`(
        { input: [], output: [z.string] },
        `(lambda () "boolean")`,
      ),

      "s/field/string": symbol.define`s/field/string: (s/field name "string" [description...]) shortcut`(
        { input: [z.string], inputRest: z.string, output: [fieldShape] },
        `(lambda (name . rest) (apply s/field (cons name (cons "string" rest))))`,
      ),
      "s/field/number": symbol.define`s/field/number: (s/field name "number" [description...]) shortcut`(
        { input: [z.string], inputRest: z.string, output: [fieldShape] },
        `(lambda (name . rest) (apply s/field (cons name (cons "number" rest))))`,
      ),
      "s/field/integer": symbol.define`s/field/integer: (s/field name "integer" [description...]) shortcut`(
        { input: [z.string], inputRest: z.string, output: [fieldShape] },
        `(lambda (name . rest) (apply s/field (cons name (cons "integer" rest))))`,
      ),
      "s/field/boolean": symbol.define`s/field/boolean: (s/field name "boolean" [description...]) shortcut`(
        { input: [z.string], inputRest: z.string, output: [fieldShape] },
        `(lambda (name . rest) (apply s/field (cons name (cons "boolean" rest))))`,
      ),

      "s/field/_composite":
        symbol.define`s/field/_composite: (name config) or (name desc config) — shared dispatcher for the composite s/field/<type> shortcuts`(
          { input: [z.string], inputRest: z.schemeValue, output: [fieldShape] },
          `(lambda (name . rest)
         (cond ((= (length rest) 1) (s/field name (car rest)))
               ((= (length rest) 2) (s/field name (cadr rest) (car rest)))
               (else (error "s/field/composite: expected (name config) or (name desc config)"))))`,
        ),

      "s/field/object":
        symbol.define`s/field/object: (s/field name (s/object ...)) / (s/field name description (s/object ...)) shortcut`(
          { input: z.array(z.schemeValue), output: [fieldShape] },
          `(lambda args (apply s/field/_composite args))`,
        ),
      "s/field/array":
        symbol.define`s/field/array: (s/field name (s/array ...)) / (s/field name description (s/array ...)) shortcut`(
          { input: z.array(z.schemeValue), output: [fieldShape] },
          `(lambda args (apply s/field/_composite args))`,
        ),
      "s/field/enum":
        symbol.define`s/field/enum: (s/field name (s/enum ...)) / (s/field name description (s/enum ...)) shortcut`(
          { input: z.array(z.schemeValue), output: [fieldShape] },
          `(lambda args (apply s/field/_composite args))`,
        ),
    };
  },
});
