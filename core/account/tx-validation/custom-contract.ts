import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../protocol/boundary-validation';
import { UINT256_MAX, INT512_MAX, INT512_MIN } from '../../protocol/boundary/integer-ranges';
import { parseClauseFields } from '../../runtime/custom-contracts/abi';
import { TOKENS } from '../../config/constants';

const hex = (value: unknown, maxBytes: number): void => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(value) || (value.length - 2) / 2 > maxBytes) throw new Error('CUSTOM_CONTRACT_HEX_INVALID');
};
const integer = (value: unknown, min: number): void => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error('CUSTOM_CONTRACT_INTEGER_INVALID');
};
const amount = (value: unknown, signed = false): void => {
  if (typeof value !== 'bigint' || value < (signed ? INT512_MIN : 0n) || value > (signed ? INT512_MAX : UINT256_MAX)) throw new Error('CUSTOM_CONTRACT_AMOUNT_INVALID');
};
const rows = (value: unknown, effects: boolean): void => {
  if (!Array.isArray(value) || value.length > 128 || (!effects && value.length === 0)) throw new Error('CUSTOM_CONTRACT_ROWS_INVALID');
  const tokens = new Set<number>();
  for (const raw of value) {
    const row = requireBoundaryRecord(raw, 'CUSTOM_CONTRACT_ROW');
    requireExactBoundaryKeys(row, effects ? ['tokenId', 'amount'] : ['tokenId', 'leftAllowance', 'rightAllowance'], [], 'CUSTOM_CONTRACT_ROW');
    integer(row['tokenId'], 0);
    const token = row['tokenId'];
    if (typeof token !== 'number' || token > TOKENS.MAX_TOKEN_ID || tokens.has(token)) throw new Error('CUSTOM_CONTRACT_TOKEN_INVALID');
    tokens.add(token);
    if (effects) amount(row['amount'], true);
    else { amount(row['leftAllowance']); amount(row['rightAllowance']); }
  }
};

export const validateCustomContractProgram = (value: unknown): void => {
  const row = requireBoundaryRecord(value, 'CUSTOM_CONTRACT_PROGRAM');
  requireExactBoundaryKeys(row, ['transformerAddress', 'initcode', 'source', 'contractName', 'compilerVersion', 'schemas', 'encodedBatch', 'allowances'], [], 'CUSTOM_CONTRACT_PROGRAM');
  if (typeof row['transformerAddress'] !== 'string' || !/^0x[0-9a-f]{40}$/.test(row['transformerAddress'])) throw new Error('CUSTOM_CONTRACT_ADDRESS_INVALID');
  hex(row['initcode'], 12288);
  if (row['initcode'] === '0x') throw new Error('CUSTOM_CONTRACT_INITCODE_EMPTY');
  hex(row['encodedBatch'], 8192);
  if (typeof row['source'] !== 'string' || new TextEncoder().encode(row['source']).length > 65536) throw new Error('CUSTOM_CONTRACT_SOURCE_INVALID');
  if (typeof row['contractName'] !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(row['contractName'])) throw new Error('CUSTOM_CONTRACT_NAME_INVALID');
  if (row['compilerVersion'] !== '0.8.25+commit.b61c2a91.Emscripten.clang') throw new Error('CUSTOM_CONTRACT_COMPILER_INVALID');
  const schemas = requireBoundaryRecord(row['schemas'], 'CUSTOM_CONTRACT_SCHEMAS');
  requireExactBoundaryKeys(schemas, ['params', 'leftArguments', 'rightArguments'], [], 'CUSTOM_CONTRACT_SCHEMAS');
  Object.values(schemas).forEach(fields => parseClauseFields(JSON.stringify(fields)));
  rows(row['allowances'], false);
};

export const validateCustomContractTransition = (value: unknown): void => {
  const row = requireBoundaryRecord(value, 'CUSTOM_CONTRACT_TRANSITION');
  if (typeof row['id'] !== 'string' || !/^0x[0-9a-f]{64}$/.test(row['id'])) throw new Error('CUSTOM_CONTRACT_ID_INVALID');
  if (row['kind'] === 'propose') {
    requireExactBoundaryKeys(row, ['id', 'kind', 'program'], [], 'CUSTOM_CONTRACT_PROPOSE');
    validateCustomContractProgram(row['program']); return;
  }
  if (!['approve', 'reject', 'resolve', 'confirm'].includes(String(row['kind']))) throw new Error('CUSTOM_CONTRACT_KIND_INVALID');
  requireExactBoundaryKeys(row, ['id', 'kind', 'createdHeight', 'revision', ...(row['kind'] === 'resolve' ? ['leftArguments', 'rightArguments', 'effects'] : [])], [], 'CUSTOM_CONTRACT_TRANSITION');
  integer(row['createdHeight'], 1); integer(row['revision'], 1);
  if (row['kind'] === 'resolve') { hex(row['leftArguments'], 8192); hex(row['rightArguments'], 8192); rows(row['effects'], true); }
};
