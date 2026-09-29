import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PRELUDE_FILE } from "./virtual-files.js";

// Resolve under shipped src/ (same logic as index.ts).
const here = path.dirname(fileURLToPath(import.meta.url));
const isDist = here.endsWith("dist") || here.includes(`dist${path.sep}`);
const srcRoot = isDist ? path.join(here, "..", "src") : here;
const preludeDir = path.join(srcRoot, "prelude");
const builtinsDir = path.join(preludeDir, "builtins");

export { PRELUDE_FILE, PROGRAM_FILE } from "./virtual-files.js";

/**
 * Build the virtual `.d.ts` file map the lens compilation needs: the shared PRE
 * prelude under {@link PRELUDE_FILE}, plus every builtin leaf (`builtins/*.d.ts`,
 * excluding the `_TEMPLATE`/underscore-prefixed scaffolds) under a stable
 * `__leaf_<slug>.d.ts` key. Does NOT include the program module — the language
 * service adds the emitted `__program.ts` on top.
 *
 * Returns a fresh `Map` each call so a caller may mutate it (e.g. add the program
 * file) without affecting another compilation.
 */
export function getPreludeFiles(): Map<string, string> {
  const entries: [string, string][] = [[PRELUDE_FILE, readFileSync(path.join(preludeDir, "types.d.ts"), "utf8")]];
  for (const f of readdirSync(builtinsDir)) {
    if (!f.endsWith(".d.ts") || f.startsWith("_")) continue;
    entries.push([`__leaf_${f}`, readFileSync(path.join(builtinsDir, f), "utf8")]);
  }
  return new Map(entries);
}
