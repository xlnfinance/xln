// symbol.tagless — no impl; dispatch to operand's tagless-final method (receiver = last
// scheme arg; missing method THROWS). Per-tag factory; shared types in ./_bake.js.
// docs/environments.md §SYMBOL-KINDS. Algebra on terms (AValue) is the source of truth.

import * as z from "../scheme-zod/index.js";
import { CallCtx } from "../../run/CallCtx.js";
import { parseNameDoc, resolveMethod, type TaglessSymbolDef } from "./_bake.js";
import { tf, type TaglessOp } from "../../values/tagless-final.js";
import { attachOffendingValue, TaglessProtocolError } from "../../errors.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { AValue } from "../../values/primitives/AValue.js";
import { type SchemeValue } from "../../values/types.js";

/** Receiver description for type-mismatch error. Local to this factory's door. */
function describeReceiver(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof AValue) return v.kind;
  return Array.isArray(v) ? "array" : typeof v;
}

/** Tagless host op — dispatches to receiver's `arrival/tagless-final/name`. Missing method throws. */
export function tagless(tpl: TemplateStringsArray, ...sub: unknown[]): ANativeProcedure {
  const { name, doc } = parseNameDoc(tpl, sub);
  // function, not arrow: needs CallCtx via `this` for runCtx.
  const run = async function (this: CallCtx, ...args: readonly SchemeValue[]): Promise<SchemeValue> {
    const runCtx = this.runCtx;
    const schemeArgs = args;
    const receiver = schemeArgs.at(-1);
    const leading = schemeArgs.slice(0, -1);
    // Free author string cast to TaglessOp at this boundary; typo just resolves no method.
    const fn = resolveMethod(receiver, tf(name as TaglessOp));
    // Model-reachable door — plain throw, not invariant (would read like an engine bug).
    if (fn === undefined) {
      throw attachOffendingValue(
        new TaglessProtocolError(name, describeReceiver(receiver), tf(name as TaglessOp)),
        receiver,
      );
    }
    // @ts-expect-error tagless-final is complicated
    return fn.call(receiver, ...leading, runCtx);
  };
  // No Contract param, provenance always pipe; acc-chain via withCallbackRoles.
  return new ANativeProcedure({
    name,
    arity: { min: 0, max: null },
    contract: {
      kind: "tagless",
      name,
      doc,
      in: z.array(z.schemeValue),
      out: z.schemeValue,
      run,
      provenance: "pipe",
    } satisfies TaglessSymbolDef,
    impl: (args, callCtx) => run.call(callCtx, ...args),
    provenanceRole: "pipe",
  });
}
