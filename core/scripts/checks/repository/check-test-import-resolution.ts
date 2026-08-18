import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';

const TEST_ROOTS = ['jurisdictions/test', 'native/__tests__'] as const;
const files = execFileSync('git', ['ls-files', '-z', '--', ...TEST_ROOTS], { encoding: 'utf8' })
  .split('\0')
  .filter(path => path.endsWith('.ts'))
  .sort();

const compilerOptions: ts.CompilerOptions = {
  allowImportingTsExtensions: true,
  allowJs: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
  target: ts.ScriptTarget.ESNext,
};

const unresolved: string[] = [];
let relativeImports = 0;
for (const path of files) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const visit = (node: ts.Node): void => {
    let moduleSpecifier: string | null = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      moduleSpecifier = node.moduleSpecifier.text;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteralLike(expression)) moduleSpecifier = expression.text;
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const argument = node.arguments[0];
      if ((isDynamicImport || isRequire) && argument && ts.isStringLiteralLike(argument)) {
        moduleSpecifier = argument.text;
      }
    }
    if (moduleSpecifier?.startsWith('.')) {
      relativeImports += 1;
      if (!ts.resolveModuleName(moduleSpecifier, path, compilerOptions, ts.sys).resolvedModule) {
        unresolved.push(`${path}: ${moduleSpecifier}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (files.length === 0 || relativeImports === 0) {
  throw new Error(`TEST_IMPORT_RESOLUTION_SCOPE_EMPTY:files=${files.length}:imports=${relativeImports}`);
}
if (unresolved.length > 0) {
  throw new Error(`TEST_IMPORT_RESOLUTION_FAILED\n${unresolved.join('\n')}`);
}
console.log(`TEST_IMPORT_RESOLUTION_OK files=${files.length} relativeImports=${relativeImports}`);
