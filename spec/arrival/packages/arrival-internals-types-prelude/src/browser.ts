// Browser prelude loader — the SAME `.d.ts` vocabulary as the Node disk loader
// (`./prelude.ts` `getPreludeFiles`), but baked in at THIS package's `vite build`
// via a relative eager `?raw` glob. Vite inlines the `.d.ts` text, so dist ships
// plain strings: no `import.meta.glob` / `?raw` specifier ever reaches a
// consumer's bundler (Vite 7 rejects bare-package globs outright; a RELATIVE glob
// next to the assets stays legal — which is why this loader lives HERE, beside
// `prelude/`, rather than in a consumer that would glob across a package edge).
import { PRELUDE_FILE } from "./virtual-files.js";

// Vite 7's eager-`?raw` glob yields `{ default: string }` modules unless told
// which binding to take — `import: "default"` makes the values plain strings.
const preludeModules = import.meta.glob("./prelude/**/*.d.ts", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/**
 * Build the virtual `.d.ts` file map from the vite-inlined prelude glob: the
 * shared PRE prelude under {@link PRELUDE_FILE} plus every builtin leaf under a
 * stable `__leaf_<slug>.d.ts` key (excluding the `_TEMPLATE`/underscore scaffolds).
 * The browser twin of `getPreludeFiles`; same keys, same content, no `node:fs`.
 */
export const getBundledPreludeFiles = (): Map<string, string> => {
  const map = new Map<string, string>();

  // Main PRE (use the exported constant for the key).
  const preKey = Object.keys(preludeModules).find((k) => k.includes("prelude/types.d.ts"));
  if (preKey && preludeModules[preKey]) {
    map.set(PRELUDE_FILE, preludeModules[preKey]);
  }

  // Builtin leaves — keys are the glob's relative paths; tolerate a `?raw` suffix
  // (older Vite key shapes) so the guard is on CONTENT, not Vite's key cosmetics.
  for (const [key, content] of Object.entries(preludeModules)) {
    const match = /builtins\/([^/]+)\.d\.ts(?:\?raw)?$/.exec(key);
    if (match) {
      const f = match[1];
      if (!f.startsWith("_")) {
        map.set(`__leaf_${f}.d.ts`, content);
      }
    }
  }

  return map;
};

export { PRELUDE_FILE, PROGRAM_FILE } from "./virtual-files.js";
