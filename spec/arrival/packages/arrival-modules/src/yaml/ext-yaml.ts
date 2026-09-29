// yaml — the `.yaml`/`.yml` file-type resolver as an opt-in capability.
//
// The dep-bearing data formats are not on `@inhuman.tools/arrival-modules`'
// builtin table so the loader barrel carries no parser deps (per
// .claude/rules/env-quasi-packages.md — split to isolate an external
// dependency): this capability OWNS the `yaml` parser (optional peer) and
// registers its resolver by name at bootstrap; `require`'s by-name overlay
// resolves it. The value so `(require "personas.yaml")` yields a dict the
// same shape a `.json` require would.
import { EnvCapability } from "@inhuman.tools/arrival/capability";
import { parse as parseYaml } from "yaml";

import { arrivalLoaderCapability } from "../loader-capability.js";
import { contentsToText } from "../loader.js";

export const arrivalYamlCapability = EnvCapability.define("yaml", {
  // Loader first in C3: prelude calls require/register-extension (preludeOnly on loader).
  deps: [arrivalLoaderCapability],
  symbols: (symbol, z) => ({
    "yaml/parse": symbol.rosetta`yaml/parse: parse .yaml/.yml contents to a dict`(
      { input: [z.union([z.string, z.bytevector])], output: [z.dynamic] },
      (contents) => parseYaml(contentsToText(contents)),
    ),
  }),
  // Bare symbol — `require/register-extension` is a MACRO so the resolver name is
  // unevaluated (no String(fn) registry poison). Strings still work for compat.
  prelude: `
  (require/register-extension ".yaml" yaml/parse)
  (require/register-extension ".yml" yaml/parse)
`,
});
