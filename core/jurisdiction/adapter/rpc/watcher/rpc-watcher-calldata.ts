import { ethers } from 'ethers';
import { DepositoryBounds__factory, Depository__factory } from '../../../../../jurisdictions/typechain-types';
import { decodeIncludedTronTransactionCall } from '../../operations/tron-transaction';
import { HANKO_MAX_BYTES } from '../../../../hanko/codec';
import { J_BATCH_CONTRACT_LIMITS } from '../../../machine/batch/limits';

/** Native SolidityNode `walletsolidity/gettransactionbyid` for one bare txID. */
export type SolidifiedTronTransactionReader = (txId: string) => Promise<unknown>;

/** Native TRON receipt binding: sha256(raw_data) == txID, unavailable in the eth-compatible view. */
export const readIncludedTronCalldata = async (
  readTransaction: SolidifiedTronTransactionReader,
  txHash: string,
): Promise<string> => {
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new Error(`J_DISPUTE_TX_HASH_INVALID:${txHash}`);
  const response = await readTransaction(txHash.slice(2));
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`J_DISPUTE_TX_MISSING:${txHash}`);
  }
  const transaction = response as Record<string, unknown>;
  if (Object.keys(transaction).length === 0) throw new Error(`J_DISPUTE_TX_MISSING:${txHash}`);
  const claimed = typeof transaction['txID'] === 'string' ? `0x${transaction['txID'].toLowerCase()}` : '';
  if (claimed !== txHash) {
    throw new Error(`J_DISPUTE_TX_HASH_CLAIM_MISMATCH:${txHash}:${claimed || 'missing'}`);
  }
  const rawData = transaction['raw_data_hex'];
  try {
    if (typeof rawData !== 'string') throw new Error('TRON_RAW_DATA_MISSING');
    return decodeIncludedTronTransactionCall(txHash, `0x${rawData}`).data;
  } catch (error) {
    throw new Error(`J_DISPUTE_TX_HASH_INVALID:${txHash}`, { cause: error });
  }
};

const requireValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('J_DISPUTE_CALL_LAYOUT_VALUE_MISSING');
  return value;
};
type Schema = Readonly<{
  param: ethers.ParamType;
  dynamic: boolean;
  size: number;
  children: readonly Schema[];
}>;
const schema = (param: ethers.ParamType): Schema => {
  const children = param.isTuple()
    ? param.components.map(schema)
    : param.isArray()
      ? [schema(param.arrayChildren)]
      : [];
  const dynamic =
    param.baseType === 'bytes' ||
    param.baseType === 'string' ||
    (param.isArray() && (param.arrayLength === -1 || requireValue(children[0]).dynamic)) ||
    (param.isTuple() && children.some(child => child.dynamic));
  const size = dynamic
    ? 32
    : param.isTuple()
      ? children.reduce((sum, child) => sum + child.size, 0)
      : param.isArray()
        ? param.arrayLength * requireValue(children[0]).size
        : 32;
  return { param, dynamic, size, children };
};
const depository = Depository__factory.createInterface();
const calls = (['processBatch', 'watchtowerCounterDispute'] as const).map(name => {
  const fragment = depository.getFunction(name);
  if (!fragment) throw new Error(`J_DISPUTE_CALL_FRAGMENT_MISSING:${name}`);
  return { name, selector: ethers.getBytes(fragment.selector), args: fragment.inputs.map(schema) };
});
const batchParam = DepositoryBounds__factory.createInterface().getFunction('assertBatch')?.inputs[0];
const batchSchema = schema(requireValue(batchParam));
const maxCallBytes = 4 + 5 * 32 + J_BATCH_CONTRACT_LIMITS.maxEncodedBatchBytes + HANKO_MAX_BYTES;
type RawTuple = Readonly<{ start: number; layout: Schema }>;
export type RawDisputeEntry = Readonly<{
  eventNames: readonly string[];
  tuple: RawTuple;
  body: RawTuple;
  watchtower: boolean;
}>;

/** Raw canonical ABI spans. Memo entries have intrinsic ends, independent of callers' limits. */
export class DisputeCalldata {
  readonly bytes: Uint8Array;
  private readonly ends = new Map<Schema, Map<number, number | null>>();
  private readonly hashes = new Map<string, string>();
  readonly decodedBodies = new Map<string, unknown>();
  hasCanonicalCall = false;

  constructor(data: string) {
    this.bytes = ethers.getBytes(data);
  }

  word(start: number): number | null {
    if (start < 0 || start + 32 > this.bytes.length) return null;
    for (let i = start; i < start + 26; i += 1) if (this.bytes[i] !== 0) return null;
    let value = 0;
    for (let i = start + 26; i < start + 32; i += 1) value = value * 256 + requireValue(this.bytes[i]);
    return value;
  }

  hex(start: number, end: number): string {
    return ethers.hexlify(this.bytes.subarray(start, end));
  }

  private tupleEnd(start: number, count: number, childAt: (index: number) => Schema): number | null {
    if (count > (this.bytes.length - start) / 32) return null;
    let tail = start;
    for (let i = 0; i < count; i += 1) tail += childAt(i).size;
    if (tail > this.bytes.length) return null;
    let slot = start;
    for (let i = 0; i < count; i += 1) {
      const child = childAt(i);
      if (child.dynamic && this.word(slot) !== tail - start) return null;
      const end = this.end(child.dynamic ? tail : slot, child);
      if (end === null) return null;
      if (child.dynamic) tail = end;
      slot += child.size;
    }
    return tail;
  }

  end(start: number, layout: Schema): number | null {
    let memo = this.ends.get(layout);
    if (!memo) {
      memo = new Map();
      this.ends.set(layout, memo);
    }
    const cached = memo.get(start);
    if (cached !== undefined) return cached;
    const end = this.computeEnd(start, layout);
    memo.set(start, end);
    return end;
  }

  private computeEnd(start: number, layout: Schema): number | null {
    if (start < 0 || start + 32 > this.bytes.length) return null;
    const { param, children } = layout;
    if (param.isTuple()) return this.tupleEnd(start, children.length, i => requireValue(children[i]));
    if (param.isArray()) {
      const count = param.arrayLength === -1 ? this.word(start) : param.arrayLength;
      return count === null || count * requireValue(children[0]).size > maxCallBytes
        ? null
        : this.tupleEnd(start + (param.arrayLength === -1 ? 32 : 0), count, () => requireValue(children[0]));
    }
    if (param.baseType === 'bytes' || param.baseType === 'string') {
      const length = this.word(start);
      if (length === null || length > maxCallBytes) return null;
      const end = start + 32 + Math.ceil(length / 32) * 32;
      if (end > this.bytes.length) return null;
      for (let i = start + 32 + length; i < end; i += 1) if (this.bytes[i] !== 0) return null;
      return end;
    }
    return this.scalarEnd(start, param.type);
  }

  private scalarEnd(start: number, type: string): number | null {
    if (type === 'bool') return this.word(start) === 0 || this.word(start) === 1 ? start + 32 : null;
    const width =
      type === 'address'
        ? 20
        : /^(?:u?int|bytes)[0-9]+$/.test(type)
          ? Number(type.replace(/^[a-z]+/, '')) / (type.startsWith('bytes') ? 1 : 8)
          : 32;
    const fixedBytes = type.startsWith('bytes');
    const padding = type.startsWith('int') && (requireValue(this.bytes[start + 32 - width]) & 128) !== 0 ? 255 : 0;
    for (let i = 0; i < 32 - width; i += 1) {
      if (this.bytes[start + (fixedBytes ? width + i : i)] !== padding) return null;
    }
    return start + 32;
  }

  private field(tuple: RawTuple, name: string): RawTuple {
    let slot = tuple.start;
    for (const child of tuple.layout.children) {
      if (child.param.name === name)
        return {
          start: child.dynamic ? tuple.start + requireValue(this.word(slot)) : slot,
          layout: child,
        };
      slot += child.size;
    }
    throw new Error(`J_DISPUTE_CALL_LAYOUT_FIELD_MISSING:${name}`);
  }

  value(tuple: RawTuple, name: string): string {
    const { start, layout } = this.field(tuple, name);
    if (layout.param.baseType === 'bytes') return this.hex(start + 32, start + 32 + requireValue(this.word(start)));
    if (layout.param.type === 'bytes32') return this.hex(start, start + 32);
    return ethers.toBigInt(this.bytes.subarray(start, start + 32)).toString();
  }

  *canonicalCalls(): Generator<{ offset: number; end: number; call: (typeof calls)[number] }> {
    for (let offset = 0; offset + 4 <= this.bytes.length; offset += 1) {
      const call = calls.find(candidate => candidate.selector.every((byte, i) => this.bytes[offset + i] === byte));
      if (!call) continue;
      const args = offset + 4;
      const lastSlot = call.args.findLastIndex(arg => arg.dynamic);
      const lastOffset = this.word(args + lastSlot * 32);
      if (lastOffset === null || lastOffset < call.args.length * 32) continue;
      const length = this.word(args + lastOffset);
      if (length === null) continue;
      const end = args + lastOffset + 32 + Math.ceil(length / 32) * 32;
      if (end > this.bytes.length || end - offset > maxCallBytes) continue;
      if (this.tupleEnd(args, call.args.length, i => requireValue(call.args[i])) !== end) continue;
      this.hasCanonicalCall = true;
      yield { offset, end, call };
    }
  }

  private entry(
    tuple: RawTuple,
    eventNames: readonly string[],
    bodyName: string,
    watchtower = false,
  ): RawDisputeEntry | null {
    const body = this.field(tuple, bodyName);
    const end = requireValue(this.end(body.start, body.layout));
    if (end - body.start + 32 > J_BATCH_CONTRACT_LIMITS.maxDisputeProofBodyBytes) return null;
    return { tuple, body, eventNames, watchtower };
  }

  *entries(): Generator<RawDisputeEntry> {
    // Offset zero is yielded before scanning any embedded selectors. No claimed span advances the scanner.
    for (const { offset, end, call } of this.canonicalCalls()) {
      if (call.name === 'watchtowerCounterDispute') {
        if (end - offset > J_BATCH_CONTRACT_LIMITS.maxEncodedBatchBytes) continue;
        const tuple = { start: offset + 4 + requireValue(this.word(offset + 36)), layout: requireValue(call.args[1]) };
        const entry = this.entry(tuple, ['CounterDisputeRegistered', 'DisputeFinalized'], 'finalProofbody', true);
        if (entry) yield entry;
      } else {
        yield* this.batchEntries(offset);
      }
    }
  }

  private *batchEntries(offset: number): Generator<RawDisputeEntry> {
    const data = offset + 4 + requireValue(this.word(offset + 4));
    const length = requireValue(this.word(data));
    const start = data + 32;
    if (length > J_BATCH_CONTRACT_LIMITS.maxEncodedBatchBytes || this.word(start) !== 32) return;
    const tuple = { start: start + 32, layout: batchSchema };
    const batchEnd = this.end(tuple.start, tuple.layout);
    if (batchEnd === null || batchEnd > start + length) return;
    const kinds = [
      ['disputeStarts', 'DisputeStarted', 'initialProofbody'],
      ['counterDisputes', 'CounterDisputeRegistered', 'counterProofbody'],
      ['disputeFinalizations', 'DisputeFinalized', 'finalProofbody'],
    ] as const;
    for (const [name, event, bodyName] of kinds) {
      const array = this.field(tuple, name);
      const head = array.start + 32;
      for (let i = 0; i < requireValue(this.word(array.start)); i += 1) {
        const item = {
          start: head + requireValue(this.word(head + i * 32)),
          layout: requireValue(array.layout.children[0]),
        };
        const entry = this.entry(item, [event], bodyName);
        if (entry) yield entry;
      }
    }
  }

  encodedBody(entry: RawDisputeEntry): Uint8Array {
    const end = requireValue(this.end(entry.body.start, entry.body.layout));
    const encoded = new Uint8Array(32 + end - entry.body.start);
    encoded[31] = 32; // abi.encode(single dynamic tuple) prefixes its tail with offset 32.
    encoded.set(this.bytes.subarray(entry.body.start, end), 32);
    return encoded;
  }

  bodyHash(entry: RawDisputeEntry): string {
    const key = `${entry.body.start}:${this.end(entry.body.start, entry.body.layout)}`;
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = ethers.keccak256(this.encodedBody(entry));
      this.hashes.set(key, hash);
    }
    return hash;
  }

  /** One bounded executed call; never ABI-decode embedded selector candidates. */
  directCallData(): string | null {
    if (this.bytes.length > maxCallBytes) return null;
    const call = calls.find(call => call.selector.every((byte, i) => this.bytes[i] === byte));
    if (!call) return null;
    if (call.name === 'processBatch') {
      const offset = this.word(4);
      if (offset === null) return null;
      const length = this.word(4 + offset);
      const root = this.word(4 + offset + 32);
      // A forwarding wrapper's opaque bytes are not themselves an encoded Batch.
      if (
        length === null ||
        length > J_BATCH_CONTRACT_LIMITS.maxEncodedBatchBytes ||
        root === null ||
        root + 32 > length
      )
        return null;
    } else if (this.bytes.length > J_BATCH_CONTRACT_LIMITS.maxEncodedBatchBytes) return null;
    return this.hex(0, this.bytes.length);
  }

  assertRecognized(kind: string): void {
    if (this.hasCanonicalCall) return;
    const recognized = calls.some(call => call.selector.every((byte, i) => this.bytes[i] === byte));
    throw new Error(`J_DISPUTE_${kind}_CALLDATA_${recognized ? 'DECODE_FAILED' : 'UNKNOWN'}`);
  }
}

/** Call-span inspection helper; financial recovery uses entries(), which also visits nested spans. */
export const extractEmbeddedDisputeCalls = (data: string): string[] => {
  const raw = new DisputeCalldata(data);
  const result: string[] = [];
  let consumed = 0;
  for (const { offset, end } of raw.canonicalCalls()) {
    if (offset < consumed) continue;
    result.push(raw.hex(offset, end));
    consumed = end;
  }
  return result;
};
