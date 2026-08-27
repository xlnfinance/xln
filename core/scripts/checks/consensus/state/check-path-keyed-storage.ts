/** Reject physical persistence whose key has any content-digest provenance. */

import { promises } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const roots = ['core', 'rscore/crates'] as const;
const excluded = [
  '/__tests__/',
  '/tests/',
  '/scripts/checks/consensus/state/check-path-keyed-storage.ts',
] as const;
const writeMethods = new Set(['put', 'write', 'insert']);
const storageReceiver = /(?:db|database|batch|storage|writer|txn|transaction|level|rocks)/i;
const digestName = /(?:hash|digest|root)$/i;
const digestFunctionName = /(?:^hash|hash$|digest|root$|^sha(?:2|3)?\d*$|^keccak|^blake)/i;
const pathName = /(?:(?:entity|account|owner|runtime|replica)_?id|height|index|path|slot|offset)$/i;

export interface PathKeyViolation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

interface Provenance {
  readonly digest: boolean;
  readonly path: boolean;
  readonly keyConstructor: boolean;
}

const emptyProvenance = (): Provenance => ({
  digest: false,
  path: false,
  keyConstructor: false,
});
const merge = (values: readonly Provenance[]): Provenance => ({
  digest: values.some(value => value.digest),
  path: values.some(value => value.path),
  keyConstructor: values.some(value => value.keyConstructor),
});
const isDigestAddressed = (value: Provenance): boolean => value.digest;

const identifierProvenance = (name: string): Provenance => ({
  digest: digestName.test(name),
  path: pathName.test(name),
  keyConstructor: false,
});

const propertyName = (node: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
};

const calleeName = (expression: ts.Expression): string => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return '';
};

const expressionProvenance = (
  expression: ts.Expression,
  variables: ReadonlyMap<string, Provenance>,
): Provenance => {
  if (ts.isParenthesizedExpression(expression)) {
    return expressionProvenance(expression.expression, variables);
  }
  if (ts.isIdentifier(expression)) {
    return variables.get(expression.text) ?? identifierProvenance(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return merge([
      expressionProvenance(expression.expression, variables),
      identifierProvenance(expression.name.text),
    ]);
  }
  if (ts.isElementAccessExpression(expression)) {
    return merge([
      expressionProvenance(expression.expression, variables),
      expression.argumentExpression
        ? expressionProvenance(expression.argumentExpression, variables)
        : emptyProvenance(),
    ]);
  }
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
    const name = calleeName(expression.expression);
    if (digestFunctionName.test(name)) {
      return { digest: true, path: false, keyConstructor: false };
    }
    const argumentsProvenance = merge((expression.arguments ?? []).map(argument =>
      expressionProvenance(argument, variables)));
    return {
      ...argumentsProvenance,
      keyConstructor: argumentsProvenance.keyConstructor || /^key(?:[A-Z_]|$)/i.test(name),
    };
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return merge(expression.elements.map(element =>
      ts.isSpreadElement(element)
        ? expressionProvenance(element.expression, variables)
        : expressionProvenance(element, variables)));
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return merge(expression.properties.flatMap(property => {
      if (ts.isPropertyAssignment(property)) {
        return [expressionProvenance(property.initializer, variables)];
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return [variables.get(property.name.text) ?? identifierProvenance(property.name.text)];
      }
      return [];
    }));
  }
  if (ts.isTemplateExpression(expression)) {
    return merge(expression.templateSpans.map(span =>
      expressionProvenance(span.expression, variables)));
  }
  if (ts.isBinaryExpression(expression)) {
    return merge([
      expressionProvenance(expression.left, variables),
      expressionProvenance(expression.right, variables),
    ]);
  }
  if (ts.isConditionalExpression(expression)) {
    return merge([
      expressionProvenance(expression.whenTrue, variables),
      expressionProvenance(expression.whenFalse, variables),
    ]);
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) || ts.isAwaitExpression(expression)) {
    return expressionProvenance(expression.expression, variables);
  }
  return emptyProvenance();
};

const lineOf = (source: ts.SourceFile, node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

const objectStorageKey = (
  object: ts.ObjectLiteralExpression,
): ts.Expression | undefined => {
  let key: ts.Expression | undefined;
  let hasValue = false;
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name);
      if (name === 'key') key = property.initializer;
      if (name === 'value') hasValue = true;
    } else if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === 'key') key = property.name;
      if (property.name.text === 'value') hasValue = true;
    }
  }
  return hasValue ? key : undefined;
};

export const findTypeScriptPathKeyViolations = (
  text: string,
  file = '<source.ts>',
): PathKeyViolation[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations: PathKeyViolation[] = [];

  const record = (node: ts.Node, reason: string): void => {
    violations.push({ file, line: lineOf(source, node), reason });
  };
  const visit = (node: ts.Node, inherited: ReadonlyMap<string, Provenance>): void => {
    const variables = ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node)
      ? new Map(inherited)
      : inherited as Map<string, Provenance>;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variables.set(node.name.text, expressionProvenance(node.initializer, variables));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        writeMethods.has(node.expression.name.text) && node.arguments[0] &&
        storageReceiver.test(node.expression.expression.getText(source)) &&
        isDigestAddressed(expressionProvenance(node.arguments[0], variables))) {
      record(node.arguments[0], `digest-derived-${node.expression.name.text}-key`);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const key = objectStorageKey(node);
      const provenance = key ? expressionProvenance(key, variables) : emptyProvenance();
      const directDigest = key && ts.isIdentifier(key) && digestName.test(key.text);
      if (key && isDigestAddressed(provenance) && (provenance.keyConstructor || directDigest)) {
        record(key, 'digest-derived-storage-row-key');
      }
    }
    ts.forEachChild(node, child => visit(child, variables));
  };
  visit(source, new Map());
  return violations;
};

const rustStorageWrite = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(put|write|insert)\s*\(/g;
const firstRustArgument = (source: string): string => {
  let depth = 0;
  let quote: '"' | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (character === ',' && depth === 0) return source.slice(0, index);
    if (depth < 0) return source.slice(0, index);
  }
  return source;
};
export const findRustPathKeyViolations = (
  text: string,
  file = '<source.rs>',
): PathKeyViolation[] => {
  const violations: PathKeyViolation[] = [];
  for (const match of text.matchAll(rustStorageWrite)) {
    const receiver = match[1] ?? '';
    const method = match[2] ?? 'write';
    const argumentStart = (match.index ?? 0) + match[0].length;
    const key = firstRustArgument(text.slice(argumentStart));
    if (!storageReceiver.test(receiver)) continue;
    const identifiers = [...key.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)]
      .filter(identifier => key[identifier.index! + identifier[0].length] !== '(')
      .map(identifier => identifier[0]);
    const callees = [...key.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
      .map(identifier => identifier[1] ?? '');
    const hasDigest = identifiers.some(identifier => digestName.test(identifier)) ||
      callees.some(identifier => digestFunctionName.test(identifier));
    if (!hasDigest) continue;
    const offset = match.index ?? 0;
    const line = text.slice(0, offset).split('\n').length;
    violations.push({ file, line, reason: `digest-derived-${method}-key` });
  }
  return violations;
};

const walk = async (directory: string): Promise<string[]> => {
  const entries = await promises.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  }));
  return nested.flat();
};

const main = async (): Promise<void> => {
  const sourceFiles = (await Promise.all(roots.map(walk)))
    .flat()
    .filter(file => /\.(?:rs|ts)$/.test(file))
    .filter(file => !excluded.some(part => `/${file}`.includes(part)))
    .sort();
  const violations: PathKeyViolation[] = [];
  for (const file of sourceFiles) {
    const text = await promises.readFile(file, 'utf8');
    violations.push(...(file.endsWith('.ts')
      ? findTypeScriptPathKeyViolations(text, file)
      : findRustPathKeyViolations(text, file)));
  }
  if (violations.length > 0) {
    const rows = violations.map(value => `${value.file}:${value.line}:${value.reason}`);
    throw new Error(`CONTENT_ADDRESSED_STORAGE_FORBIDDEN:${rows.length}\n${rows.join('\n')}`);
  }
  console.log(`PATH_KEYED_STORAGE_OK files=${sourceFiles.length}`);
};

if (import.meta.main) await main();
