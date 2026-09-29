// symbol.value — host data constant bound by name (never a scheme call target).
// docs/environments.md §SYMBOL-KINDS.

import { parseNameDoc, type ValueSymbolDef } from "./_bake.js";
import { jsToScheme } from "../../membrane/rosetta.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import type { AmbientValue } from "../../env/AmbientRuntime.js";

/** Honest return: AmbientValue minus bare host functions (jsToScheme mints an ARosettaProcedure). */
type NonCallableAmbientValue = Exclude<AmbientValue, (...args: any[]) => any>;

/** Stamp def onto boxed's own `.contract` — non-enumerable, define-once (same slot every kind
 *  uses for contractOf / harvest presence).
 *  - Fresh box: stamp unconditionally (writable/configurable false).
 *  - Pre-boxed already contracted under same name: idempotent no-op.
 *  - Different name: throw — a value belongs to exactly one declaration.
 *  Primitive leaf (bigint) skips stamping — cannot carry a hidden property. */
function stampValueContract(boxed: unknown, def: ValueSymbolDef): void {
  if (typeof boxed !== "object" || boxed === null) return;
  const existing = (boxed as { contract?: unknown }).contract;
  if (existing === undefined) {
    Object.defineProperty(boxed, "contract", {
      value: def,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    return;
  }
  const existingName = (existing as { name?: unknown }).name;
  if (existingName !== def.name) {
    throw new Error(
      `symbol.value\`${def.name}\`: this value is already contracted under a different name ` +
        `("${String(existingName)}") — a value belongs to exactly ONE declaration; declare a ` +
        `fresh value for "${def.name}" instead of reusing an already-declared one.`,
    );
  }
}

/** Raw value binding. Boxes at define time through jsToScheme; stamps .contract.
 *  No nested value field — the box IS the value. */
export function value(tpl: TemplateStringsArray, ...sub: unknown[]): (v: unknown) => NonCallableAmbientValue {
  const { name, doc } = parseNameDoc(tpl, sub);
  const def: ValueSymbolDef = { kind: "value", name, doc };
  return (v: unknown): NonCallableAmbientValue => {
    const boxed = jsToScheme(CONSTANT_CTX, v) as AmbientValue;
    stampValueContract(boxed, def);
    return boxed as NonCallableAmbientValue;
  };
}
