import { expect, test } from 'bun:test';

import { createJAdapter } from '../jadapter';
import {
  computeBatchHankoHash,
  createEmptyBatch,
  encodeJBatch,
  getBatchSize,
} from '../jurisdiction/batch';
import { createEmptyEnv } from '../runtime';
import type { JTx } from '../types';

test('BrowserVM adapter rejects a mismatched sealed batch before mutating chain state', async () => {
  const chainId = 31337;
  const adapter = await createJAdapter({ mode: 'browservm', chainId });
  try {
    const batch = createEmptyBatch();
    batch.reserveToReserve.push({
      receivingEntity: `0x${'22'.repeat(32)}`,
      tokenId: 1,
      amount: 10n,
    });
    const encodedBatch = encodeJBatch(batch);
    const entityNonce = 1;
    const jTx: Extract<JTx, { type: 'batch' }> = {
      type: 'batch',
      entityId: `0x${'11'.repeat(32)}`,
      data: {
        batch,
        encodedBatch,
        batchHash: computeBatchHankoHash(
          BigInt(chainId),
          adapter.addresses.depository,
          encodedBatch,
          BigInt(entityNonce),
        ),
        entityNonce,
        hankoSignature: '0x1234',
        batchSize: getBatchSize(batch),
      },
      timestamp: 1_000,
    };
    jTx.data.batch.reserveToReserve[0]!.amount = 11n;

    const beforeRoot = await adapter.captureStateRoot!();
    const result = await adapter.submitTx(jTx, {
      env: createEmptyEnv('sealed-j-batch-adapter'),
      timestamp: jTx.timestamp,
    });
    const afterRoot = await adapter.captureStateRoot!();

    expect(result.success).toBe(false);
    expect(result.error).toStartWith('J_BATCH_ENCODING_MISMATCH:');
    expect(result.failure).toMatchObject({ category: 'terminal' });
    expect(afterRoot).toEqual(beforeRoot);
  } finally {
    await adapter.close();
  }
}, 30_000);
