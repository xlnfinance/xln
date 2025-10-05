/**
 * BigInt-safe JSON stringification for frontend
 * FINTECH-SAFETY: Never use raw JSON.stringify() - always use this!
 */

export function safeStringify(obj: any, space?: number): string {
  return JSON.stringify(
    obj,
    (_, value) => (typeof value === 'bigint' ? `${value}n` : value),
    space
  );
}
