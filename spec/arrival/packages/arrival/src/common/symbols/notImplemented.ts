// symbol.notImplemented — omitted verb (errors-as-doors). Permanent purity omission (empty needs).
// docs/environments.md §SYMBOL-KINDS, §DEGRADATION.

import { parseNameDoc, type DoorSymbolDef } from "./_bake.js";
import { DoorProcedure } from "../../values/primitives/ACallable.js";

/** Errors-as-doors — teaching reason only. Factory cannot stamp DoorCause (runs inside symbols
 *  literal before EnvCapability exists); capability.ts door bind arm stamps `.door.cause`. */
export function notImplemented(tpl: TemplateStringsArray, ...sub: unknown[]): DoorProcedure {
  const { name, doc } = parseNameDoc(tpl, sub);
  const def: DoorSymbolDef = { kind: "door", name, reason: doc ?? "" };
  return new DoorProcedure(def);
}
