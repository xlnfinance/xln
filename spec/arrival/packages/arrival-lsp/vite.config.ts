// vite build — the SELF-CONTAINED browser/worker bundles.
//
// Build order (package.json `build`): generate:bundles → tsc → vite build.
// tsc emits every entry's JS + all .d.ts into dist/; this build then
// OVERWRITES dist/browser.js and dist/worker.js (+ their .js.map) with
// bundles in which Vite has already resolved the `?raw` TS-lib imports and
// the relative prelude glob — the .d.ts text is INLINED, so no
// `import.meta.glob` / `?raw` specifier ever reaches a consumer's bundler
// (Vite 7 rejects the old bare-package glob outright). The other seven
// subpath entries are Node/isomorphic and stay pure tsc output; running
// `tsc --watch` (`dev`) regresses the two bundles until the next full build.
//
// External vs inlined adjudication:
//   • `typescript` the MODULE stays external — the service runs the real
//     compiler at runtime (createSchemeLanguageServiceCore uses `ts`); it is a
//     regular dependency the consumer's bundler resolves.
//   • `typescript/lib/*.d.ts?raw` TEXT must inline — that is the whole point.
//   • workspace deps (@inhuman.tools/arrival-sugarcoat, @inhuman.tools/arrival-types-bridge)
//     stay external like any bare import.
//   • relative modules (service-core, ls-server, …) bundle in; browser and
//     worker share hash-named chunks under dist/chunks/ (no collision with the
//     tsc-emitted flat files).

import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false, // tsc output (types + the other entries) already lives here
    target: "esnext",
    minify: false,
    sourcemap: true, // overwrite tsc's browser.js.map/worker.js.map alongside the JS
    lib: {
      entry: {
        browser: "src/browser.ts",
        worker: "src/worker.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      // Bare imports stay external — EXCEPT `?raw` asset text, which must
      // inline. Virtual modules (\0-prefixed) are Vite-internal, never external.
      external: (id) => !id.includes("?raw") && !id.startsWith(".") && !id.startsWith("\0") && !path.isAbsolute(id),
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
