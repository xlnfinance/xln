import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const EXCLUDED_PATH = /\/(?:__tests__|qa|scenarios|scripts)\//;

// A double assertion bypasses TypeScript's proof that two types overlap. These
// are existing boundary debts, not permission: new files and larger counts
// fail this gate, while every cleanup must delete its allowance.
const DOUBLE_ASSERTION_DEBT: Readonly<Record<string, number>> = {};

// Suppressions can hide unrelated errors on the same line. The empty ratchet
// makes their removal permanent.
const TS_SUPPRESSION_DEBT: Readonly<Record<string, number>> = {};
const NON_NULL_ASSERTION_FILES = 177;
const NON_NULL_ASSERTION_COUNT = 641;
const NON_NULL_ASSERTION_SHA256 = '9a0ac9d4551c28c7c159c8e3d310f86cce53a68342117bffec6c5c0a8e660f0e';

type UnsafeTypeCounts = {
  explicitAnyLines: number[];
  doubleAssertionLines: number[];
  errorSubtypeControlLines: number[];
  nonNullAssertionLines: number[];
  suppressionLines: number[];
};

const collectFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(target);
    if (!entry.isFile() || !target.endsWith('.ts') || target.endsWith('.d.ts')) return [];
    return EXCLUDED_PATH.test(`/${target}`) || target.endsWith('.test.ts') || target.endsWith('.spec.ts')
      ? []
      : [target];
  });

const lineOf = (source: ts.SourceFile, position: number): number =>
  source.getLineAndCharacterOfPosition(position).line + 1;

const inspectFile = (file: string): UnsafeTypeCounts => {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const explicitAnyLines: number[] = [];
  const doubleAssertionLines: number[] = [];
  const errorSubtypeControlLines: number[] = [];
  const nonNullAssertionLines: number[] = [];

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      explicitAnyLines.push(lineOf(source, node.getStart(source)));
    }
    if (
      ts.isAsExpression(node) &&
      ts.isAsExpression(node.expression) &&
      node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      doubleAssertionLines.push(lineOf(source, node.getStart(source)));
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      && ts.isIdentifier(node.right)
      && ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError']
        .includes(node.right.text)
    ) {
      errorSubtypeControlLines.push(lineOf(source, node.getStart(source)));
    }
    if (ts.isNonNullExpression(node)) {
      nonNullAssertionLines.push(lineOf(source, node.getStart(source)));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const suppressionLines = text
    .split(/\r?\n/)
    .flatMap((line, index) => (/@ts-(?:ignore|nocheck|expect-error)\b/.test(line) ? [index + 1] : []));
  return {
    explicitAnyLines,
    doubleAssertionLines,
    errorSubtypeControlLines,
    nonNullAssertionLines,
    suppressionLines,
  };
};

const files = collectFiles('core').sort();
const errors: string[] = [];
const observedDoubleAssertions = new Map<string, number>();
const observedSuppressions = new Map<string, number>();
let explicitAnyCount = 0;
const nonNullAssertionRows: string[] = [];

const checkDebt = (
  file: string,
  lines: number[],
  debt: Readonly<Record<string, number>>,
  observed: Map<string, number>,
  label: string,
): void => {
  if (lines.length === 0) return;
  observed.set(file, lines.length);
  const allowance = debt[file];
  if (allowance === undefined) errors.push(`NEW_${label} ${file}:${lines.join(',')}`);
  else if (lines.length > allowance) errors.push(`${label}_GREW ${file} ${lines.length} > ${allowance}`);
};

for (const file of files) {
  const counts = inspectFile(file);
  explicitAnyCount += counts.explicitAnyLines.length;
  if (counts.explicitAnyLines.length > 0) {
    errors.push(`EXPLICIT_ANY ${file}:${counts.explicitAnyLines.join(',')}`);
  }
  if (counts.errorSubtypeControlLines.length > 0) {
    errors.push(`ERROR_SUBTYPE_CONTROL_FLOW ${file}:${counts.errorSubtypeControlLines.join(',')}`);
  }
  if (counts.nonNullAssertionLines.length > 0) {
    nonNullAssertionRows.push(`${file}|${counts.nonNullAssertionLines.length}`);
  }
  checkDebt(file, counts.doubleAssertionLines, DOUBLE_ASSERTION_DEBT, observedDoubleAssertions, 'DOUBLE_ASSERTION');
  checkDebt(file, counts.suppressionLines, TS_SUPPRESSION_DEBT, observedSuppressions, 'TS_SUPPRESSION');
}

const findStaleDebt = (
  debt: Readonly<Record<string, number>>,
  observed: ReadonlyMap<string, number>,
  label: string,
): void => {
  for (const file of Object.keys(debt)) {
    if (!observed.has(file)) errors.push(`STALE_${label}_ALLOWANCE ${file}`);
  }
};
findStaleDebt(DOUBLE_ASSERTION_DEBT, observedDoubleAssertions, 'DOUBLE_ASSERTION');
findStaleDebt(TS_SUPPRESSION_DEBT, observedSuppressions, 'TS_SUPPRESSION');

const nonNullCount = nonNullAssertionRows.reduce(
  (sum, row) => sum + Number(row.slice(row.lastIndexOf('|') + 1)),
  0,
);
const nonNullHash = new Bun.CryptoHasher('sha256')
  .update(nonNullAssertionRows.sort().join('\n'))
  .digest('hex');
if (
  nonNullAssertionRows.length !== NON_NULL_ASSERTION_FILES
  || nonNullCount !== NON_NULL_ASSERTION_COUNT
  || nonNullHash !== NON_NULL_ASSERTION_SHA256
) {
  errors.push(
    `NON_NULL_ASSERTION_DEBT_CHANGED expected=${NON_NULL_ASSERTION_FILES}/` +
      `${NON_NULL_ASSERTION_COUNT}/${NON_NULL_ASSERTION_SHA256} actual=` +
      `${nonNullAssertionRows.length}/${nonNullCount}/${nonNullHash}`,
  );
}

if (errors.length > 0) {
  console.error('Unsafe TypeScript surface invariant failed:\n');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const total = (values: ReadonlyMap<string, number>): number =>
  [...values.values()].reduce((sum, value) => sum + value, 0);

console.log(
  `UNSAFE_TYPES_OK files=${files.length} explicitAny=${explicitAnyCount} ` +
    `doubleAssertions=${total(observedDoubleAssertions)} suppressions=${total(observedSuppressions)}`,
    `nonNullAssertions=${nonNullCount}`,
);
