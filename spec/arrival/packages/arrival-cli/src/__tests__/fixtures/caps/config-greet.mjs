// Fixture capability — the CONFIG-GATED arm: `greeting` is a declared-OPTIONAL
// enabling key (the loader's `fs` pattern). Present ⇒ the verb binds; absent ⇒ the
// contract's `requiresConfig` auto-mints a cause-carrying door (D2, unconditional —
// degradation.ts's "doors" mode is the only mode now), which the static pass reports
// as the causal "provide `greeting`" diagnostic (bucket c, missing-configuration).
import { EnvCapability } from "@inhuman.tools/arrival/capability";
import { z } from "zod";

export const configGreetCapability = EnvCapability.define("fixture/config-greet", {
  configuration: {
    greeting: z.string().optional(),
  },
  symbols: (symbol, sz) => ({
    "greet/configured": symbol.rosetta`greet/configured: greets with the host-provided greeting`(
      { input: [], output: [sz.string], requiresConfig: ["greeting"] },
      function () {
        return `hello, ${this.configuration.greeting}`;
      },
    ),
  }),
});
