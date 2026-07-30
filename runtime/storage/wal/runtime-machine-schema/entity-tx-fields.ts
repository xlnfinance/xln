import {
  requireArray,
  requireBigInt,
  requireBoolean,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
  requireStringArray,
} from './primitives';

export type EntityTxFieldKind =
  | 'array'
  | 'bigint'
  | 'bigintOrString'
  | 'boolean'
  | 'integer'
  | 'record'
  | 'string'
  | 'stringArray';

export type EntityTxDataSchema = Readonly<{
  required?: Readonly<Record<string, EntityTxFieldKind>>;
  optional?: Readonly<Record<string, EntityTxFieldKind>>;
  literals?: Readonly<Record<string, readonly unknown[]>>;
}>;

const validateField = (
  value: unknown,
  kind: EntityTxFieldKind,
  code: string,
): void => {
  switch (kind) {
    case 'array':
      requireArray(value, code);
      return;
    case 'bigint':
      requireBigInt(value, code);
      return;
    case 'bigintOrString':
      if (typeof value !== 'bigint' && typeof value !== 'string') throw new Error(code);
      return;
    case 'boolean':
      requireBoolean(value, code);
      return;
    case 'integer':
      requireBoundaryInteger(value, code);
      return;
    case 'record':
      requireBoundaryRecord(value, code);
      return;
    case 'string':
      requireString(value, code);
      return;
    case 'stringArray':
      requireStringArray(value, code);
      return;
  }
};

export const validateEntityTxDataFields = (
  value: unknown,
  schema: EntityTxDataSchema,
  code: string,
): void => {
  const data = requireBoundaryRecord(value, code);
  const required = schema.required ?? {};
  const optional = schema.optional ?? {};
  requireExactBoundaryKeys(
    data,
    Object.keys(required),
    Object.keys(optional),
    `${code}_FIELDS`,
  );
  for (const [field, kind] of Object.entries(required)) {
    validateField(data[field], kind, `${code}_${field.toUpperCase()}`);
  }
  for (const [field, kind] of Object.entries(optional)) {
    if (data[field] !== undefined) {
      validateField(data[field], kind, `${code}_${field.toUpperCase()}`);
    }
  }
  for (const [field, allowed] of Object.entries(schema.literals ?? {})) {
    if (data[field] !== undefined && !allowed.includes(data[field])) {
      throw new Error(`${code}_${field.toUpperCase()}_VALUE`);
    }
  }
};
