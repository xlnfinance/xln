/** Clone one bounded protocol value without relying on proxy-hostile structuredClone. */

const cloneValue = (value: unknown, active: Set<object>, code: string): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (active.has(value)) throw new Error(`${code}_CYCLE`);
  active.add(value);
  try {
    if (value instanceof Uint8Array) return Uint8Array.from(value);
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) =>
        cloneValue(value[index], active, code));
    }
    if (value instanceof Map) {
      return new Map(Array.from(value, ([key, entry]) => [
        cloneValue(key, active, code),
        cloneValue(entry, active, code),
      ]));
    }
    if (value instanceof Set) {
      return new Set(Array.from(value, entry => cloneValue(entry, active, code)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${code}_UNSUPPORTED:${prototype?.constructor?.name ?? 'unknown'}`);
    }
    const cloned = Object.create(prototype) as Record<string, unknown>;
    // Symbol-keyed process capabilities are deliberately not protocol bytes.
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneValue(entry, active, code);
    }
    return cloned;
  } finally {
    active.delete(value);
  }
};

export const cloneIsolatedProtocolValue = <T>(
  value: T,
  code = 'PROTOCOL_VALUE_CLONE',
): T => cloneValue(value, new Set(), code) as T;
