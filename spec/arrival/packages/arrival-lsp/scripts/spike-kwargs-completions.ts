// spike-kwargs-completions.ts — PHASE 0 GATE (throwaway).
//
// Question: when a kwargs tool ("required positionals then optional :keyword value"
// pairs) is typed as required-positionals + a trailing OPTIONS-OBJECT param, does
// the REAL TS language service's getCompletionsAtPosition narrow:
//   (a) a required positional slot → the param's enum/union values
//   (b) the keyword slot (cursor after `(fn "x" "y" :|`) → the OPTIONAL KEYWORD names
//   (c) a value slot after a keyword (cursor after `(fn "x" "y" :cuisine |`) → that
//       keyword's value type/enum
//
// Two views, both over the REAL production stack:
//   • RAW view: a bare ts.LanguageService over emitTypes(scheme) + the host prelude
//     — shows the UNMERGED native completion set per TS offset (no scheme-merge).
//   • SERVICE view: createSchemeLanguageService(...).getCompletionContext — the
//     scheme-coordinate role + slot.paramType the lens actually reports.
//
// Run: cd arrival/packages/arrival-lsp && node_modules/.bin/tsx scripts/spike-kwargs-completions.ts

import { emitTypes } from "@inhuman.tools/arrival-types-bridge";
import ts from "typescript";

import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { getPreludeFiles } from "@inhuman.tools/arrival-internals-types-prelude";

import { assembleHostPrelude } from "../src/host-prelude.js";
import { createSchemeLanguageService } from "../src/language-service.js";
import { balancePrefix } from "../src/balance.js";
import { TS_DEFAULT_LIB, TS_LIB_FILE_NAMES } from "../src/ts-libs.generated.js";
import { stripGlobalValues } from "../src/ts-lib-strip.js";

function loadTsLibFilesForSpike() {
  const require = createRequire(import.meta.url);
  const tsLibDir = path.dirname(require.resolve("typescript"));
  return TS_LIB_FILE_NAMES.map(
    (name) => [name, stripGlobalValues(name, readFileSync(path.join(tsLibDir, name), "utf8"))] as const,
  );
}
const TS_LIB_FILES = loadTsLibFilesForSpike();

// ── the kwargs tool, as the BFCL find_restaurants shape ──────────────────────
// required: location, cuisine, max_results ; optional: dietary_requirements, operating_hours
// ENCODING UNDER TEST: required positionals stay positional; the optional tail is a
// single trailing OPTIONS-OBJECT param whose keys are the optional names (this is
// exactly how the emitter lowers `:k v` pairs — emitArgs → `{ k: v }`).
const HOST_PRELUDE_PREAMBLE = `
type Cuisine = "thai" | "italian" | "mexican";
type Diet = "vegan" | "halal" | "kosher";
interface FindRestaurantsOpts {
  dietary_requirements?: Diet[];
  operating_hours?: number;
}
`.trim();

// The function signature tail (interface-method form, the assembleHostPrelude contract):
//   (location: string, cuisine: Cuisine, max_results: number, opts?: FindRestaurantsOpts): SStr
const FN_TYPE = "(location: string, cuisine: Cuisine, max_results: number, opts?: FindRestaurantsOpts): SStr";

const HOST = assembleHostPrelude([["find_restaurants", FN_TYPE]], { preamble: HOST_PRELUDE_PREAMBLE });

// ── RAW VIEW: a bare ts.LanguageService over the emitted TS + host prelude ─────
// Mirrors createSchemeLanguageServiceCore's host, minus the scheme-merge — so we
// read native completions DIRECTLY at a TS offset.

const PROGRAM_FILE = "__program.ts";

function buildRawService(): {
  completionsAt: (tsText: string, tsOffset: number) => string[];
  set: (tsText: string) => void;
} {
  const preludeFiles = getPreludeFiles();
  preludeFiles.set("__host.d.ts", HOST.prelude);
  const supportFiles = new Map(TS_LIB_FILES);
  let programText = "export {};\n";
  let version = 0;
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
    skipLibCheck: false,
  };
  const inMem = (fn: string): string | undefined => preludeFiles.get(fn) ?? supportFiles.get(fn);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...preludeFiles.keys(), PROGRAM_FILE],
    getScriptVersion: (fn) => (fn === PROGRAM_FILE ? String(version) : "1"),
    getScriptSnapshot: (fn) =>
      fn === PROGRAM_FILE
        ? ts.ScriptSnapshot.fromString(programText)
        : inMem(fn) === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(inMem(fn)!),
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => TS_DEFAULT_LIB,
    fileExists: (fn) => fn === PROGRAM_FILE || inMem(fn) !== undefined,
    readFile: (fn) => (fn === PROGRAM_FILE ? programText : inMem(fn)),
    readDirectory: () => [],
    directoryExists: () => false,
    getDirectories: () => [],
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const set = (tsText: string): void => {
    programText = tsText;
    version += 1;
  };
  return {
    set,
    completionsAt: (tsText, tsOffset) => {
      set(tsText);
      const c = service.getCompletionsAtPosition(PROGRAM_FILE, tsOffset, undefined);
      return (c?.entries ?? []).map((e) => e.name);
    },
  };
}

// emitTypes references __arr/sexpr/Dict; those resolve from the __pre.d.ts ROOT
// file already in the RAW service's prelude map — so we do NOT prepend PRE to the
// program text (that would re-declare them). The program text is the emitted TS
// as-is, and TS offsets are into THAT text.
const raw = buildRawService();

function banner(s: string): void {
  console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
}

// ── Show the emitted TS for a full kwargs call (so we SEE the options-object) ──
banner("EMITTED TS — full kwargs call shape");
{
  const full = `(find_restaurants "x" "y" 5 :dietary_requirements (list vegan) :operating_hours 23)`;
  const { ts: emitted } = emitTypes(full, { hostMembers: new Set(HOST.members) });
  console.log(`scheme: ${full}`);
  console.log(`emitted TS:\n${emitted}`);
}

// ── RAW probes at hand-placed TS offsets ──────────────────────────────────────
// We construct the emitted TS for a balanced prefix and place the cursor inside.
banner("RAW NATIVE COMPLETIONS (bare ts.LanguageService — UNMERGED)");

function rawProbe(label: string, tsBody: string, marker: string): void {
  // tsBody contains `/*HERE*/` marking the cursor; strip it, compute the offset.
  // __arr/sexpr resolve from the __pre.d.ts ROOT file, so the program text is the
  // bare TS body and the offset is into THAT text.
  const tsOffset = tsBody.indexOf(marker);
  const tsText = tsBody.replace(marker, "");
  const names = raw.completionsAt(tsText, tsOffset);
  // Report only the SHORT/relevant entries (filter the JS-global noise for readability).
  const interesting = names.filter((n) =>
    [
      "thai",
      "italian",
      "mexican",
      "vegan",
      "halal",
      "kosher",
      "dietary_requirements",
      "operating_hours",
      "location",
      "cuisine",
      "max_results",
    ].includes(n),
  );
  console.log(`\n[${label}]`);
  console.log(`  total native entries: ${names.length}`);
  console.log(`  RELEVANT entries present: ${JSON.stringify(interesting.sort())}`);
}

// (a) positional slot — cursor at the `cuisine` (2nd positional) value position.
//     Emitted: find_restaurants("x", /*HERE*/, 5)
rawProbe("(a) positional cuisine value slot", `find_restaurants("x", /*HERE*/, 5);`, "/*HERE*/");

// (b) keyword slot — cursor at the OBJECT-LITERAL MEMBER position (the kwarg keys).
//     Emitted: find_restaurants("x", "thai", 5, { /*HERE*/ })
rawProbe("(b) keyword (object-member) slot", `find_restaurants("x", "thai", 5, { /*HERE*/ });`, "/*HERE*/");

// (c) value-after-keyword — cursor at the kwarg VALUE position.
//     Emitted: find_restaurants("x", "thai", 5, { dietary_requirements: /*HERE*/ })
rawProbe(
  "(c) value-after-keyword (dietary_requirements value)",
  `find_restaurants("x", "thai", 5, { dietary_requirements: /*HERE*/ });`,
  "/*HERE*/",
);

// also: operating_hours value (a number — should be free-form, no enum to list)
rawProbe(
  "(c2) value-after-keyword (operating_hours value, free-form number)",
  `find_restaurants("x", "thai", 5, { operating_hours: /*HERE*/ });`,
  "/*HERE*/",
);

// ── SERVICE VIEW: the scheme-coordinate getCompletionContext the lens reports ─
banner("SCHEME-LEVEL getCompletionContext (the lens's actual answer)");

const ls = createSchemeLanguageService({ host: HOST });

function svcProbe(label: string, schemePrefix: string): void {
  const balanced = balancePrefix(schemePrefix);
  const ctx = ls.getCompletionContext(balanced, schemePrefix.length);
  console.log(`\n[${label}]`);
  console.log(`  scheme prefix: ${JSON.stringify(schemePrefix)}`);
  console.log(`  position: ${ctx.position}`);
  console.log(`  slot: ${JSON.stringify(ctx.slot)}`);
}

// (a) positional cuisine slot — after first positional, mid 2nd.
svcProbe("(a) positional slot — 2nd positional", `(find_restaurants "x" `);
// (b) keyword slot — after the required positionals, model typed `:`
svcProbe("(b) keyword slot — after required, at `:`", `(find_restaurants "x" "thai" 5 :`);
// (c) value-after-keyword
svcProbe("(c) value-after-keyword", `(find_restaurants "x" "thai" 5 :dietary_requirements `);

// ── WRINKLE: the emitter cleanName's keyword keys (snake→camel). Does the model's
//    `:dietary_requirements` round-trip to an interface key, and what must the
//    interface key SPELLING be? Test BOTH interface spellings end-to-end. ───────
banner("ROUND-TRIP — emitted kwarg key spelling vs interface key spelling");

function diagnose(hostPrelude: string, members: string[], scheme: string): { count: number; messages: string[] } {
  const ls2 = createSchemeLanguageService({ host: { prelude: hostPrelude, members } });
  const diags = ls2.getSemanticDiagnostics(scheme);
  return { count: diags.length, messages: diags.map((d) => `${d.code}: ${d.messageText}`) };
}

const SCHEME_FULL = `(find_restaurants "x" "thai" 5 :dietary_requirements (list vegan) :operating_hours 23)`;

// SNAKE-case interface keys (what BFCL param names are):
const snakeHost = assembleHostPrelude([["find_restaurants", FN_TYPE]], { preamble: HOST_PRELUDE_PREAMBLE });
console.log(`\n[snake_case interface keys] scheme: ${SCHEME_FULL}`);
console.log(`  emitted kwarg keys are cleanName'd → dietaryRequirements/operatingHours`);
{
  const r = diagnose(snakeHost.prelude, snakeHost.members, SCHEME_FULL);
  console.log(`  diagnostics: ${r.count}`);
  for (const m of r.messages) console.log(`    ${m}`);
}

// CAMEL-case interface keys (matching the emitter's cleanName output):
const CAMEL_PREAMBLE = `
type Cuisine = "thai" | "italian" | "mexican";
type Diet = "vegan" | "halal" | "kosher";
interface FindRestaurantsOpts {
  dietaryRequirements?: Diet[];
  operatingHours?: number;
}
`.trim();
const camelHost = assembleHostPrelude([["find_restaurants", FN_TYPE]], { preamble: CAMEL_PREAMBLE });
console.log(`\n[camelCase interface keys] scheme: ${SCHEME_FULL}`);
{
  const r = diagnose(camelHost.prelude, camelHost.members, SCHEME_FULL);
  console.log(`  diagnostics: ${r.count}`);
  for (const m of r.messages) console.log(`    ${m}`);
}

// And: what does the keyword-slot completion list under EACH spelling? (the names
// the model would have to type — must be the SCHEME `:keyword`, i.e. snake.)
banner("KEYWORD-SLOT completion labels under each interface spelling");
function rawKwKeys(preamble: string): string[] {
  const h = assembleHostPrelude([["find_restaurants", FN_TYPE]], { preamble });
  const preludeFiles = getPreludeFiles();
  preludeFiles.set("__host.d.ts", h.prelude);
  const supportFiles = new Map(TS_LIB_FILES);
  let programText = "export {};\n";
  let version = 0;
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
    skipLibCheck: false,
  };
  const inMem = (fn: string): string | undefined => preludeFiles.get(fn) ?? supportFiles.get(fn);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...preludeFiles.keys(), PROGRAM_FILE],
    getScriptVersion: (fn) => (fn === PROGRAM_FILE ? String(version) : "1"),
    getScriptSnapshot: (fn) =>
      fn === PROGRAM_FILE
        ? ts.ScriptSnapshot.fromString(programText)
        : inMem(fn) === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(inMem(fn)!),
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => TS_DEFAULT_LIB,
    fileExists: (fn) => fn === PROGRAM_FILE || inMem(fn) !== undefined,
    readFile: (fn) => (fn === PROGRAM_FILE ? programText : inMem(fn)),
    readDirectory: () => [],
    directoryExists: () => false,
    getDirectories: () => [],
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const body = `find_restaurants("x", "thai", 5, {  });`;
  programText = body;
  version += 1;
  const offset = body.indexOf("{ ") + 2;
  const c = service.getCompletionsAtPosition(PROGRAM_FILE, offset, undefined);
  return (c?.entries ?? []).map((e) => e.name).filter((n) => !n.startsWith("__"));
}
console.log(`  snake interface → keyword labels: ${JSON.stringify(rawKwKeys(HOST_PRELUDE_PREAMBLE))}`);
console.log(`  camel interface → keyword labels: ${JSON.stringify(rawKwKeys(CAMEL_PREAMBLE))}`);

banner("DONE — read (a)/(b)/(c) + round-trip above for the honest verdict");
