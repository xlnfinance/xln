import { hexToBytes } from './primitives/encoding.ts';

export type ShardMessage = Readonly<{
  specId: unknown;
  shardIndex: unknown;
  result: unknown;
  requestId: unknown;
}>;

export function createShardSlots(shardCount: number): Array<Uint8Array | undefined> {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(`BRAINVAULT_SHARD_COUNT_INVALID:${shardCount}`);
  }
  return new Array<Uint8Array | undefined>(shardCount);
}

export function acceptShard(
  slots: Array<Uint8Array | undefined>,
  message: ShardMessage,
  expectedSpecId: string,
  outputBytes: number,
  expectedRequestId: (index: number) => string,
): number {
  if (message.specId !== expectedSpecId) {
    throw new Error('BRAINVAULT_WORKER_SPEC_MISMATCH');
  }
  const index = message.shardIndex;
  if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= slots.length) {
    throw new Error('BRAINVAULT_WORKER_SHARD_INDEX_INVALID');
  }
  if (slots[index as number] !== undefined) {
    throw new Error(`BRAINVAULT_WORKER_SHARD_DUPLICATE:${String(index)}`);
  }
  if (message.requestId !== expectedRequestId(index as number)) {
    throw new Error(`BRAINVAULT_WORKER_REQUEST_MISMATCH:${String(index)}`);
  }
  if (typeof message.result !== 'string' || message.result.length !== outputBytes * 2) {
    throw new Error(`BRAINVAULT_WORKER_RESULT_INVALID:${String(index)}`);
  }
  slots[index as number] = hexToBytes(message.result);
  return index as number;
}

export function finalizeShards(slots: Array<Uint8Array | undefined>): Uint8Array[] {
  const missing = slots.findIndex(shard => shard === undefined);
  if (missing !== -1) throw new Error(`BRAINVAULT_WORKER_SHARD_MISSING:${missing}`);
  return slots as Uint8Array[];
}
