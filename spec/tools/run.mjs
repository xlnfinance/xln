// Load spec files into one Arrival scope and evaluate an expression at the end.
// Shared by test.mjs and export-traces.mjs. Run from spec/.
import { execState, toJS, LexicalScope } from "../arrival/packages/arrival/dist/index.js";
import { overridableCapability } from "../arrival/packages/arrival/dist/env/overridable/overridable.js";
import { readFileSync } from "node:fs";

export const lib = ["lib/vocabulary.scm", "lib/check.scm"];

export const evaluate = async (files, expression) => {
  const scope = LexicalScope.fresh("spec");
  const source = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const { values } = await execState(`${source}\n${expression}`, { scope, capabilities: [overridableCapability] });
  return toJS(values.at(-1));
};
