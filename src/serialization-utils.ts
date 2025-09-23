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