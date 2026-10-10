import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import { TOKENS } from '../../config/constants';

type AccountTxFieldKind =
  | 'array'
  | 'bigint'
  | 'boolean'
  | 'integer'
  | 'record'
  | 'recordOrString'
  | 'string'
  | 'stringArray'
  | 'tokenId';

export type AccountTxDataSchema = Readonly<{
  required?: Readonly<Record<string, AccountTxFieldKind>>;
  optional?: Readonly<Record<string, AccountTxFieldKind>>;
  literals?: Readonly<Record<string, readonly unknown[]>>;
}>;

const validateField = (value: unknown, kind: AccountTxFieldKind, code: string): void => {
  if (kind === 'array' && Array.isArray(value)) return;
  if (kind === 'bigint' && typeof value === 'bigint') return;
  if (kind === 'boolean' && typeof value === 'boolean') return;
  if (kind === 'integer') {
    requireBoundaryInteger(value, code);
    return;
  }
  // Rust decodes every token id as u16. Without the upper bound a peer frame
  // reached createDeltaDraft with id 65536 and failed inside the transition.
  if (kind === 'tokenId') {
    if (requireBoundaryInteger(value, code) > TOKENS.MAX_TOKEN_ID) throw new Error(`${code}_DOMAIN`);
    return;
  }
  if (kind === 'record') {
    requireBoundaryRecord(value, code);
    return;
  }
  if (kind === 'recordOrString') {
    if (typeof value === 'string') return;
    requireBoundaryRecord(value, code);
    return;
  }
  if (kind === 'string' && typeof value === 'string') return;
  if (
    kind === 'stringArray' &&
    Array.isArray(value) &&
    value.every(entry => typeof entry === 'string')
  ) return;
  throw new Error(code);
};

export const validateAccountTxDataFields = (
  value: unknown,
  schema: AccountTxDataSchema,
  code: string,
): Record<string, unknown> => {
  const data = requireBoundaryRecord(value, code);
  const required = schema.required ?? {};
  const optional = schema.optional ?? {};
  requireExactBoundaryKeys(data, Object.keys(required), Object.keys(optional), `${code}_FIELDS`);
  for (const [field, kind] of Object.entries(required)) {
    validateField(data[field], kind, `${code}_${field.toUpperCase()}`);
  }
  for (const [field, kind] of Object.entries(optional)) {
    if (data[field] !== undefined) validateField(data[field], kind, `${code}_${field.toUpperCase()}`);
  }
  for (const [field, allowed] of Object.entries(schema.literals ?? {})) {
    if (data[field] !== undefined && !allowed.includes(data[field])) {
      throw new Error(`${code}_${field.toUpperCase()}_VALUE`);
    }
  }
  return data;
};
