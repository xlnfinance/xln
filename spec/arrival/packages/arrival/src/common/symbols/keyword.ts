// symbol.keyword — special form made first-class (evaluator-dispatched, aliasable, shadowable).
// docs/environments.md §SYMBOL-KINDS.

import { parseNameDoc } from "./_bake.js";
import { AKernelKeyword } from "../../values/AKernelKeyword.js";

/** Kernel keyword. Template is `name: doc`; mints AKernelKeyword; evaluator dispatches SPECIAL_FORMS[name]. */
export function keyword(tpl: TemplateStringsArray, ...sub: unknown[]): AKernelKeyword {
  const { name } = parseNameDoc(tpl, sub);
  return new AKernelKeyword(name);
}
