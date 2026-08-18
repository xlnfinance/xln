#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dir, '../../../..');
const RUNTIME = path.join(ROOT, 'core');
const OWNER_MODULES = new Set([
  'core/account/tx/units.ts',
  'core/orderbook/swap-keys.ts',
  'core/protocol/hashes.ts',
  'core/protocol/identity/index.ts',
  'core/protocol/units.ts',
]);
const BRAND_NAMES = new Set([
  'AccountHeight',
  'AccountPairKey',
  'EntityHeight',
  'EntityContextPayloadHash',
  'EntityId',
  'EntityProviderAddress',
  'EvidenceHash',
  'FrameHash',
  'Hashlock',
  'HtlcSecret',
  'JHeight',
  'JId',
  'LockId',
  'RuntimeHeight',
  'RuntimeId',
  'RuntimeMachineRootHash',
  'RuntimeOutputPayloadHash',
  'SignerId',
  'StateHash',
  'TokenAmount',
  'TokenId',
  'UnixMs',
  'UnixS',
]);

const referencedBrandName = (node: ts.TypeNode): string | null => {
  if (
    ts.isTypeReferenceNode(node)
    && ts.isIdentifier(node.typeName)
    && BRAND_NAMES.has(node.typeName.text)
  ) return node.typeName.text;
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) {
    return referencedBrandName(node.type);
  }
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
    for (const member of node.types) {
      const brand = referencedBrandName(member);
      if (brand) return brand;
    }
  }
  return null;
};

const isGenericPhantomIntersection = (node: ts.TypeAliasDeclaration): boolean => {
  if (!node.typeParameters?.length || !ts.isIntersectionTypeNode(node.type)) return false;
  const parameters = new Set(node.typeParameters.map(parameter => parameter.name.text));
  return node.type.types.some(member => {
    if (!ts.isTypeLiteralNode(member)) return false;
    return member.members.some(typeMember => {
      if (!ts.isPropertySignature(typeMember)) return false;
      let referencesParameter = false;
      const inspect = (child: ts.Node): void => {
        if (ts.isIdentifier(child) && parameters.has(child.text)) referencesParameter = true;
        ts.forEachChild(child, inspect);
      };
      inspect(typeMember);
      return referencesParameter;
    });
  });
};

const collectFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(target);
    if (!entry.isFile() || !target.endsWith('.ts') || target.endsWith('.d.ts')) return [];
    const relative = path.relative(ROOT, target);
    return /\/(?:__tests__|qa|scenarios|scripts)\//.test(`/${relative}`) ? [] : [target];
  });

const errors: string[] = [];
for (const ownerModule of OWNER_MODULES) {
  if (!fs.existsSync(path.join(ROOT, ownerModule))) {
    errors.push(`BRAND_OWNER_MODULE_MISSING ${ownerModule}`);
  }
}
for (const file of collectFiles(RUNTIME)) {
  const relative = path.relative(ROOT, file);
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const owner = OWNER_MODULES.has(relative);
  const report = (node: ts.Node, code: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    errors.push(`${code} ${relative}:${line}`);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node)
      && (
        (node.name.text === 'Brand' && (node.typeParameters?.length ?? 0) > 0)
        || isGenericPhantomIntersection(node)
      )
    ) report(node, 'GENERIC_BRAND_ESCAPE');
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(declaration =>
        ts.isIdentifier(declaration.name) && /Brand$/.test(declaration.name.text)) &&
      !owner
    ) report(node, 'BRAND_DECLARATION_OUTSIDE_OWNER');
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      referencedBrandName(node.type) !== null &&
      !owner
    ) report(node, 'BRAND_ASSERTION_OUTSIDE_OWNER');
    if (
      ts.isTypePredicateNode(node) &&
      node.type &&
      referencedBrandName(node.type) !== null &&
      !owner
    ) report(node, 'BRAND_PREDICATE_OUTSIDE_OWNER');
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'brand' &&
      node.typeParameters?.length &&
      !owner
    ) report(node, 'GENERIC_BRAND_ESCAPE');
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'brand' &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.typeParameters?.length &&
      !owner
    ) report(node, 'GENERIC_BRAND_ESCAPE');
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (errors.length > 0) {
  console.error(`FINTS_BRAND_MINTING_FAILED\n${errors.map(error => `- ${error}`).join('\n')}`);
  process.exit(1);
}

console.log(`FINTS_BRAND_MINTING_OK owners=${OWNER_MODULES.size}`);
