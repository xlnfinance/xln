/** Flat path-keyed Runtime outbox rows and their ordered byte commitment. */

import { sha256 } from '@noble/hashes/sha2.js';
import type { RoutedEntityInput } from '../../runtime/types';
import { decodeRoutedEntityInput } from '../../runtime/delivery/topology/routing-validation';
import {
  toRuntimeOutputsDigest,
  type RuntimeOutputsDigest,
} from '../../protocol/hashes';
import { Buffer } from '../../support/platform-crypto';
import {
  prepareBoundedStorageValueRows,
  readBoundedEncodedValue,
  type BoundedStorageRow,
} from '../codec/bounded-value';
import { decodeBuffer, encodeBuffer } from '../codec/codec';
import { keyRuntimeOutputRow } from '../keys';
import type { RuntimeDbLike } from '../types';

export const MAX_RUNTIME_OUTPUT_ROWS = 10_000;
const OUTBOX_DIGEST_DOMAIN = Buffer.from('xln.runtime.outbox.v1', 'utf8');

export type RuntimeOutputCommitment = Readonly<{
  count: number;
  digest: RuntimeOutputsDigest;
}>;

const u32 = (value: number): Buffer => {
  const encoded = Buffer.allocUnsafe(4);
  encoded.writeUInt32BE(value);
  return encoded;
};

const computeRuntimeOutputsDigest = (
  rows: readonly Uint8Array[],
): RuntimeOutputsDigest => {
  if (rows.length > MAX_RUNTIME_OUTPUT_ROWS) {
    throw new Error(`STORAGE_RUNTIME_OUTPUT_COUNT_MAX:${rows.length}`);
  }
  const digest = sha256.create();
  digest.update(OUTBOX_DIGEST_DOMAIN);
  digest.update(u32(rows.length));
  for (const row of rows) {
    if (row.byteLength > 0xffff_ffff) {
      throw new Error(`STORAGE_RUNTIME_OUTPUT_BYTES_MAX:${row.byteLength}`);
    }
    digest.update(u32(row.byteLength));
    digest.update(row);
  }
  return toRuntimeOutputsDigest(`0x${Buffer.from(digest.digest()).toString('hex')}`);
};

export const prepareRuntimeOutputRows = (
  height: number,
  outputs: readonly RoutedEntityInput[],
): Readonly<{
  commitment: RuntimeOutputCommitment;
  rows: BoundedStorageRow[];
}> => {
  if (outputs.length > MAX_RUNTIME_OUTPUT_ROWS) {
    throw new Error(`STORAGE_RUNTIME_OUTPUT_COUNT_MAX:${outputs.length}`);
  }
  const encoded = outputs.map(output => encodeBuffer(output, { omitSymbolKeys: true }));
  return {
    commitment: { count: encoded.length, digest: computeRuntimeOutputsDigest(encoded) },
    rows: encoded.flatMap((value, index) =>
      prepareBoundedStorageValueRows(keyRuntimeOutputRow(height, index), value)),
  };
};

export const readRuntimeOutputRows = async (
  db: RuntimeDbLike,
  height: number,
  commitment: RuntimeOutputCommitment,
): Promise<RoutedEntityInput[]> => {
  if (!Number.isSafeInteger(commitment.count) || commitment.count < 0 ||
      commitment.count > MAX_RUNTIME_OUTPUT_ROWS) {
    throw new Error(`STORAGE_RUNTIME_OUTPUT_COUNT_INVALID:${String(commitment.count)}`);
  }
  const encoded = await Promise.all(Array.from({ length: commitment.count }, async (_, index) => {
    const value = await readBoundedEncodedValue(db, keyRuntimeOutputRow(height, index));
    if (!value) throw new Error(`STORAGE_RUNTIME_OUTPUT_ROW_MISSING:${height}:${index}`);
    return value;
  }));
  const digest = computeRuntimeOutputsDigest(encoded);
  if (digest !== commitment.digest) {
    throw new Error(
      `STORAGE_RUNTIME_OUTPUT_DIGEST_MISMATCH:height=${height}:` +
      `expected=${commitment.digest}:actual=${digest}`,
    );
  }
  return encoded.map((value, index) => {
    try {
      return decodeRoutedEntityInput(decodeBuffer(value));
    } catch (error) {
      throw new Error(`STORAGE_RUNTIME_OUTPUT_ROW_INVALID:${index}`, { cause: error });
    }
  });
};
