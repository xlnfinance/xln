// Browser entry: same API as the Node one, but everything is baked in at THIS
// package's `vite build` time (no fs, no `ts.sys`). This keeps the "empty
// barrel" (no JS globals) contract identical to Node while staying
// self-contained for workers — dist/browser.js is a plain module: no
// `import.meta.glob`, no `?raw` specifiers survive into consumers.
//
// TS libs come from the generated explicit-`?raw` barrel (Vite 7 bans
// bare-package GLOBS like "typescript/lib/lib.*.d.ts" everywhere; bare `?raw`
// IMPORTS stay legal and get inlined by the lib build). The prelude glob below
// is relative — Vite-legal — and inlines the same way.
//
// skipLibCheck is on by default — re-checking the stock libs on every keystroke
// buys nothing.

import {
  createSchemeLanguageServiceCore,
  type SchemeLanguageService,
  type SchemeLanguageServiceOptions,
} from "./service-core.js";
import { getBundledPreludeFiles } from "@inhuman.tools/arrival-internals-types-prelude/browser";

import { stripLibFiles } from "./ts-lib-strip.js";
import { TS_LIB_RAW } from "./ts-libs-raw.generated.js";
import { TS_DEFAULT_LIB, TS_LIB_FILE_NAMES } from "./ts-libs.generated.js";

function getRawForLib(name: string): string {
  // The manifest and the barrel are two generated artifacts — guard their
  // drift at runtime.
  if (!(name in TS_LIB_RAW))
    throw new Error(`[arrival-lsp] missing bundled ?raw for ${name} (fix: pnpm generate:bundles)`);
  return TS_LIB_RAW[name];
}

const TS_LIB_FILES = stripLibFiles(TS_LIB_FILE_NAMES, getRawForLib);

export type {
  SchemeDiagnostic,
  SchemeQuickInfo,
  SchemeClassifiedSpan,
  SchemeCompletionEntry,
  SchemeRichCompletion,
  SchemeCompletionContext,
  SchemeDefinition,
  SchemeLanguageService,
  SchemeLanguageServiceOptions,
} from "./service-core.js";

// The prelude `.d.ts` vocabulary is loaded from the type-prelude package's
// browser entry — a Vite-inlined `?raw` glob baked in at THAT package's build, so
// no glob/`?raw` specifier survives here. Its Node twin (`getPreludeFiles`, disk)
// backs the fs-based service; both are guarded to agree in the prelude package.

export const createBrowserSchemeLanguageService = (opts?: SchemeLanguageServiceOptions): SchemeLanguageService =>
  createSchemeLanguageServiceCore(
    {
      rootFiles: getBundledPreludeFiles(),
      supportFiles: new Map(TS_LIB_FILES),
      // The compilation's `lib: ["lib.es2022.d.ts"]` entries resolve relative to
      // this file's directory — bare names against the bare-keyed map.
      getDefaultLibFileName: () => TS_DEFAULT_LIB,
    },
    {
      ...opts,
      compilerOptions: { skipLibCheck: true, ...opts?.compilerOptions },
    },
  );

export { scanRequires, type RequireRef } from "./service-core.js";

export { TS_LIB_FILES }; // for the coherence test
