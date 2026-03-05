/**
 * BigInt-safe serialization utilities
 * Handles JSON serialization with BigInt values across the XLN codebase
 */

/**
 * Converts BigInt values to strings for JSON serialization
 * @param key - JSON key
 * @param value - JSON value
 * @returns Serializable value
 */
export function bigIntReplacer(_key: string, value: any): any {
  if (typeof value === 'bigint') {
    return `BigInt(${value.toString()})`;
  }
  // Handle Map objects
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  // Handle Set objects
  if (value instanceof Set) {
    return Array.from(value);
  }
  // Handle Buffer objects
  if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return `Buffer(${value.data.length} bytes)`;
  }
  // Handle Functions
  if (typeof value === 'function') {
    return `[Function: ${value.name || 'anonymous'}]`;
  }
  return value;
}

/**
 * BigInt-safe JSON.stringify replacement
 * @param obj - Object to stringify
 * @param space - Formatting space (optional)
 * @returns JSON string
 */
export function safeStringify(obj: any, space?: number): string {
  try {
    return JSON.stringify(obj, bigIntReplacer, space);
  } catch (err) {
    return `[Error stringifying: ${(err as Error).message}]`;
  }
}

/**
 * BigInt-safe console logging for debugging
 * @param message - Log message
 * @param obj - Object to log (optional)
 */
export function safeLog(message: string, obj?: any): void {
  if (obj !== undefined) {
    console.log(message, safeStringify(obj, 2));
  } else {
    console.log(message);
  }
}

/**
 * Parse BigInt strings back to BigInt values
 * @param key - JSON key
 * @param value - JSON value
 * @returns Parsed value with BigInt restored
 */
export function bigIntReviver(_key: string, value: any): any {
  if (typeof value === 'string' && value.startsWith('BigInt(') && value.endsWith(')')) {
    const bigintStr = value.slice(7, -1); // Remove 'BigInt(' and ')'
    return BigInt(bigintStr);
  }
  return value;
}

/**
 * BigInt-safe JSON.parse replacement
 * @param jsonString - JSON string to parse
 * @returns Parsed object with BigInt values restored
 */
export function safeParse(jsonString: string): any {
  try {
    return JSON.parse(jsonString, bigIntReviver);
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${(err as Error).message}`);
  }
}

/**
 * Universal Buffer comparison (works in both Node.js and browser)
 * @param buf1 - First buffer
 * @param buf2 - Second buffer
 * @returns 0 if equal, -1 if buf1 < buf2, 1 if buf1 > buf2
 */
export function bufferCompare(buf1: Buffer, buf2: Buffer): number {
  if (typeof Buffer !== 'undefined' && Buffer.compare) {
    // Node.js environment
    return Buffer.compare(buf1, buf2);
  } else {
    // Browser environment - compare as hex strings
    const hex1 = buf1.toString('hex');
    const hex2 = buf2.toString('hex');
    if (hex1 === hex2) return 0;
    return hex1 < hex2 ? -1 : 1;
  }
}

/**
 * Universal Buffer equality check
 * @param buf1 - First buffer
 * @param buf2 - Second buffer
 * @returns true if buffers are equal
 */
export function buffersEqual(buf1: Buffer, buf2: Buffer): boolean {
  return bufferCompare(buf1, buf2) === 0;
}

type TaggedJson =
  | { __xlnType: 'BigInt'; value: string }
  | { __xlnType: 'Map'; value: [unknown, unknown][] }
  | { __xlnType: 'Set'; value: unknown[] }
  | { __xlnType: 'Uint8Array'; value: number[] };

const encodeTaggedJson = (value: unknown): unknown => {
  if (typeof value === 'bigint') return { __xlnType: 'BigInt', value: value.toString() } satisfies TaggedJson;
  if (value instanceof Map) return { __xlnType: 'Map', value: Array.from(value.entries()) } satisfies TaggedJson;
  if (value instanceof Set) return { __xlnType: 'Set', value: Array.from(value.values()) } satisfies TaggedJson;
  if (value instanceof Uint8Array) return { __xlnType: 'Uint8Array', value: Array.from(value) } satisfies TaggedJson;
  return value;
};

const decodeTaggedJson = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return value;
  const tagged = value as Partial<TaggedJson>;
  if (tagged.__xlnType === 'BigInt' && typeof tagged.value === 'string') return BigInt(tagged.value);
  if (tagged.__xlnType === 'Map' && Array.isArray(tagged.value)) return new Map(tagged.value);
  if (tagged.__xlnType === 'Set' && Array.isArray(tagged.value)) return new Set(tagged.value);
  if (tagged.__xlnType === 'Uint8Array' && Array.isArray(tagged.value)) return new Uint8Array(tagged.value);
  return value;
};

/**
 * Deterministic JSON snapshot codec for runtime persistence.
 * Preserves BigInt/Map/Set/Uint8Array across save/load.
 */
export function serializeTaggedJson(input: unknown, excludeKeys?: Set<string>): string {
  const alwaysExcluded = new Set(['clonedForValidation', 'jurisdiction', 'provider', 'ethersProvider']);
  const stack: object[] = [];

  const pack = (value: unknown): unknown => {
    if (typeof value === 'function') return undefined;
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return encodeTaggedJson(value);

    const objectRef = value as object;
    if (stack.includes(objectRef)) return undefined;
    stack.push(objectRef);
    try {
      if (value instanceof Map) {
        const entries: [unknown, unknown][] = [];
        for (const [k, v] of value.entries()) {
          const packedKey = pack(k);
          const packedValue = pack(v);
          if (packedKey !== undefined && packedValue !== undefined) {
            entries.push([packedKey, packedValue]);
          }
        }
        return { __xlnType: 'Map', value: entries } satisfies TaggedJson;
      }

      if (value instanceof Set) {
        const packedValues: unknown[] = [];
        for (const item of value.values()) {
          const packed = pack(item);
          if (packed !== undefined) packedValues.push(packed);
        }
        return { __xlnType: 'Set', value: packedValues } satisfies TaggedJson;
      }

      if (value instanceof Uint8Array) {
        return { __xlnType: 'Uint8Array', value: Array.from(value) } satisfies TaggedJson;
      }

      if (Array.isArray(value)) {
        return value.map((item) => {
          const packed = pack(item);
          return packed === undefined ? null : packed;
        });
      }

      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source)) {
        if (excludeKeys?.has(key) || alwaysExcluded.has(key)) continue;
        const packed = pack(source[key]);
        if (packed !== undefined) out[key] = packed;
      }
      return out;
    } finally {
      stack.pop();
    }
  };

  return JSON.stringify(pack(input));
}

export function deserializeTaggedJson<T = unknown>(json: string): T {
  return JSON.parse(json, (_key, value) => decodeTaggedJson(value)) as T;
}
