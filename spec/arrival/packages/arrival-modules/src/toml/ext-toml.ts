// toml — the `.toml` file-type resolver as an opt-in capability.
//
// The twin of `ext-yaml.ts` (see its header for the whole story — the
// dep-isolation split AND the lost-in-translation recovery): this capability
// OWNS the `smol-toml` parser (optional peer), registers `.toml` by name at
// bootstrap, and returns the parse as a dict so a `.toml` require yields the
// same shape as its `.json` twin.
import { EnvCapability } from "@inhuman.tools/arrival/capability";
import { parse as parseToml } from "smol-toml";

import { arrivalLoaderCapability } from "../loader-capability.js";
import { contentsToText } from "../loader.js";

export const arrivalTomlCapability = EnvCapability.define("toml", {
  // Loader first in C3: prelude calls require/register-extension (preludeOnly on loader).
  deps: [arrivalLoaderCapability],
  symbols: (symbol, z) => ({
    "toml/parse": symbol.rosetta`toml/parse: parse .toml contents to a dict`(
      { input: [z.union([z.string, z.bytevector])], output: [z.dynamic] },
      (contents) => parseToml(contentsToText(contents)),
    ),
  }),
  // Bare symbol — `require/register-extension` is a MACRO (unevaluated resolver name).
  prelude: `(require/register-extension ".toml" toml/parse)`,
});
