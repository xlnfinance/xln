// Drift guard — the two prelude loaders must agree byte-for-byte.
//
// `getPreludeFiles()` reads the `.d.ts` vocabulary off disk (`node:fs`, Node
// hosts); `getBundledPreludeFiles()` returns the SAME map from Vite's inlined
// `?raw` glob (browser hosts). They are twin materializers of one asset set — if
// they diverge, a browser consumer silently type-checks against a stale prelude.
// Vitest transforms `import.meta.glob` here, so this bites in-source (no build).
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).
import { describe, expect, it } from "vitest";

import { getBundledPreludeFiles } from "../browser.js";
import { getPreludeFiles } from "../prelude.js";

describe("prelude loaders — drift guard", () => {
  it("the browser glob map matches the on-disk map byte-for-byte", () => {
    expect(Object.fromEntries(getBundledPreludeFiles())).toEqual(Object.fromEntries(getPreludeFiles()));
  });
});
