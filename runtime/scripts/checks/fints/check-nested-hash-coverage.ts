#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { HASHABLE_LOCK_BOOK_ENTRY_FIELDS, type LockBookFieldCoverage } from '../../../entity/state/lock-book-fields';
import { BATCH_ABI, PROOF_BODY_ABI } from '../../../protocol/dispute/proof-body';
import {
  HASHABLE_ACCOUNT_TX_DATA_FIELDS,
  HASHABLE_SETTLEMENT_OP_FIELDS,
  NESTED_HASH_COVERAGE,
} from '../../../types/hash-coverage/catalog';
import {
  HASHABLE_RUNTIME_PAYMENT_FIELDS,
  HASHABLE_RUNTIME_PROOF_BODY_FIELDS,
  HASHABLE_RUNTIME_PULL_FIELDS,
  HASHABLE_RUNTIME_SWAP_FIELDS,
} from '../../../types/hash-coverage/evidence-nested';

const ROOT = path.resolve(import.meta.dir, '../../../..');
const errors: string[] = [];

const sourceCache = new Map<string, ts.SourceFile>();
const readSource = (relative: string): ts.SourceFile => {
  const cached = sourceCache.get(relative);
  if (cached) return cached;
  const file = ts.createSourceFile(
    relative,
    readFileSync(path.join(ROOT, relative), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  sourceCache.set(relative, file);
  return file;
};

const identifierName = (name: ts.PropertyName | ts.BindingName | ts.EntityName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
};

const typeLiteralKeys = (node: ts.TypeLiteralNode): string[] =>
  node.members.flatMap(member => {
    if (!ts.isPropertySignature(member) || !member.name) return [];
    const name = identifierName(member.name);
    return name ? [name] : [];
  });

const interfaceKeys = (node: ts.InterfaceDeclaration): string[] =>
  node.members.flatMap(member => {
    if (!ts.isPropertySignature(member) || !member.name) return [];
    const name = identifierName(member.name);
    return name ? [name] : [];
  });

const findNamed = (source: ts.SourceFile, typeName: string): ts.Node | undefined => {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.text === typeName
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const stringUnionValues = (node: ts.TypeNode): string[] => {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text];
  if (!ts.isUnionTypeNode(node)) return [];
  return node.types.flatMap(stringUnionValues);
};

const unionTypeLiterals = (node: ts.TypeNode): ts.TypeLiteralNode[] => {
  if (ts.isTypeLiteralNode(node)) return [node];
  if (ts.isParenthesizedTypeNode(node)) return unionTypeLiterals(node.type);
  if (!ts.isUnionTypeNode(node)) return [];
  return node.types.flatMap(unionTypeLiterals);
};

const propertyType = (literal: ts.TypeLiteralNode, key: string): ts.TypeNode | undefined => {
  for (const member of literal.members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) continue;
    if (identifierName(member.name) === key) return member.type;
  }
  return undefined;
};

const discriminantValue = (literal: ts.TypeLiteralNode, key: string): string | undefined => {
  const type = propertyType(literal, key);
  if (type && ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return type.literal.text;
  return undefined;
};

const resolveTypeKeys = (source: ts.SourceFile, node: ts.TypeNode): string[] => {
  if (ts.isTypeLiteralNode(node)) return typeLiteralKeys(node);
  if (ts.isParenthesizedTypeNode(node) || ts.isUnionTypeNode(node)) {
    return [...new Set(unionTypeLiterals(node).flatMap(typeLiteralKeys))];
  }
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return [];
  const named = findNamed(source, node.typeName.text);
  if (named && ts.isTypeAliasDeclaration(named)) return resolveTypeKeys(source, named.type);
  if (named && ts.isInterfaceDeclaration(named)) return interfaceKeys(named);
  return [];
};

const compareSets = (label: string, actual: readonly string[], expected: readonly string[]): void => {
  const missing = expected.filter(field => !actual.includes(field));
  const extra = actual.filter(field => !expected.includes(field));
  if (missing.length > 0) errors.push(`${label}:missing=${missing.join(',')}`);
  if (extra.length > 0) errors.push(`${label}:extra=${extra.join(',')}`);
};

const compareOrder = (label: string, actual: readonly string[], expected: readonly string[]): void => {
  if (actual.join(',') !== expected.join(',')) {
    errors.push(`${label}:order actual=${actual.join(',')} expected=${expected.join(',')}`);
  }
};

const fieldsForTag = (catalog: object, tag: string): readonly string[] | undefined => {
  const value = Object.entries(catalog).find(([key]) => key === tag)?.[1];
  return Array.isArray(value) ? value : undefined;
};

const checkTaggedPayloads = (
  label: string,
  literals: readonly ts.TypeLiteralNode[],
  catalog: object,
  payload: (literal: ts.TypeLiteralNode) => ts.TypeNode | ts.TypeLiteralNode | undefined,
  source: ts.SourceFile,
): void => {
  for (const literal of literals) {
    const tag = discriminantValue(literal, 'type');
    if (!tag) continue;
    const expected = fieldsForTag(catalog, tag);
    if (!expected) {
      errors.push(`${label}.${tag}:unclassified`);
      continue;
    }
    const node = payload(literal);
    const actual = !node
      ? []
      : ts.isTypeLiteralNode(node)
        ? typeLiteralKeys(node)
        : resolveTypeKeys(source, node);
    compareSets(`${label}.${tag}`, actual, expected);
  }
};

const abiComponentNames = (components: readonly { name: string }[]): readonly string[] =>
  components.map(component => component.name);

for (const entry of NESTED_HASH_COVERAGE) {
  const source = readSource(entry.sourceFile);
  const named = findNamed(source, entry.typeName);
  if (!named) {
    errors.push(`${entry.typeName}:declaration-missing in ${entry.sourceFile}`);
    continue;
  }
  if (entry.shape === 'interface' && ts.isInterfaceDeclaration(named)) {
    compareSets(entry.typeName, interfaceKeys(named), entry.fields);
    continue;
  }
  if (entry.shape === 'type-literal' && ts.isTypeAliasDeclaration(named)) {
    compareSets(entry.typeName, resolveTypeKeys(source, named.type), entry.fields);
    continue;
  }
  if (entry.shape === 'string-union' && ts.isTypeAliasDeclaration(named)) {
    compareSets(entry.typeName, stringUnionValues(named.type), entry.fields);
    continue;
  }
  if (entry.shape === 'union-by-type' && ts.isTypeAliasDeclaration(named)) {
    const literals = unionTypeLiterals(named.type);
    const tags = literals.flatMap(literal => {
      const tag = discriminantValue(literal, 'type');
      return tag ? [tag] : [];
    });
    compareSets(`${entry.typeName}.type`, tags, entry.fields);
    if (entry.typeName === 'AccountTx') {
      checkTaggedPayloads('AccountTx', literals, HASHABLE_ACCOUNT_TX_DATA_FIELDS, literal => propertyType(literal, 'data'), source);
    }
    if (entry.typeName === 'SettlementOp') {
      checkTaggedPayloads('SettlementOp', literals, HASHABLE_SETTLEMENT_OP_FIELDS, literal => literal, source);
    }
    continue;
  }
  errors.push(`${entry.typeName}:shape-mismatch:${entry.shape}`);
}

type LockBookCoverageHeld<T extends never = LockBookFieldCoverage> = [T] extends [never]
  ? typeof HASHABLE_LOCK_BOOK_ENTRY_FIELDS
  : never;

const lockBookSource = readSource('runtime/entity/types.ts');
const lockBook = findNamed(lockBookSource, 'LockBookEntry');
if (!lockBook || !ts.isInterfaceDeclaration(lockBook)) {
  errors.push('LockBookEntry:declaration-missing');
} else {
  compareSets(
    'LockBookEntry',
    interfaceKeys(lockBook),
    HASHABLE_LOCK_BOOK_ENTRY_FIELDS satisfies LockBookCoverageHeld,
  );
}

compareOrder('RuntimeProofBody.abi', HASHABLE_RUNTIME_PROOF_BODY_FIELDS, abiComponentNames(PROOF_BODY_ABI.components));
compareOrder(
  'RuntimePayment.abi',
  HASHABLE_RUNTIME_PAYMENT_FIELDS,
  abiComponentNames(BATCH_ABI.components[0]!.components),
);
compareOrder(
  'RuntimeSwap.abi',
  HASHABLE_RUNTIME_SWAP_FIELDS,
  abiComponentNames(BATCH_ABI.components[1]!.components),
);
compareOrder(
  'RuntimePull.abi',
  HASHABLE_RUNTIME_PULL_FIELDS,
  abiComponentNames(BATCH_ABI.components[2]!.components),
);

if (errors.length > 0) {
  console.error('NESTED_HASH_COVERAGE_FAILED');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`NESTED_HASH_COVERAGE_OK entries=${NESTED_HASH_COVERAGE.length + 1}`);
