// symbol.macro — raw JS Macro/Syntax transformer bound as-is.
// docs/environments.md §SYMBOL-KINDS; preludeOnly is §PRELUDE.

import { Macro } from "../../eval/Macro.js";
import { type MacroSymbolDef } from "./_bake.js";

export interface MacroFactoryOptions {
  /** Assembly-time-only binding — see MacroSymbolDef.preludeOnly. */
  readonly preludeOnly?: boolean;
}

/** Non-evaluating macro: name template + transformer. Optional preludeOnly routes to prelude overlay. */
export function macro(strings: TemplateStringsArray) {
  const name = strings[0]!;
  return (fn: ConstructorParameters<typeof Macro>[1], opts?: MacroFactoryOptions): MacroSymbolDef => ({
    kind: "macro",
    name,
    macro: new Macro(name, fn),
    preludeOnly: opts?.preludeOnly,
  });
}
