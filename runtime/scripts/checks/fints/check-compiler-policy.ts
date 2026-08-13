#!/usr/bin/env bun

import ts from 'typescript';
import path from 'node:path';

const REQUIRED_TRUE = [
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noImplicitReturns',
  'noPropertyAccessFromIndexSignature',
  'noUnusedLocals',
  'noUnusedParameters',
  'useUnknownInCatchVariables',
  'isolatedModules',
  'noUncheckedSideEffectImports',
  'verbatimModuleSyntax',
] as const;

const REQUIRED_FALSE = ['allowUnreachableCode', 'allowUnusedLabels'] as const;

const readOptions = (configPath: string): ts.CompilerOptions => {
  const absolutePath = path.resolve(configPath);
  const loaded = ts.readConfigFile(absolutePath, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    path.dirname(absolutePath),
    undefined,
    absolutePath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(error =>
      ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  return parsed.options;
};

const failures: string[] = [];
for (const configPath of ['tsconfig.runtime.json', 'frontend/tsconfig.json']) {
  const options = readOptions(configPath);
  for (const name of REQUIRED_TRUE) {
    if (options[name] !== true) failures.push(`${configPath}:${name}=true required`);
  }
  for (const name of REQUIRED_FALSE) {
    if (options[name] !== false) failures.push(`${configPath}:${name}=false required`);
  }
}

if (failures.length > 0) {
  throw new Error(`FINTS_COMPILER_POLICY_FAILED\n${failures.join('\n')}`);
}
console.log('FINTS_COMPILER_POLICY_OK configs=2');
