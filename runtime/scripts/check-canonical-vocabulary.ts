import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

const roots = ['Runtime', 'Entity', 'Account'] as const;
const forbiddenSuffixes = new Set([
  'Env',
  'Environment',
  'MachineInput',
  'MachineState',
  'ReplicaState',
  'Transaction',
]);
const required = new Set([
  'RuntimeState',
  'RuntimeInput',
  'RuntimeTx',
  'EntityState',
  'EntityReplica',
  'EntityCandidate',
  'EntityInput',
  'EntityOutput',
  'EntityTx',
  'AccountState',
  'AccountReplica',
  'AccountFrame',
  'AccountInput',
  'AccountTx',
]);
const discovered = new Set<string>();
const violations: string[] = [];
const legacyEntityCandidateName = ['validator', 'Execution'].join('');
const legacyTypeNames = /\b(?:RuntimeEnv|EntityMachine|AccountMachine|ServerMachine)\b/gu;

const listFiles = (directory: string, extension: string): string[] => readdirSync(directory, {
  withFileTypes: true,
}).flatMap(entry => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return listFiles(path, extension);
  return entry.isFile() && path.endsWith(extension) ? [path] : [];
});

for (const path of listFiles('runtime', '.ts')) {
  if (path.includes('/__tests__/') || path.includes('/generated/')) continue;
  const source = readFileSync(path, 'utf8');
  if (source.includes(legacyEntityCandidateName)) {
    violations.push(`${path}:legacy-entity-candidate-name:${legacyEntityCandidateName}`);
  }
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.propertyName) {
      violations.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}:import-alias:${node.getText(file)}`);
    }
    if (
      (ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      const name = node.name.text;
      discovered.add(name);
      const root = roots.find(prefix => name.startsWith(prefix));
      const suffix = root ? name.slice(root.length) : '';
      if (root && forbiddenSuffixes.has(suffix)) {
        violations.push(`${path}:${file.getLineAndCharacterOfPosition(node.name.getStart()).line + 1}:forbidden:${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

// Active documentation is part of the audit surface. Historical release notes,
// archived designs, and audit evidence must retain their original vocabulary;
// live specifications must use the same type names as the compiler.
for (const path of listFiles('docs', '.md')) {
  if (path.includes('/archive/') || path.includes('/releases/') || path.includes('/audit/')) continue;
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(legacyTypeNames)) {
    const line = source.slice(0, match.index).split('\n').length;
    violations.push(`${path}:${line}:legacy-doc-type:${match[0]}`);
  }
}

for (const name of required) {
  if (!discovered.has(name)) violations.push(`missing-canonical-type:${name}`);
}
if (violations.length > 0) {
  throw new Error(`CANONICAL_VOCABULARY_VIOLATION\n${violations.join('\n')}`);
}
console.log(`CANONICAL_VOCABULARY_OK required=${required.size} importAliases=0`);
