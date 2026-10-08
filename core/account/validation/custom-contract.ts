import { requireBoundaryRecord, requireExactBoundaryKeys, requireBoundaryInteger } from '../../protocol/boundary-validation';
import { validateCustomContractProgram, validateCustomContractTransition } from '../tx-validation/custom-contract';

const PROGRAM_FIELDS = ['transformerAddress', 'initcode', 'source', 'contractName', 'compilerVersion', 'schemas', 'encodedBatch', 'allowances'] as const;
export const validateCommittedCustomContract = (value: unknown): void => {
  const row = requireBoundaryRecord(value, 'CUSTOM_CONTRACT_STATE');
  requireExactBoundaryKeys(row, [...PROGRAM_FIELDS, 'status', 'proposerIsLeft', 'createdHeight', 'revision'], ['resolution'], 'CUSTOM_CONTRACT_STATE');
  validateCustomContractProgram(Object.fromEntries(PROGRAM_FIELDS.map(key => [key, row[key]])));
  if (!['active', 'proposed'].includes(String(row['status'])) || typeof row['proposerIsLeft'] !== 'boolean') throw new Error('CUSTOM_CONTRACT_STATE_ROLE');
  requireBoundaryInteger(row['createdHeight'], 'CUSTOM_CONTRACT_CREATED_HEIGHT', 1);
  requireBoundaryInteger(row['revision'], 'CUSTOM_CONTRACT_REVISION', 1);
  if (row['resolution'] === undefined) return;
  const resolution = requireBoundaryRecord(row['resolution'], 'CUSTOM_CONTRACT_RESOLUTION');
  requireExactBoundaryKeys(resolution, ['proposerIsLeft', 'leftArguments', 'rightArguments', 'effects'], [], 'CUSTOM_CONTRACT_RESOLUTION');
  if (row['status'] !== 'active' || typeof resolution['proposerIsLeft'] !== 'boolean') throw new Error('CUSTOM_CONTRACT_RESOLUTION_ROLE');
  validateCustomContractTransition({ kind: 'resolve', id: `0x${'0'.repeat(64)}`,
    createdHeight: row['createdHeight'], revision: row['revision'], leftArguments: resolution['leftArguments'],
    rightArguments: resolution['rightArguments'], effects: resolution['effects'] });
};
