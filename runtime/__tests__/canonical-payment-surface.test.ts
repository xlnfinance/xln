import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENTITY_TX_TYPES } from '../entity/tx/catalog';

const repoRoot = process.cwd();
const obsoleteEntityTx = ['hashlock', 'Payment'].join('');
const historicalPrefixes = ['.archive/', 'docs/archive/', 'docs/releases/'];

const trackedFiles = (): string[] => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).split('\0').filter(Boolean).filter(path =>
  !historicalPrefixes.some(prefix => path.startsWith(prefix))
  && existsSync(join(repoRoot, path))
  && lstatSync(join(repoRoot, path)).isFile()
);

const source = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

test('removed parallel payment transaction is absent from source, tests, docs, and generated files', () => {
  const mentions = trackedFiles().filter(path => source(path).includes(obsoleteEntityTx));
  expect(mentions).toEqual([]);
});

test('each payment operation retains one explicit canonical transaction path', () => {
  expect(ENTITY_TX_TYPES).toEqual(expect.arrayContaining([
    'htlcPayment',
    'pullLock',
    'prepareCrossJurisdictionSwap',
    'extendCredit',
  ]));

  expect(source('runtime/entity/tx/handlers/htlc-payment.ts'))
    .toContain('const accountTx = buildOutboundLockTx(prepared);');
  expect(source('runtime/entity/tx/handlers/pull.ts'))
    .toContain("type: 'pull_lock'");

  const crossJurisdiction = source('runtime/entity/tx/handlers/cross-j-setup.ts');
  expect(crossJurisdiction).toContain("buildCrossJurisdictionPullBinding(route, 'source')");
  expect(crossJurisdiction).toContain("buildCrossJurisdictionPullBinding(route, 'target')");

  expect(source('runtime/entity/tx/handlers/account-admin.ts'))
    .toContain("type: 'set_credit_limit'");
});
