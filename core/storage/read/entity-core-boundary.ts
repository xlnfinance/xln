export const withDefinedProperty = <K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> => value === undefined ? {} : ({ [key]: value } as Record<K, V>);
