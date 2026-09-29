import * as ts from "typescript";

/** We must keep `Symbol` (value) because computed properties like
 *  `[Symbol.iterator]()` are resolved through it in the lib files.
 *  (Historical: dropping it caused 93 internal errors.) */
export const KEEP_VALUES = new Set(["Symbol"]);

/** Strips top-level `var`/`function` declarations (except the ones in KEEP_VALUES).
 *  We only want the type side; the "empty barrel" contract for scheme. */
export function stripGlobalValues(name: string, text: string): string {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false);
  let out = "";
  let pos = 0;
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s) && !ts.isFunctionDeclaration(s)) continue;
    if (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => KEEP_VALUES.has(d.name.getText(sf))))
      continue;
    out += text.slice(pos, s.getFullStart());
    pos = s.getEnd();
  }
  return out + text.slice(pos);
}

/** Apply stripping to a list of lib names using a loader that returns the raw
 *  source for a given lib filename. Used by both Node (fs) and browser (glob)
 *  paths to produce identical support file maps. */
export function stripLibFiles(
  names: readonly string[],
  loader: (name: string) => string,
): readonly (readonly [string, string])[] {
  return names.map((name) => [name, stripGlobalValues(name, loader(name))] as const);
}
