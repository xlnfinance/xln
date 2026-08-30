import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { sha256 } from '@noble/hashes/sha2.js';

import { validateHtlcPreparedInfraContext } from '../../entity/paybook/prepared-context-validation';
import { HTLC_OPAQUE_CIPHERTEXT_VERSION } from '../../protocol/htlc/multi-recipient';
import { safeStringify } from '../../protocol/serialization';
import type { HtlcPreparedInfraContext } from '../../types/entity/htlc-infra-context';

const ENTITY = '0xe439def09623839817f6b74bdd4c54c0d5078635b5435cac2b2ab2809153a51c';
const PEER = '0x5d364af08764f6cfc396de3370245fd2c9e127a340fef4af39feba27e114a957';
const HASH = '0x540b75f0beeeb2f9ee37fe1ea52c61259294f9d997cd7e3884f311d6a0ec012e';
const CIPHERTEXT = 'suvroyPQHQTEmrN0ZCHdlqXMuBdJ/UnT1ko77xe8IwYNt4NrMNXLZlrx1eKYDGyXCF+LMkacuaIuJhqqzy9POeWNnVaWdkU2JvbW4o4AoUt7Lr6oJlTxrOKMXj3qgi86X3Do1kmgCJ9HNqGdTRwP2SNb0fQ=';
const GOLDEN_SHA256 = 'f5ccf77b1d0ec7c312dfe49f38cb4c5aea65ae5eb0f7801f9abea13b052e34a7';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

test('originated HTLC context has one canonical TS/Rust golden', () => {
  const context: HtlcPreparedInfraContext = {
    version: 1,
    entries: [],
    originated: [{
      txHash: HASH,
      targetEntityId: PEER,
      tokenId: 1,
      recipientAmount: 1_000n,
      route: [ENTITY, PEER],
      description: 'canonical payment note',
      deliveryMode: 'instant',
      startedAtMs: 1_700_000_000_000,
      hashlock: HASH,
      senderLockAmount: 1_010n,
      maxSenderDebit: 1_100n,
      totalFee: 10n,
      timelock: 1_700_000_100_000n,
      revealBeforeHeight: 123,
      nextHopEntityId: PEER,
      envelope: { version: HTLC_OPAQUE_CIPHERTEXT_VERSION, ciphertext: CIPHERTEXT },
    }],
  };
  const validated = validateHtlcPreparedInfraContext(context);
  const canonical = safeStringify(validated);
  const fixture = readFileSync(
    new URL('../../../rscore/fixtures/entity-kernel/originated-htlc-context-v1.json', import.meta.url),
    'utf8',
  ).trimEnd();

  expect(canonical).toBe(fixture);
  expect(hex(sha256(new TextEncoder().encode(canonical)))).toBe(GOLDEN_SHA256);
  expect(hex(sha256(Buffer.from(validated.originated[0]!.envelope.ciphertext, 'base64'))))
    .toBe('79f9bf7ce38da88ba654913a2321f43a70d5f6dd7bb44ae7e2fd9a3fac72c7ec');
});
