import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createJAdapter } from '../../../jurisdiction/adapter';
import { parseNumberedEntityRegistrationReceipt } from '../../../runtime/registration/numbered-registration';

describe('numbered Entity registration authority', () => {
  test('receipt parser rejects missing, extra, reordered, and mismatched registrations', async () => {
    const adapter = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
    try {
      const boardHashes = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`] as const;
      const receipt = await (await adapter.entityProvider.registerNumberedEntitiesBatch(boardHashes)).wait();
      if (!receipt) throw new Error('NUMBERED_REGISTRATION_TEST_RECEIPT_MISSING');

      expect(parseNumberedEntityRegistrationReceipt(adapter, receipt, boardHashes)).toEqual([
        { entityNumber: 2, entityId: `0x${'2'.padStart(64, '0')}`, logIndex: 2 },
        { entityNumber: 3, entityId: `0x${'3'.padStart(64, '0')}`, logIndex: 6 },
      ]);
      expect(() => parseNumberedEntityRegistrationReceipt(
        adapter,
        receipt,
        [...boardHashes, `0x${'33'.repeat(32)}`],
      )).toThrow('NUMBERED_REGISTRATION_EVENT_COUNT_INVALID:expected=3:actual=2');
      expect(() => parseNumberedEntityRegistrationReceipt(adapter, receipt, [boardHashes[0]]))
        .toThrow('NUMBERED_REGISTRATION_EVENT_COUNT_INVALID:expected=1:actual=2');
      expect(() => parseNumberedEntityRegistrationReceipt(adapter, receipt, [...boardHashes].reverse()))
        .toThrow('NUMBERED_REGISTRATION_EVENT_BOARD_HASH_MISMATCH:index=0');
      expect(() => parseNumberedEntityRegistrationReceipt(
        adapter,
        receipt,
        [boardHashes[0], `0x${'44'.repeat(32)}`],
      )).toThrow('NUMBERED_REGISTRATION_EVENT_BOARD_HASH_MISMATCH:index=1');
    } finally {
      await adapter.close();
    }
  }, 30_000);

  test('production exports contain no direct numbered-registration writer', () => {
    const registration = readFileSync(
      join(process.cwd(), 'core/runtime/registration/numbered-registration.ts'),
      'utf8',
    );
    const publicUtilities = readFileSync(
      join(process.cwd(), 'core/api/public/public-utilities.ts'),
      'utf8',
    );

    expect(registration).not.toContain('.registerNumberedEntity(');
    expect(registration).not.toContain('.registerNumberedEntitiesBatch(');
    expect(registration).not.toContain('getNumberedRegistrationWallet');
    expect(publicUtilities).not.toContain('createNumberedEntity');
    expect(publicUtilities).not.toContain('createNumberedEntitiesBatch');
  });
});
