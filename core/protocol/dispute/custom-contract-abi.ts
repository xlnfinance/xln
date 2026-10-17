import { AbiCoder, Interface, ParamType } from 'ethers';
import type { ClauseField } from '../../runtime/custom-contracts/types';

export const CUSTOM_TRANSFORMER_ABI = [
  'function applyBatch((int256 high,uint256 middle,uint256 low)[] deltas,uint256[] tokenIds,bytes encodedBatch,bytes leftArguments,bytes rightArguments,uint256 leftArgumentsTimestamp,uint256 rightArgumentsTimestamp,bytes32 leftEntity,bytes32 rightEntity,uint256 disputeStartTimestamp,uint256 disputeTimeout,uint32 leftResponseSeconds,uint32 rightResponseSeconds) view returns ((int256 high,uint256 middle,uint256 low)[])',
  'function paramsSchema() pure returns (string)',
  'function leftArgsSchema() pure returns (string)',
  'function rightArgsSchema() pure returns (string)',
] as const;
export const customTransformerInterface = new Interface(CUSTOM_TRANSFORMER_ABI);

export function parseClauseFields(json: string): ClauseField[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw) || raw.length > 16) throw new Error('CLAUSE_SCHEMA_INVALID');
  const names = new Set<string>();
  return raw.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'label,name,type') throw new Error('CLAUSE_SCHEMA_FIELD_INVALID');
    const name = Reflect.get(value, 'name');
    const type = Reflect.get(value, 'type');
    const label = Reflect.get(value, 'label');
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || names.has(name)) {
      throw new Error('CLAUSE_SCHEMA_NAME_INVALID');
    }
    if (typeof type !== 'string' || typeof label !== 'string' || label.length > 120) {
      throw new Error('CLAUSE_SCHEMA_FIELD_INVALID');
    }
    ParamType.from(type);
    names.add(name);
    return { name, type, label };
  });
}

export function encodeClauseFields(fields: readonly ClauseField[], values: readonly unknown[]): string {
  if (fields.length !== values.length) throw new Error('CLAUSE_ARGUMENT_COUNT_MISMATCH');
  return fields.length === 0 ? '0x' : AbiCoder.defaultAbiCoder().encode(fields.map(field => field.type), values);
}
