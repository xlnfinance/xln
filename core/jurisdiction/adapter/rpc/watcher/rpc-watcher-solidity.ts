import { ethers } from 'ethers';

const requireValue = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('J_DISPUTE_CALL_LAYOUT_VALUE_MISSING');
  return value;
};

export type Schema = Readonly<{
  param: ethers.ParamType;
  dynamic: boolean;
  size: number;
  children: readonly Schema[];
}>;
export const schema = (param: ethers.ParamType): Schema => {
  const children = param.isTuple() ? param.components.map(schema) : param.isArray() ? [schema(param.arrayChildren)] : [];
  const dynamic = param.baseType === 'bytes' || param.baseType === 'string' ||
    (param.isArray() && (param.arrayLength === -1 || requireValue(children[0]).dynamic)) ||
    (param.isTuple() && children.some(child => child.dynamic));
  const size = dynamic ? 32 : param.isTuple() ? children.reduce((sum, child) => sum + child.size, 0) :
    param.isArray() ? param.arrayLength * requireValue(children[0]).size : 32;
  return { param, dynamic, size, children };
};

/** solc 0.8.37 abi_decode: bounds and scalar cleanup, never canonical layout or bytes padding.
 * ethers loose decoding handles unpadded bytes but accepts dirty bool/uintN values;
 * check those here before ethers can coerce them into a different proof preimage.
 */
export const assertSolidityAbi = (bytes: Uint8Array, params: readonly Schema[]): void => {
  const seen = new Map<Schema, Set<number>>();
  const fail = (): never => { throw new Error('J_DISPUTE_SOLIDITY_ABI_INVALID'); };
  const bound = (start: number, size: number): void => {
    if (!Number.isSafeInteger(start) || start < 0 || size > bytes.length - start) fail();
  };
  const integer = (start: number): number => {
    bound(start, 32);
    const value = ethers.toBigInt(bytes.subarray(start, start + 32));
    // Anything beyond JS's exact range cannot address this Uint8Array. solc's
    // uint64 ceiling is larger; neither admits an out-of-bounds referenced region.
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return Number(value);
  };
  const scalar = (start: number, param: ethers.ParamType): void => {
    bound(start, 32);
    const raw = ethers.toBigInt(bytes.subarray(start, start + 32));
    if (param.type === 'bool' && raw > 1n) fail();
    const width = param.type === 'address' ? 160 : /^(u?int)[0-9]+$/.test(param.type) ? Number(param.type.replace(/^u?int/, '')) : 256;
    if (width === 256) return;
    const cleaned = param.type.startsWith('int') ? BigInt.asUintN(256, BigInt.asIntN(width, raw)) : BigInt.asUintN(width, raw);
    if (raw !== cleaned) fail();
  };
  const tuple = (start: number, count: number, childAt: (index: number) => Schema): void => {
    // Every ABI element owns at least one head word, even when tails alias.
    bound(start, count * 32);
    let slot = start;
    for (let index = 0; index < count; index += 1) {
      const child = childAt(index);
      bound(slot, child.size);
      visit(child.dynamic ? start + integer(slot) : slot, child);
      slot += child.size;
    }
  };
  const visit = (start: number, layout: Schema): void => {
    let positions = seen.get(layout);
    if (!positions) { positions = new Set(); seen.set(layout, positions); }
    if (positions.has(start)) return;
    positions.add(start);
    const { param, children } = layout;
    if (param.isTuple()) tuple(start, children.length, index => requireValue(children[index]));
    else if (param.isArray()) {
      const count = param.arrayLength === -1 ? integer(start) : param.arrayLength;
      tuple(start + (param.arrayLength === -1 ? 32 : 0), count, () => requireValue(children[0]));
    } else if (param.baseType === 'bytes' || param.baseType === 'string') bound(start + 32, integer(start));
    else scalar(start, param);
  };
  tuple(0, params.length, index => requireValue(params[index]));
};
