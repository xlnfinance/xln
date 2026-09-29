// Node entry. Supplies disk prelude + direct `typescript` package libs
// (fs + strip). Keeps the exact same "empty barrel" world as the browser path.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { getPreludeFiles } from "@inhuman.tools/arrival-internals-types-prelude";

import {
  createSchemeLanguageServiceCore,
  type SchemeLanguageService,
  type SchemeLanguageServiceOptions,
} from "./service-core.js";
import { stripLibFiles } from "./ts-lib-strip.js";
import { TS_DEFAULT_LIB, TS_LIB_FILE_NAMES } from "./ts-libs.generated.js";

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
  ServiceEnvironment,
} from "./service-core.js";
export { createSchemeLanguageServiceCore, schemeifyTsText } from "./service-core.js";

// Direct from installed `typescript` (fs + strip) to match browser exactly.
function loadNodeTsLibFiles(): readonly (readonly [string, string])[] {
  const require = createRequire(import.meta.url);
  const tsLibDir = path.dirname(require.resolve("typescript"));
  return stripLibFiles(TS_LIB_FILE_NAMES, (name) => readFileSync(path.join(tsLibDir, name), "utf8"));
}

const TS_LIB_FILES = loadNodeTsLibFiles();

export function createSchemeLanguageService(opts?: SchemeLanguageServiceOptions): SchemeLanguageService {
  return createSchemeLanguageServiceCore(
    {
      rootFiles: getPreludeFiles(),
      supportFiles: new Map(TS_LIB_FILES),
      getDefaultLibFileName: () => TS_DEFAULT_LIB,
    },
    opts,
  );
}
