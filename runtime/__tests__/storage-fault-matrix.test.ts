import { describe, expect, test } from 'bun:test';

import {
  STORAGE_MAX_PHYSICAL_VALUE_BYTES,
  withRebranchedValues,
} from '../storage/rebranched-db';
import {
  DeterministicFaults,
  faultMatrixSeeds,
  withFaultSeed,
} from './fixtures/deterministic-faults';
import {
  MemoryRuntimeDb,
  TornBatchRuntimeDb,
} from './fixtures/memory-runtime-db';

const logicalKey = Buffer.from([0x24, 0x01]);
const originalValue = Buffer.alloc(48_000, 0x31);
const replacementValue = Buffer.alloc(48_000, 0x72);

const writeValue = async (
  db: ReturnType<typeof withRebranchedValues>,
  value: Buffer,
): Promise<void> => {
  const batch = db.batch();
  batch.put(logicalKey, value);
  await batch.write();
};

describe('deterministic storage fault matrix', () => {
  for (const faultSeed of faultMatrixSeeds()) {
    test(`rejects torn physical writes and recovers exactly seed=${faultSeed}`, async () =>
      withFaultSeed(faultSeed, async () => {
        const faults = new DeterministicFaults(faultSeed);
        const durable = new MemoryRuntimeDb();
        const faultingRaw = new TornBatchRuntimeDb(durable);
        const db = withRebranchedValues(faultingRaw);
        await writeValue(db, originalValue);

        faultingRaw.arm(1 + faults.pick(8));
        await expect(writeValue(db, replacementValue))
          .rejects.toThrow('SIM_STORAGE_TORN_BATCH');

        const restarted = withRebranchedValues(durable);
        await expect(restarted.get(logicalKey))
          .rejects.toThrow('STORAGE_REBRANCH_');

        await writeValue(restarted, replacementValue);
        expect(await restarted.get(logicalKey)).toEqual(replacementValue);
        expect(Math.max(...Array.from(
          durable.rows.values(),
          value => value.byteLength,
        ))).toBeLessThan(STORAGE_MAX_PHYSICAL_VALUE_BYTES);
      }));
  }
});
