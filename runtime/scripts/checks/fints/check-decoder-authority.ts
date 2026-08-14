#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const EXCLUDED_PATH = /\/(?:__tests__|qa|scenarios)\//;
const VALIDATOR_PARAMETER = /(?:validate|validator|schema|decode|assert)/i;
const RAW_DECODER = /^(?:decodeBinaryPayload|decodeBuffer|decryptJSON|deserializeTaggedJson|safeParse)$/;

const collectFiles = (directory: string, excludeRuntimeScripts: boolean): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_PATH.test(`/${target}/`)) return [];
      if (excludeRuntimeScripts && target === path.join('runtime', 'scripts')) return [];
      return collectFiles(target, excludeRuntimeScripts);
    }
    if (!entry.isFile() || !target.endsWith('.ts') || target.endsWith('.d.ts')) return [];
    return [target];
  });

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node)
  && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;

const identifierText = (node: ts.Expression): string | null => {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
};

const isJsonParseCall = (node: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(node.expression)
  && ts.isIdentifier(node.expression.expression)
  && node.expression.expression.text === 'JSON'
  && node.expression.name.text === 'parse';

const isResponseJsonCall = (node: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'json';

const inspectSource = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const errors: string[] = [];
  const decoderAliases = new Map<string, string>();
  const untrustedBindings = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    const bindings = statement.importClause.namedBindings;
    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (RAW_DECODER.test(imported)) decoderAliases.set(element.name.text, imported);
    }
  }
  const fail = (node: ts.Node, code: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    errors.push(`${code} ${file}:${line}`);
  };
  const isUnknownRecordAssertion = (node: ts.TypeNode): boolean => {
    const compact = node.getText(source).replaceAll(/\s/g, '');
    return compact === 'Record<string,unknown>' || compact === 'Readonly<Record<string,unknown>>';
  };
  const inspectExportedDecoder = (
    node: ts.Node,
    name: string,
    typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
    parameters: ts.NodeArray<ts.ParameterDeclaration>,
  ): void => {
    if (!/^(?:decode|decrypt)(?:[A-Z]|$)/.test(name) || !typeParameters?.length) return;
    const hasValidator = parameters.some(parameter => {
      const parameterName = ts.isIdentifier(parameter.name) ? parameter.name.text : '';
      return VALIDATOR_PARAMETER.test(parameterName);
    });
    if (!hasValidator) fail(node, 'EXPORTED_GENERIC_DECODER_WITHOUT_VALIDATOR');
  };
  const decoderName = (expression: ts.Expression): string | null => {
    const local = identifierText(expression);
    return local ? decoderAliases.get(local) ?? local : null;
  };
  const unwrapCall = (expression: ts.Expression): ts.CallExpression | null => {
    const value = ts.isAwaitExpression(expression) ? expression.expression : expression;
    return ts.isCallExpression(value) ? value : null;
  };
  const isUntrustedCall = (call: ts.CallExpression): boolean => {
    const name = decoderName(call.expression);
    return Boolean((name && RAW_DECODER.test(name)) || isJsonParseCall(call) || isResponseJsonCall(call));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const call = unwrapCall(node.initializer);
      if (call && isUntrustedCall(call)) untrustedBindings.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
      inspectExportedDecoder(node, node.name.text, node.typeParameters, node.parameters);
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) continue;
        inspectExportedDecoder(
          declaration,
          declaration.name.text,
          declaration.initializer.typeParameters,
          declaration.initializer.parameters,
        );
      }
    }
    if (ts.isCallExpression(node) && node.typeArguments?.length) {
      const name = decoderName(node.expression);
      if (name && RAW_DECODER.test(name)) fail(node, 'RAW_DECODER_TYPE_ARGUMENT');
    }
    if (
      ts.isAsExpression(node)
      && node.type.kind !== ts.SyntaxKind.UnknownKeyword
      && ts.isCallExpression(node.expression)
    ) {
      const name = decoderName(node.expression.expression);
      if (
        (name && RAW_DECODER.test(name))
        || isJsonParseCall(node.expression)
        || isResponseJsonCall(node.expression)
      ) fail(node, 'UNTRUSTED_DECODE_ASSERTION');
    }
    if (
      ts.isAsExpression(node)
      && node.type.kind !== ts.SyntaxKind.UnknownKeyword
      && !isUnknownRecordAssertion(node.type)
      && ts.isIdentifier(node.expression)
      && untrustedBindings.has(node.expression.text)
    ) fail(node, 'UNTRUSTED_DECODE_ASSERTION');
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
};

const stdinMode = process.argv.includes('--stdin');
const inputs = stdinMode
  ? [{ file: 'runtime/__decoder-authority-probe__.ts', text: await Bun.stdin.text() }]
  : [
      ...collectFiles('runtime', true),
      ...collectFiles('frontend/src', false),
      ...collectFiles('runtime/scripts/deployment', false),
    ].map(file => ({ file, text: fs.readFileSync(file, 'utf8') }));
const errors = inputs.flatMap(input => inspectSource(input.file, input.text));
if (errors.length > 0) {
  console.error(`FINTS_DECODER_AUTHORITY_FAILED\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(`FINTS_DECODER_AUTHORITY_OK files=${inputs.length}`);
