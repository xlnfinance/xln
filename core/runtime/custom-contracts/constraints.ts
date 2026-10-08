import { requireBoundaryRecord } from '../../protocol/boundary-validation';

/** Constructor effects cannot be reproduced by isolated runtime-code simulation. */
export const validateClauseAst = (output: Record<string, unknown>): void => {
  const sources = requireBoundaryRecord(output['sources'], 'CLAUSE_SOURCES');
  const source = requireBoundaryRecord(sources['Clause.sol'], 'CLAUSE_SOURCE');
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== 'object' || value === null) return;
    const node = requireBoundaryRecord(value, 'CLAUSE_AST');
    if (node['nodeType'] === 'FunctionDefinition' && node['kind'] === 'constructor') {
      throw new Error('CLAUSE_CONSTRUCTOR_NOT_SUPPORTED');
    }
    if (node['nodeType'] === 'VariableDeclaration' && node['stateVariable'] === true && node['constant'] !== true) {
      throw new Error('CLAUSE_STATE_VARIABLE_NOT_SUPPORTED');
    }
    Object.values(node).forEach(visit);
  };
  visit(source['ast']);
};
