import ts from 'typescript';

const importDeclarationHasValue = (node: ts.ImportDeclaration): boolean => {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return Boolean(bindings);
  return bindings.elements.some(element => !element.isTypeOnly);
};

const exportDeclarationHasValue = (node: ts.ExportDeclaration): boolean => {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) return true;
  return clause.elements.some(element => !element.isTypeOnly);
};

export const isValueModuleReference = (node: ts.Node): boolean => {
  if (ts.isImportDeclaration(node)) return importDeclarationHasValue(node);
  if (ts.isExportDeclaration(node)) return exportDeclarationHasValue(node);
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false;
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  );
};

type TarjanState = {
  nextIndex: number;
  indices: Map<string, number>;
  lowLinks: Map<string, number>;
  stack: string[];
  stacked: Set<string>;
  components: string[][];
};

const finishComponent = (node: string, state: TarjanState): void => {
  const component: string[] = [];
  while (state.stack.length > 0) {
    const member = state.stack.pop();
    if (!member) throw new Error('IMPORT_SCC_STACK_UNDERFLOW');
    state.stacked.delete(member);
    component.push(member);
    if (member === node) break;
  }
  state.components.push(component.sort());
};

const visitNode = (node: string, graph: ReadonlyMap<string, ReadonlySet<string>>, state: TarjanState): void => {
  const index = state.nextIndex++;
  state.indices.set(node, index);
  state.lowLinks.set(node, index);
  state.stack.push(node);
  state.stacked.add(node);

  for (const target of graph.get(node) ?? []) {
    if (!state.indices.has(target)) {
      visitNode(target, graph, state);
      state.lowLinks.set(node, Math.min(state.lowLinks.get(node)!, state.lowLinks.get(target)!));
    } else if (state.stacked.has(target)) {
      state.lowLinks.set(node, Math.min(state.lowLinks.get(node)!, state.indices.get(target)!));
    }
  }
  if (state.lowLinks.get(node) === state.indices.get(node)) finishComponent(node, state);
};

export const findValueImportComponents = (graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] => {
  const state: TarjanState = {
    nextIndex: 0,
    indices: new Map(),
    lowLinks: new Map(),
    stack: [],
    stacked: new Set(),
    components: [],
  };
  for (const node of [...graph.keys()].sort()) {
    if (!state.indices.has(node)) visitNode(node, graph, state);
  }
  return state.components.sort((left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!));
};
