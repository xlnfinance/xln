/** One TypeScript AST pass over production `core/` files of a snapshot: code lines, imports, functions, casts. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

type FunctionInfo = Readonly<{ name: string; line: number; codeLines: number; outer: boolean }>;

export type FileInfo = Readonly<{
  path: string;
  codeLines: number;
  valueImports: readonly string[];
  packages: readonly string[];
  functions: readonly FunctionInfo[];
  casts: number;
  nonNull: number;
  topNames: readonly string[];
}>;

type Accumulator = {
  valueImports: string[];
  packages: string[];
  functions: FunctionInfo[];
  casts: number;
  nonNull: number;
};
type VisitContext = Readonly<{
  snapshot: string;
  path: string;
  source: ts.SourceFile;
  mask: Uint8Array;
  acc: Accumulator;
}>;

export const isTestPath = (path: string): boolean =>
  /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.tsx?$/.test(path);

const walkTs = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walkTs(path);
      return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
    });

/** A line is code when at least one non-trivia token touches it, so comments and blank lines cost nothing. */
const codeLineMask = (source: ts.SourceFile, text: string): Uint8Array => {
  const mask = new Uint8Array(source.getLineAndCharacterOfPosition(text.length).line + 2);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const first = source.getLineAndCharacterOfPosition(scanner.getTokenStart()).line;
    const last = source.getLineAndCharacterOfPosition(scanner.getTokenEnd()).line;
    mask.fill(1, first, last + 1);
  }
  return mask;
};

const codeLinesIn = (mask: Uint8Array, first: number, last: number): number => {
  let count = 0;
  for (let line = first; line <= last; line += 1) count += mask[line] ?? 0;
  return count;
};

const clauseIsTypeOnly = (clause: ts.ImportClause | undefined): boolean => {
  if (!clause) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  const bindings = clause.namedBindings;
  if (clause.name || !bindings || !ts.isNamedImports(bindings) || bindings.elements.length === 0) return false;
  return bindings.elements.every(element => element.isTypeOnly);
};

const importSpec = (node: ts.Node): Readonly<{ spec: string; typeOnly: boolean }> | null => {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return { spec: node.moduleSpecifier.text, typeOnly: clauseIsTypeOnly(node.importClause) };
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return { spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly };
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const argument = node.arguments[0];
    if (argument && ts.isStringLiteral(argument)) return { spec: argument.text, typeOnly: false };
  }
  return null;
};

const resolveImport = (snapshot: string, from: string, spec: string): string | null => {
  const base = join(dirname(from), spec.replace(/\.js$/, ''));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  return (
    candidates.find(
      candidate =>
        /\.tsx?$/.test(candidate) &&
        existsSync(join(snapshot, candidate)) &&
        statSync(join(snapshot, candidate)).isFile(),
    ) ?? null
  );
};

const packageName = (spec: string): string =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec);

const recordImport = (context: VisitContext, node: ts.Node): void => {
  const found = importSpec(node);
  if (!found || found.typeOnly) return;
  if (!found.spec.startsWith('.')) {
    context.acc.packages.push(packageName(found.spec));
    return;
  }
  const resolved = resolveImport(context.snapshot, context.path, found.spec);
  if (resolved) context.acc.valueImports.push(resolved);
};

const isCast = (node: ts.Node, source: ts.SourceFile): boolean => {
  if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return false;
  const type = node.type;
  return !(ts.isTypeReferenceNode(type) && type.typeName.getText(source) === 'const');
};

const isFunctionNode = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

const functionInfo = (context: VisitContext, node: ts.FunctionLikeDeclaration, outer: boolean): FunctionInfo => {
  const first = context.source.getLineAndCharacterOfPosition(node.getStart(context.source)).line;
  const last = context.source.getLineAndCharacterOfPosition(node.getEnd()).line;
  const name = ts.getNameOfDeclaration(node)?.getText(context.source) ?? '<anonymous>';
  return { name, line: first + 1, codeLines: codeLinesIn(context.mask, first, last), outer };
};

const visit = (context: VisitContext, node: ts.Node, functionDepth: number): void => {
  recordImport(context, node);
  if (isCast(node, context.source)) context.acc.casts += 1;
  if (ts.isNonNullExpression(node)) context.acc.nonNull += 1;
  const isFunction = isFunctionNode(node);
  if (isFunction) context.acc.functions.push(functionInfo(context, node, functionDepth === 0));
  ts.forEachChild(node, child => visit(context, child, functionDepth + (isFunction ? 1 : 0)));
};

const topLevelFunctionNames = (source: ts.SourceFile): string[] =>
  source.statements.flatMap(statement => {
    if (ts.isFunctionDeclaration(statement) && statement.name) return [statement.name.text];
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.flatMap(declaration => {
      const init = declaration.initializer;
      const isFunction = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
      return ts.isIdentifier(declaration.name) && isFunction ? [declaration.name.text] : [];
    });
  });

const analyzeFile = (snapshot: string, path: string): FileInfo => {
  const text = readFileSync(join(snapshot, path), 'utf8');
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const mask = codeLineMask(source, text);
  const acc: Accumulator = { valueImports: [], packages: [], functions: [], casts: 0, nonNull: 0 };
  visit({ snapshot, path, source, mask, acc }, source, 0);
  const codeLines = codeLinesIn(mask, 0, mask.length - 1);
  return { path, codeLines, ...acc, topNames: topLevelFunctionNames(source) };
};

/** Production (non-test) TypeScript under `core/`, keyed by repo-relative path, in sorted order. */
export const analyzeCore = (snapshot: string): ReadonlyMap<string, FileInfo> =>
  new Map(
    walkTs(join(snapshot, 'core'))
      .map(absolute => relative(snapshot, absolute))
      .filter(path => !isTestPath(path))
      .map(path => [path, analyzeFile(snapshot, path)] as const),
  );
