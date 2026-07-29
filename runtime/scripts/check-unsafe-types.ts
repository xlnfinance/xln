import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const EXCLUDED_PATH = /\/(?:__tests__|qa|scenarios|scripts)\//;

// A double assertion bypasses TypeScript's proof that two types overlap. These
// are existing boundary debts, not permission: new files and larger counts
// fail this gate, while every cleanup must delete its allowance.
const DOUBLE_ASSERTION_DEBT: Readonly<Record<string, number>> = {
  'runtime/entity/consensus/state-root.ts': 1,
  'runtime/entity/tx/handlers/account/orderbook-matching-helpers.ts': 2,
  'runtime/entity/tx/j-events-htlc.ts': 2,
  'runtime/hanko/codec.ts': 1,
  'runtime/infra/integrity-checksum.ts': 1,
  'runtime/jadapter/browservm-provider.ts': 4,
  'runtime/jadapter/rpc-adapter.ts': 12,
  'runtime/jadapter/rpc-public.ts': 1,
  'runtime/jadapter/tron-signer.ts': 1,
  'runtime/jurisdiction/batch.ts': 1,
  'runtime/jurisdiction/config.ts': 1,
  'runtime/networking/gossip.ts': 3,
  'runtime/networking/profile-encryption.ts': 1,
  'runtime/networking/ws-client.ts': 1,
  'runtime/orchestrator/hub-node.ts': 2,
  'runtime/protocol/boundary-validation.ts': 2,
  'runtime/protocol/htlc/payment-admission.ts': 1,
  'runtime/radapter/resolve.ts': 1,
  'runtime/radapter/wire-schema.ts': 4,
  'runtime/runtime/delivery/pending.ts': 1,
  'runtime/runtime/frame/transaction.ts': 1,
  'runtime/runtime/loop-environment.ts': 1,
  'runtime/runtime/p2p-lifecycle.ts': 1,
  'runtime/runtime/reliable-authority.ts': 1,
  'runtime/server/cli.ts': 2,
  'runtime/server/stack-probe.ts': 2,
  'runtime/state-helpers.ts': 2,
  'runtime/storage/history-view-schema.ts': 3,
  'runtime/storage/runtime-dbs.ts': 1,
  'runtime/storage/schema-state-docs.ts': 1,
  'runtime/storage/sorted-index.ts': 2,
  'runtime/validation-utils.ts': 15,
  'runtime/storage/wal/runtime-machine-schema/entity-tx.ts': 1,
  'runtime/storage/wal/runtime-machine-schema/index.ts': 1,
  'runtime/storage/wal/runtime-machine-schema/j-observation.ts': 1,
  'runtime/storage/wal/runtime-machine-schema/j.ts': 3,
  'runtime/storage/wal/runtime-machine-schema/runtime-tx.ts': 1,
  'runtime/watchtower/action.ts': 1,
  'runtime/watchtower/dispute-watch.ts': 1,
};

// These suppressions bridge third-party declaration gaps. They remain visible
// debt because a suppression can hide unrelated errors on the same line.
const TS_SUPPRESSION_DEBT: Readonly<Record<string, number>> = {
  'runtime/networking/p2p-crypto.ts': 3,
};

type UnsafeTypeCounts = {
  explicitAnyLines: number[];
  doubleAssertionLines: number[];
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
    ts.forEachChild(node, visit);
  };
  visit(source);

  const suppressionLines = text
    .split(/\r?\n/)
    .flatMap((line, index) => (/@ts-(?:ignore|nocheck|expect-error)\b/.test(line) ? [index + 1] : []));
  return { explicitAnyLines, doubleAssertionLines, suppressionLines };
};

const files = collectFiles('runtime').sort();
const errors: string[] = [];
const observedDoubleAssertions = new Map<string, number>();
const observedSuppressions = new Map<string, number>();
let explicitAnyCount = 0;

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
);
