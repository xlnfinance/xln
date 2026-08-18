/**
 * Forbid validation checks that cannot fail.
 *
 * Consensus code repeatedly compares a claim against committed state. Two
 * shapes make such a comparison silently vacuous, and both shipped in this
 * repo before 2026-08-02:
 *
 *   R1 - the compared value is reconstructed from the claim itself:
 *
 *     const committedPrice = committed.priceTicks ?? claim.priceTicks;
 *     if (committedPrice !== claim.priceTicks) reject();   // never fires
 *
 *   R2 - both sides of the comparison are optional-guarded in one chain:
 *
 *     claim.price !== undefined && committed.price !== undefined
 *       && claim.price !== committed.price                 // skipped when absent
 *
 * Guarding the *claim* is correct (an omitted field is not a mismatch).
 * Guarding the *truth* is not: it turns missing committed state into a pass.
 *
 * A blanket ban on `??` is not possible here - these directories hold ~1100
 * legitimate coalescings - so this checks the exact defect, not the operator.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

/** Where a claim is checked against committed state. */
const SCAN_ROOTS = [
  'core/entity/consensus',
  'core/entity/tx/handlers',
  'core/account/tx/handlers',
  'core/account/consensus',
  'core/orderbook',
  'core/extensions/cross-j',
] as const;

const listFiles = (directory: string): string[] => readdirSync(directory, {
  withFileTypes: true,
}).flatMap(entry => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return listFiles(path);
  return entry.isFile() && path.endsWith('.ts') ? [path] : [];
});

/** Leftmost identifier of a property-access chain: `a.b.c` -> `a`. */
const accessRoot = (node: ts.Expression): string | null => {
  let current: ts.Node = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
};

const isCoalesce = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) &&
  (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
    node.operatorToken.kind === ts.SyntaxKind.BarBarToken);

const isEquality = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) &&
  (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken);

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

const enclosingBody = (node: ts.Node): ts.Node => {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isSourceFile(current)
    ) return current;
    current = current.parent;
  }
  return node;
};

const collect = <T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] => {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};

const violations: string[] = [];
let scanned = 0;

const report = (file: ts.SourceFile, node: ts.Node, rule: string, detail: string): void => {
  const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  violations.push(`${file.fileName}:${line}: ${rule} ${detail}`);
};

/**
 * Committed state, as this codebase names it. Direction is what separates a
 * safe default from a vacuous check:
 *
 *   claim ?? truth   - an omitted claim is not a mismatch. Correct.
 *   truth ?? claim   - missing truth adopts the claim. Vacuous.
 *
 * Only the second form is a defect, so the left operand must be the truth side.
 */
const TRUTH_ROOT = /^(committed|canonical|stored|persisted|live|resting)/i;

const readsCommittedState = (node: ts.Expression): boolean => {
  const root = accessRoot(node);
  if (root && TRUTH_ROOT.test(root)) return true;
  return /\.state\./.test(node.getText());
};

/**
 * R1: committed state falls back to object X, and the result is then compared
 * against X. Whatever the committed side held, the comparison holds by
 * construction.
 */
const checkReconstructedComparison = (file: ts.SourceFile): void => {
  for (const coalesce of collect(file, isCoalesce)) {
    if (!readsCommittedState(unwrap(coalesce.left))) continue;
    const substituteRoot = accessRoot(unwrap(coalesce.right));
    if (!substituteRoot) continue;

    // The coalescing result reaches a comparison either directly, or through a
    // const that is compared later in the same function body.
    const names: string[] = [];
    const parent = coalesce.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) names.push(parent.name.text);

    for (const equality of collect(enclosingBody(coalesce), isEquality)) {
      const left = unwrap(equality.left);
      const right = unwrap(equality.right);
      const sides: Array<[ts.Expression, ts.Expression]> = [[left, right], [right, left]];
      for (const [self, other] of sides) {
        const selfIsResult = self === coalesce ||
          (ts.isIdentifier(self) && names.includes(self.text));
        if (!selfIsResult) continue;
        if (accessRoot(other) !== substituteRoot) continue;
        report(
          file,
          equality,
          'VACUOUS_COMPARISON',
          `value substitutes \`${substituteRoot}\` and is then compared against \`${substituteRoot}\``,
        );
      }
    }
  }
};

/**
 * R2: an equality whose *both* operands are `!== undefined`-guarded in the same
 * `&&` chain. Guarding the claim alone is correct; guarding both means missing
 * committed state passes validation.
 */
const checkSelfDisablingGuard = (file: ts.SourceFile): void => {
  const isAndChain = (node: ts.Node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;

  for (const chain of collect(file, isAndChain)) {
    if (isAndChain(chain.parent)) continue; // only inspect whole chains
    const operands: ts.Expression[] = [];
    const flatten = (node: ts.Expression): void => {
      const inner = unwrap(node);
      if (isAndChain(inner)) { flatten(inner.left); flatten(inner.right); return; }
      operands.push(inner);
    };
    flatten(chain);

    const guarded = new Set<string>();
    for (const operand of operands) {
      if (!isEquality(operand)) continue;
      if (operand.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) continue;
      const left = unwrap(operand.left);
      const right = unwrap(operand.right);
      const undefinedSide = right.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(right) && right.text === 'undefined');
      if (undefinedSide) guarded.add(left.getText(file));
    }
    if (guarded.size < 2) continue;

    for (const operand of operands) {
      if (!isEquality(operand)) continue;
      const left = unwrap(operand.left).getText(file);
      const right = unwrap(operand.right).getText(file);
      if (right === 'undefined' || left === 'undefined') continue;
      if (!guarded.has(left) || !guarded.has(right)) continue;
      report(
        file,
        operand,
        'SELF_DISABLING_GUARD',
        `both \`${left}\` and \`${right}\` are undefined-guarded, so this comparison is skipped when either is absent`,
      );
    }
  }
};

for (const root of SCAN_ROOTS) {
  for (const path of listFiles(root)) {
    if (path.includes('/__tests__/')) continue;
    scanned += 1;
    const file = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    checkReconstructedComparison(file);
    checkSelfDisablingGuard(file);
  }
}

if (violations.length > 0) {
  throw new Error(
    'VACUOUS_VALIDATION: a check against committed state cannot fail as written.\n' +
    'Reject the missing field loudly instead of reconstructing or skipping it.\n' +
    violations.join('\n'),
  );
}

console.log(`NO_VACUOUS_VALIDATION_OK files=${scanned} rules=2`);
