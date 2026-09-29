// Consolidated bite guard for the whole builtin set.
//
// Each leaf's `<slug>.cases.ts` asserts its signature with expect-type:
//   • positives → `expectTypeOf(call).toEqualTypeOf<T>()` / `.toExtend<T>()` pin
//     the result type, so an arg-rot OR a return→any rot both bite; and
//   • negatives → `// @ts-expect-error` — if the signature rots so the line stops
//     erroring, the unused directive becomes the compile error.
//
// This runner compiles ONE program = PRE prelude + every leaf `.d.ts` + every
// `.cases.ts` (the file set of tsconfig.cases.json) and asserts zero diagnostics.
// That single-program composition proves two things across the whole fan-out:
//   1. all leaf ambient `declare function <encodeSchemeIdent(name)>…` coexist
//      in one global scope with no name collision, and
//   2. every case assertion holds (no signature silently regressed to `any`).
// The compiler is the assertion engine; there is no per-snippet string harness.

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..", "..");
const builtinsDir = path.join(here, "..", "prelude", "builtins");
const casesConfig = path.join(pkgRoot, "tsconfig.cases.json");

/** Parse tsconfig.cases.json and compile its file set into one program. */
function compileCasesProgram(): ts.Diagnostic[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    casesConfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    },
  );
  if (!parsed) throw new Error(`could not parse ${casesConfig}`);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return [...ts.getPreEmitDiagnostics(program)];
}

const fmt = (d: ts.Diagnostic): string => {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!d.file || d.start === undefined) return `TS${d.code}: ${msg}`;
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  return `${path.basename(d.file.fileName)}:${line + 1}:${character + 1} TS${d.code}: ${msg}`;
};

const leafFiles = readdirSync(builtinsDir).filter((f) => f.endsWith(".d.ts") && !f.startsWith("_"));
const caseFiles = readdirSync(builtinsDir).filter((f) => f.endsWith(".cases.ts"));
const diagnostics = compileCasesProgram();

describe("builtins — every leaf bites across the merged cases program", () => {
  it("found the full fan-out (every non-template leaf has a cases file)", () => {
    // The floor tracks the live-bound vocab count, not a round number: it drops
    // whenever a leaf's builtins are cut from the inference env, to keep the lens
    // a faithful mirror of what actually runs.
    expect(leafFiles.length).toBeGreaterThanOrEqual(43);
    expect(caseFiles.length).toBeGreaterThanOrEqual(43);
    const missing = leafFiles
      .map((f) => f.replace(".d.ts", ""))
      .filter((slug) => !caseFiles.includes(`${slug}.cases.ts`));
    expect(missing, `leaves without a .cases.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("the merged cases program compiles clean (no leaf regressed; no assertion failed)", () => {
    expect(diagnostics.map(fmt)).toEqual([]);
  });

  // Per-leaf surfacing: attribute each cases file's own diagnostics for a readable
  // failure, so a single rotted leaf names itself instead of dumping the whole set.
  for (const cf of caseFiles) {
    const slug = cf.replace(".cases.ts", "");
    it(`${slug}: assertions hold`, () => {
      const mine = diagnostics.filter((d) => d.file?.fileName.endsWith(`/${cf}`)).map(fmt);
      expect(mine, mine.join("\n")).toEqual([]);
    });
  }
});
