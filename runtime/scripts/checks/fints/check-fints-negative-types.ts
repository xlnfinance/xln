#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../../..');
const TSC = path.join(ROOT, 'node_modules/@typescript/native/bin/tsc');

const compile = (tsconfig: string): { status: number; output: string } => {
  const result = spawnSync(
    process.execPath,
    [TSC, '-p', tsconfig, '--noEmit', '--pretty', 'false', '--checkers', '1'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

const requireSuccess = (label: string, tsconfig: string): void => {
  const result = compile(tsconfig);
  if (result.status !== 0) {
    throw new Error(`${label}_COMPILE_FAILED\n${result.output}`);
  }
};

const requireFailure = (
  label: string,
  tsconfig: string,
  expectedPaths: readonly string[],
): void => {
  const result = compile(tsconfig);
  if (result.status === 0) {
    throw new Error(`${label}_COMPILE_UNEXPECTED_SUCCESS`);
  }
  for (const expectedPath of expectedPaths) {
    if (!result.output.includes(expectedPath)) {
      throw new Error(`${label}_MISSING_DIAGNOSTIC ${expectedPath}\n${result.output}`);
    }
  }
  if (!/error TS(2322|2353|2739|2412)\b/.test(result.output)) {
    throw new Error(`${label}_UNEXPECTED_DIAGNOSTIC_CLASS\n${result.output}`);
  }
};

const requireBrandMintingGate = (): void => {
  const result = spawnSync(
    process.execPath,
    ['runtime/scripts/checks/fints/check-brand-minting.ts'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`FINTS_BRAND_MINTING_GATE_FAILED\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
};

requireSuccess('FINTS_POSITIVE', 'tsconfig.fints-positive.json');
requireFailure('FINTS_NEGATIVE', 'tsconfig.fints-negative.json', [
  'apply-account-tx-result.negative.ts',
  'apply-account-tx-units.negative.ts',
  'account-consensus-result.negative.ts',
  'entity-frame-phase.negative.ts',
  'failure-disposition.negative.ts',
]);
requireSuccess('FINTS_WIDENED', 'tsconfig.fints-widened.json');
requireSuccess(
  'FINTS_PROTOCOL_BRANDS_POSITIVE',
  'runtime/scripts/checks/fints/tsconfig.protocol-brands-positive.json',
);
requireFailure(
  'FINTS_PROTOCOL_BRANDS_NEGATIVE',
  'runtime/scripts/checks/fints/tsconfig.protocol-brands-negative.json',
  ['protocol-brands.negative.ts'],
);
requireSuccess(
  'FINTS_PROTOCOL_BRANDS_WIDENED',
  'runtime/scripts/checks/fints/tsconfig.protocol-brands-widened.json',
);
requireBrandMintingGate();

console.log('FINTS_NEGATIVE_TYPES_OK');
