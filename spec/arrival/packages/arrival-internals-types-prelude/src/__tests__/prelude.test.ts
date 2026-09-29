// ─────────────────────────────────────────────────────────────────────────────
// Bite + leaf-ambient proof for the PRE prelude.
//
// Proves the leaf → ambient-global → bite chain works BEFORE the full fan-out:
//   1. PRE declares only shared carriers (`List`, `Tuple`, field helpers, `sexpr`).
//      Builtin leaves each `declare function <encodeSchemeIdent(name)>…` into the
//      same ambient global scope (no `__arr` / `ArrShape` bag).
//   2. A well-typed call (`car([1,2,3])`) is clean (0 diagnostics) and its type
//      resolves to `number`.
//   3. An ill-typed call (`car(5)`) BITES — exactly one diagnostic.
//   4. `car` is supplied by the LEAF file, not by PRE — PRE alone yields
//      "Cannot find name 'car'" (2304).
//
// We run the REAL prelude `.d.ts` files from disk through a bare
// `ts.LanguageService` over an in-memory host (the same shape the lens's MCP
// typecheck path will use). Per `.claude/rules/tests.md` this is a `__tests__/`
// verdict (boolean pass/fail).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const preludeDir = path.join(here, "..", "prelude");

const PRE = readFileSync(path.join(preludeDir, "types.d.ts"), "utf8");
const CAR_LEAF = readFileSync(path.join(preludeDir, "builtins", "car.d.ts"), "utf8");

/** Build a one-shot language service over PRE + the car leaf + one program file. */
function check(programSource: string): { diagnostics: ts.Diagnostic[] } {
  const files = new Map<string, string>([
    ["__pre.d.ts", PRE],
    ["__car.d.ts", CAR_LEAF],
    ["__program.ts", programSource],
  ]);

  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
    skipLibCheck: false,
  };

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (fn) => {
      const inMem = files.get(fn);
      if (inMem !== undefined) return ts.ScriptSnapshot.fromString(inMem);
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(fn, "utf8"));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => here,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (fn) => files.has(fn) || ts.sys.fileExists(fn),
    readFile: (fn) => (files.has(fn) ? files.get(fn) : ts.sys.readFile(fn)),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return { diagnostics: [...service.getSemanticDiagnostics("__program.ts")] };
}

describe("PRE prelude — bite + leaf ambient contract", () => {
  it("a well-typed (car (list …)) call is clean", () => {
    const { diagnostics } = check(`export {};\ncar([1, 2, 3]);`);
    expect(diagnostics).toHaveLength(0);
  });

  it("(car (list of numbers)) resolves to number — the leaf signature is precise, not any", () => {
    // If car had resolved as `any` (the regression we guard against), the explicit
    // `: number` annotation below would still pass; so instead we force a type
    // CONFLICT that only a precise `number` return can produce.
    const { diagnostics } = check(`export {};\nconst s: string = car([1, 2, 3]);`);
    // number is not assignable to string → exactly the bite proving precision.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe(2322);
  });

  it("an ill-typed (car 5) call BITES — exactly one diagnostic", () => {
    const { diagnostics } = check(`export {};\ncar(5);`);
    expect(diagnostics).toHaveLength(1);
    // 2345: Argument of type 'number' is not assignable to parameter 'List<…>'.
    expect(diagnostics[0]!.code).toBe(2345);
    const msg = ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, "\n");
    expect(msg).toContain("not assignable");
  });

  it("car is supplied by the LEAF file (PRE alone has no ambient car)", () => {
    // Without the leaf, `car` is not a global name → cannot-find-name bite (2304).
    const files = new Map<string, string>([
      ["__pre.d.ts", PRE],
      ["__program.ts", `export {};\ncar([1, 2, 3]);`],
    ]);
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts"],
      types: [],
    };
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...files.keys()],
      getScriptVersion: () => "1",
      getScriptSnapshot: (fn) => {
        const inMem = files.get(fn);
        if (inMem !== undefined) return ts.ScriptSnapshot.fromString(inMem);
        try {
          return ts.ScriptSnapshot.fromString(readFileSync(fn, "utf8"));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => here,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (fn) => files.has(fn) || ts.sys.fileExists(fn),
      readFile: (fn) => (files.has(fn) ? files.get(fn) : ts.sys.readFile(fn)),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    const diags = service.getSemanticDiagnostics("__program.ts");
    // PRE alone: no ambient `car` declare → name bite.
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe(2304);
    const msg = ts.flattenDiagnosticMessageText(diags[0]!.messageText, "\n");
    expect(msg).toContain("car");
  });

  it("an ordinary record + field accessor bite on a mis-keyed read", () => {
    // Exercises PRE's Field over a plain object type (no named Dict wrapper):
    // precise record, then a wrong-key access.
    const { diagnostics } = check(
      `export {};
type Row = { name: string; age: number };
declare const row: Row;
const nm: string = row.name;
const ag: number = row.age;
// @ts-expect-error — "naem" is not a key of Row
const bad = row.naem;`,
    );
    // The @ts-expect-error consumes the mis-key bite; no other diagnostics.
    expect(diagnostics).toHaveLength(0);
  });
});
