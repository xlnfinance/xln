// Fixture capability — the SIMPLE arm: one verb, zero configuration. Loaded by the
// suite through the REAL channel (`--with <path>` on the built CLI), so it exercises
// specifier resolution + the instanceof identity check end-to-end.
import { EnvCapability } from "@inhuman.tools/arrival/capability";

export default EnvCapability.define("fixture/greet", {
  symbols: (symbol, sz) => ({
    // The smallest authorable verb for a plain .mjs fixture: no args, a plain JS
    // string return, crossed to a scheme string by the codec.
    greet: symbol.rosetta`greet: the smallest authorable verb`(
      { input: [], output: [sz.string] },
      () => "hello, world",
    ),
  }),
});
