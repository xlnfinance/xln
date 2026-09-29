// compile-host — the diagnose lens's virtual-program compile (diagnose.ts).
//
// Builds a throwaway `ts.Program` over a single in-memory probe file against the real
// `lib.es2022.d.ts` (strict, skipLibCheck). `createDiagnoseLens` reads
// `getSemanticDiagnostics` off this program.

import * as ts from "typescript";

/** Type-check one in-memory probe file against the real lib, keeping the program + checker.
 *  Returns `null` when the source file fails to materialize (corrupt probe / host failure). */
export function compile(
  source: string,
): { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile } | null {
  const fileName = "/__query.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreate);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => (name === fileName ? source : readFile(name));

  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName);
  if (sourceFile === undefined) return null;
  return { program, checker: program.getTypeChecker(), sourceFile };
}
