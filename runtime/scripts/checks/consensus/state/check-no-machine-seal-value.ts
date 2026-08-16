import ts from 'typescript';

const MAP_ITERATOR_METHODS = new Set(['entries', 'keys', 'values', 'forEach']);

const isMapLikeType = (type: ts.Type, checker: ts.TypeChecker): boolean => {
  const text = checker.typeToString(type);
  if (text.startsWith('Map<') || text.startsWith('ReadonlyMap<')) return true;
  const name = type.getSymbol()?.getName();
  return name === 'Map' || name === 'ReadonlyMap';
};

const functionLike = (node: ts.Node | undefined): ts.FunctionLikeDeclaration | undefined => {
  if (!node) return undefined;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return node;
  }
  if (ts.isVariableDeclaration(node) && node.initializer) return functionLike(node.initializer);
  return undefined;
};

const resolveFunction = (
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration | undefined => {
  const direct = functionLike(expression);
  if (direct) return direct;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) return undefined;
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return functionLike(resolved.valueDeclaration);
};

const firstParamIsMachine = (
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  isMachine: (type: ts.Type) => boolean,
): boolean => {
  const type = checker.getTypeAtLocation(fn);
  const signature = type.getCallSignatures()[0];
  const parameter = signature?.getParameters()[0];
  if (!parameter?.valueDeclaration) return false;
  return isMachine(checker.getTypeOfSymbolAtLocation(parameter, parameter.valueDeclaration));
};

const isUnknownOrAny = (type: ts.Type): boolean =>
  (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0;

const flagMapIteration = (
  node: ts.Node,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  isMachine: (type: ts.Type) => boolean,
  violations: string[],
): void => {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  const loc = `${source.fileName}:${position.line + 1}:sealValue-map-iteration`;
  if (ts.isForOfStatement(node) && isMapLikeType(checker.getTypeAtLocation(node.expression), checker)) {
    violations.push(loc);
    return;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const receiver = node.expression.expression;
    const method = node.expression.name.text;
    if (
      ts.isIdentifier(receiver) &&
      receiver.text === 'Object' &&
      (method === 'keys' || method === 'values' || method === 'entries') &&
      node.arguments[0]
    ) {
      const argumentType = checker.getTypeAtLocation(node.arguments[0]);
      if (isMachine(argumentType) || isUnknownOrAny(argumentType)) violations.push(loc);
      return;
    }
    if (MAP_ITERATOR_METHODS.has(method) && isMapLikeType(checker.getTypeAtLocation(receiver), checker)) {
      violations.push(loc);
    }
    return;
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Map' &&
    node.arguments?.[0] &&
    isMapLikeType(checker.getTypeAtLocation(node.arguments[0]), checker)
  ) {
    violations.push(loc);
  }
};

const walkSealGraph = (
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  isMachine: (type: ts.Type) => boolean,
  seen: Set<ts.FunctionLikeDeclaration>,
  violations: string[],
): void => {
  if (seen.has(fn) || !fn.body) return;
  seen.add(fn);
  const source = fn.getSourceFile();
  const visit = (node: ts.Node): void => {
    flagMapIteration(node, source, checker, isMachine, violations);
    if (ts.isCallExpression(node)) {
      const callee = resolveFunction(node.expression, checker);
      if (callee) walkSealGraph(callee, checker, isMachine, seen, violations);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
};

const sealValueExpression = (node: ts.Node): ts.Expression | undefined => {
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'sealValue') {
    return node.initializer;
  }
  if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'sealValue') {
    return node.name;
  }
  return undefined;
};

export const collectSealValueGraphViolations = (
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  isMachine: (type: ts.Type) => boolean,
): string[] => {
  const violations: string[] = [];
  for (const source of sourceFiles) {
    const visit = (node: ts.Node): void => {
      const expression = sealValueExpression(node);
      const fn = expression ? resolveFunction(expression, checker) : undefined;
      if (fn && firstParamIsMachine(fn, checker, isMachine)) {
        walkSealGraph(fn, checker, isMachine, new Set(), violations);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
};
