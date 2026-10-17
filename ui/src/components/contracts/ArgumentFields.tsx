import type { ClauseField } from '@xln/core/runtime/custom-contracts/types';

export type FieldValues = Record<string, string | boolean>;
export const fieldArguments = (fields: readonly ClauseField[], values: FieldValues): unknown[] => fields.map(field => {
  const value = values[field.name] ?? (field.type === 'bool' ? false : '');
  if (field.type.includes('[') || field.type.startsWith('tuple') || field.type.startsWith('(')) return JSON.parse(String(value));
  return value;
});

/** AI controls labels/types, never executable markup or JavaScript. */
export function ArgumentFields({ fields, values, onChange, prefix }: {
  fields: readonly ClauseField[]; values: FieldValues; onChange: (value: FieldValues) => void; prefix: string;
}) {
  return <div className="stack" style={{ gap: 12 }}>{fields.map(field => <label className="field" key={field.name}>
    <span>{field.label} <small className="muted">{field.type}</small></span>
    {field.type === 'bool' ? <input type="checkbox" data-testid={`${prefix}-${field.name}`} checked={values[field.name] === true}
      onChange={event => onChange({ ...values, [field.name]: event.target.checked })} /> :
      <input className="input" data-testid={`${prefix}-${field.name}`} value={String(values[field.name] ?? '')}
        placeholder={field.type.includes('[') ? 'JSON array' : field.type} onChange={event => onChange({ ...values, [field.name]: event.target.value })} />}
  </label>)}</div>;
}
