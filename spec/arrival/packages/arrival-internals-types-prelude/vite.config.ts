// vite build — the SELF-CONTAINED browser bundle.
//
// Build order (package.json `build`): tsc → vite build. tsc emits every entry's
// JS + all .d.ts into dist/; this build then OVERWRITES dist/browser.js (+ its
// .js.map) with a bundle in which Vite has already resolved the relative prelude
// `?raw` glob — the `.d.ts` text is INLINED, so no `import.meta.glob` / `?raw`
// specifier ever reaches a consumer's bundler (Vite 7 rejects bare-package globs
// outright). The `.` and `./virtual-files` entries are Node/isomorphic and stay
// pure tsc output; running `tsc --watch` (`dev`) regresses the bundle until the
// next full build.
//
// External vs inlined: relative modules (`./virtual-files`) bundle in; the
// `./prelude/**/*.d.ts?raw` TEXT must inline — that is the whole point. There are
// no bare runtime deps to externalize (this package has none).

import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false, // tsc output (types + the other entries) already lives here
    target: "esnext",
    minify: false,
    sourcemap: true, // overwrite tsc's browser.js.map alongside the JS
    lib: {
      entry: {
        browser: "src/browser.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      // Bare imports stay external — EXCEPT `?raw` asset text, which must inline.
      // Virtual modules (\0-prefixed) are Vite-internal, never external.
      external: (id) => !id.includes("?raw") && !id.startsWith(".") && !id.startsWith("\0") && !path.isAbsolute(id),
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
