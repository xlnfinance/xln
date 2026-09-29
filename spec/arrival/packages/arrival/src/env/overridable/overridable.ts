// arrival/overridable — `define/overridable`: plain define PLUS validation whose value the
// execution environment MAY override. Exposing that surface (CLI, API props, notebook
// fields, tool-call args) is the ENVIRONMENT'S job — this capability sees only
// `configuration.params` (its slice of the shared config bag).
//
// Runtime verb `overridable/resolve` (rosetta); macro is ergonomics:
//     (define/overridable city (s/string) "Berlin")
//       ⇒ (define city (overridable/resolve 'city (s/string) "Berlin"))
// Host override wins over in-form default; EITHER WAY type-lowers and parses — bad
// DEFAULT throws as loud as bad OVERRIDE. Direct call is fine: only reads OWN params.
//
// `type` is any s/* expression — same `tagToJsonSchema` + `z.fromJSONSchema` as wire schema
// (deps on arrival/schema). NOT in BASE_PACKS: config-bearing, assembled fresh per run.

import { z } from "zod";

import { TypeTagError } from "../../errors.js";
import { EnvCapability } from "../../common/capability.js";
import { toJS } from "../../membrane/rosetta.js";
import { stripOptionalSuffix, tagToJsonSchema } from "../../common/schema-tag.js";
import type { SchemeValue } from "../../values/types.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { schemaCapability } from "../schema/schema.js";

/** Lower a `define/overridable` type tag (an evaluated scheme value, already `toJS`'d
 *  into canonical JS tagged-list form) to the zod schema that validates a JS value against it.
 *  Routes through the ONE canonical lowering — `tagToJsonSchema` + `z.fromJSONSchema`, the same
 *  bridge the wire schema and HTTP validator use — so every tag the s/* DSL expresses is accepted,
 *  and a tag that can't become a real validator DOORS with the binding name, not silently. */
function lowerTag(jsTag: unknown, bindingName: string): z.ZodType {
  try {
    const json = tagToJsonSchema(jsTag);
    // `tagToJsonSchema` is deliberately LENIENT: an unrecognized shape falls through to `{}`
    // rather than throwing — correct for the wire-schema/HTTP projections, but `{}` lowers to a
    // permissive validator that would silently accept ANY override. So an empty lowering DOORS here.
    if (Object.keys(json).length === 0) throw new Error("tag lowered to an empty (unconstrained) schema");
    return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeTagError(bindingName, "unrecognized-tag", `${JSON.stringify(jsTag)} (${reason})`);
  }
}

function describeTag(jsTag: unknown): string {
  const stripped = stripOptionalSuffix(jsTag);
  if (typeof stripped === "string") return stripped;
  if (Array.isArray(stripped) && stripped[0] === "enum") return `one of ${JSON.stringify(stripped.slice(1))}`;
  return JSON.stringify(stripped);
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const overridableCapability = EnvCapability.define("arrival/overridable", {
  // config-less lower MUST succeed: a consumer assembling without params still gets the
  // capability, and every in-form default then fires, validated as an override would be.
  configuration: { params: z.record(z.string(), z.unknown()).default({}) },
  // s/* must be BOUND wherever overridable/resolve runs: define/overridable splices `type`
  // unquoted, so `(s/enum "a" "b")` is CALLED in the same env before the rosetta sees it.
  // Declaring the dep binds it wherever this capability is applied, root-set or not.
  deps: [schemaCapability],
  symbols: (symbol, sz) => ({
    "overridable/resolve":
      symbol.rosetta`overridable/resolve: resolves a parameter, preferring a host override over the form default (validated against the declared type)`(
        // `name` stays `sz.dynamic` (raw ASymbol), NOT `sz.symbol`: sz.symbol decodes to an
        // opaque host symbol whose toString is the wrapper description, not the bare name.
        // Errors name the binding via `.literal()`. The ONE legitimate rosetta `dynamic` use
        // in core — name/type/default cannot be typed (scheme-DSL type tags are arbitrarily
        // recursive raw scheme data, not a marshaled JS shape).
        {
          input: [sz.dynamic, sz.dynamic, sz.dynamic],
          output: [sz.dynamic],
          type: "(name: symbol, type: string|list, default: any): any",
        },
        function (nameSym, typeTag, defaultVal) {
          const bindingName = (nameSym as ASymbol).literal();
          const jsTag = toJS(typeTag as SchemeValue);
          const zodType = lowerTag(jsTag, bindingName);

          const hasOverride = Object.prototype.hasOwnProperty.call(this.configuration.params, bindingName);
          const raw = hasOverride ? this.configuration.params[bindingName] : toJS(defaultVal as SchemeValue);
          const source = hasOverride ? "an environment override" : "the in-form default";

          const outcome = zodType.safeParse(raw);
          if (!outcome.success) {
            throw new TypeTagError(bindingName, "value-mismatch", describeTag(jsTag), describeValue(raw), source);
          }
          // Raw JS return — the membrane boxes it (world-flip door forbids pre-boxing here;
          // it also means the mint runs under the CALL's ctx/provenance, not CONSTANT_CTX).
          return outcome.data;
        },
      ),
    // macroAttribute "binder", not "expression"/"opaque": `name` is a FORMALS position spliced
    // only into `(define ,name …)`, never read as a value — walking it as expression space would
    // flag the binding target `unbound-symbol` on every legal program. Unlike cut/cute's "opaque"
    // placeholders (consumed positionally, never in output), `name` genuinely BINDS. type/default
    // ARE expression space, but with no per-argument binding-aware walker yet the whole call is
    // firewalled like "opaque"; "binder" is the honest classification for when that walker lands.
    "define/overridable":
      symbol.defineSyntax`define/overridable: like plain \`define\`, but the environment MAY override the value — a host-supplied param (via configuration.params) wins over the in-form default, and BOTH validate against the declared type — (define/overridable name type default)`(
        `(lambda (name type default)
           \`(define ,name (overridable/resolve ',name ,type ,default)))`,
        { macroAttribute: "binder" },
      ),
  }),
});
