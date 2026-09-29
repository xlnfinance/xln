// symbol.taglessGuard — tagless dispatch with graceful #f when receiver has no method.
// Per-tag factory; shared types in ./_bake.js. docs/environments.md §SYMBOL-KINDS.

import * as z from "../scheme-zod/index.js";
import { CallCtx } from "../../run/CallCtx.js";
import { parseNameDoc, resolveMethod, type TaglessGuardSymbolDef } from "./_bake.js";
import { tf, type TaglessOp } from "../../values/tagless-final.js";
import { mintVerdict } from "../../values/op-helpers.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { type SchemeValue } from "../../values/types.js";

/** Tagless guard binder — free name (per-type predicate), not a closed algebra key.
 *  R8 mint (mintVerdict): out is representation-blind; capability binds run directly —
 *  this is the one boxing point for every taglessGuard predicate (P7: class is authority,
 *  wrap layer mints). */
export function taglessGuard(tpl: TemplateStringsArray, ...sub: unknown[]): ANativeProcedure {
  const { name, doc } = parseNameDoc(tpl, sub);
  // Same ctx-via-this dispatch as tagless; divergence: missing method → #f.
  const run = async function (this: CallCtx, ...args: readonly SchemeValue[]): Promise<SchemeValue> {
    const runCtx = this.runCtx;
    const schemeArgs = args;
    const receiver = schemeArgs.at(-1);
    const leading = schemeArgs.slice(0, -1);
    const fn = resolveMethod(receiver, tf(name as TaglessOp));
    if (fn === undefined) return mintVerdict([receiver], false);
    const verdict = await fn.call(receiver, ...leading, runCtx);
    return mintVerdict([receiver, ...leading], typeof verdict === "boolean" ? verdict : Boolean(verdict));
  };
  // No Contract param — always "pipe".
  return new ANativeProcedure({
    name,
    arity: { min: 0, max: null },
    contract: {
      kind: "tagless-guard",
      name,
      doc,
      in: z.array(z.schemeValue),
      out: z.schemeValue,
      run,
      provenance: "pipe",
    } satisfies TaglessGuardSymbolDef,
    impl: (args, callCtx) => run.call(callCtx, ...args),
    provenanceRole: "pipe",
  });
}
