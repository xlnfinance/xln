import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const STATE_MACHINE_ROOTS = [
  'runtime/runtime',
  'runtime/entity',
  'runtime/account',
] as const;

const MAX_FILE_LINES = 3_000;
const TARGET_HELPER_LINES = 100;
const TARGET_COORDINATOR_LINES = 150;

// This debt list is intentionally exact. A new >150-line function, a growing
// existing function, or a removed function whose allowance was not deleted
// fails the gate. Refactors therefore ratchet the list toward zero instead of
// turning today's debt into a permanent global threshold.
const COORDINATOR_DEBT: Readonly<Record<string, number>> = {
};

const MAX_OVER_100_FUNCTIONS = 42;

type FunctionSize = {
  key: string;
  file: string;
  name: string;
  lines: number;
  start: number;
};

const collectTypeScriptFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(target);
    return entry.isFile() && target.endsWith('.ts') && !target.endsWith('.d.ts')
      ? [target]
      : [];
  });

const functionName = (
  node: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
  start: number,
): string => {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  if (ts.isMethodDeclaration(node) && node.name) return node.name.getText(source);
  return `anonymous@${start}`;
};

const collectFunctionSizes = (file: string, text: string): FunctionSize[] => {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const functions: FunctionSize[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      const declaration = node as ts.FunctionLikeDeclaration;
      const start = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(declaration.end).line + 1;
      const name = functionName(declaration, source, start);
      functions.push({ key: `${file}::${name}`, file, name, lines: end - start + 1, start });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return functions;
};

const files = STATE_MACHINE_ROOTS.flatMap(collectTypeScriptFiles).sort();
const errors: string[] = [];
const functions: FunctionSize[] = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).length;
  if (lines > MAX_FILE_LINES) {
    errors.push(`FILE_TOO_LARGE ${file}:${lines} > ${MAX_FILE_LINES}`);
  }
  functions.push(...collectFunctionSizes(file, text));
}

const over100 = functions.filter(entry => entry.lines > TARGET_HELPER_LINES);
if (process.argv.includes('--list-over-100')) {
  for (const entry of [...over100].sort((left, right) => right.lines - left.lines)) {
    console.log(`${entry.lines}\t${entry.file}:${entry.start}\t${entry.name}`);
  }
}
if (over100.length > MAX_OVER_100_FUNCTIONS) {
  errors.push(
    `FUNCTION_DEBT_GREW over${TARGET_HELPER_LINES}=${over100.length} > ${MAX_OVER_100_FUNCTIONS}`,
  );
}

const currentCoordinatorDebt = new Map(
  functions
    .filter(entry => entry.lines > TARGET_COORDINATOR_LINES)
    .map(entry => [entry.key, entry]),
);

for (const [key, entry] of currentCoordinatorDebt) {
  const allowance = COORDINATOR_DEBT[key];
  if (allowance === undefined) {
    errors.push(`NEW_LARGE_FUNCTION ${key}:${entry.start} lines=${entry.lines}`);
  } else if (entry.lines > allowance) {
    errors.push(`LARGE_FUNCTION_GREW ${key}:${entry.start} ${entry.lines} > ${allowance}`);
  }
}

for (const key of Object.keys(COORDINATOR_DEBT)) {
  if (!currentCoordinatorDebt.has(key)) {
    errors.push(`STALE_LARGE_FUNCTION_ALLOWANCE ${key}`);
  }
}

if (errors.length > 0) {
  console.error('State-machine size invariant failed:\n');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `STATE_MACHINE_SIZE_OK files=${files.length} maxFile=${MAX_FILE_LINES} ` +
  `over100=${over100.length}/${MAX_OVER_100_FUNCTIONS} ` +
  `over150=${currentCoordinatorDebt.size}/${Object.keys(COORDINATOR_DEBT).length}`,
);
