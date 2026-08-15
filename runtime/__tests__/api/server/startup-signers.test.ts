import { describe, expect, test } from 'bun:test';
import { decodeStartupSigners } from '../../../api/server/startup-signers';
import { safeStringify } from '../../../protocol/serialization';

describe('managed Runtime startup signer boundary', () => {
  test('decodes the complete signer inventory before WAL replay', () => {
    expect(decodeStartupSigners(safeStringify([
      { seed: 'primary-seed', label: 'primary' },
      { seed: 'secondary-seed', label: 'secondary' },
    ]))).toEqual([
      { seed: 'primary-seed', label: 'primary' },
      { seed: 'secondary-seed', label: 'secondary' },
    ]);
  });

  test('rejects malformed, widened, and ambiguous signer inventories', () => {
    expect(() => decodeStartupSigners('{')).toThrow('STARTUP_SIGNERS_JSON_INVALID');
    expect(() => decodeStartupSigners('[]')).toThrow('STARTUP_SIGNERS_ARRAY_INVALID');
    expect(() => decodeStartupSigners(safeStringify([
      { seed: 'seed', label: 'owner', extra: true },
    ]))).toThrow('STARTUP_SIGNER_FIELDS_INVALID:0');
    expect(() => decodeStartupSigners(safeStringify([
      { seed: 'seed-1', label: 'owner' },
      { seed: 'seed-2', label: ' owner ' },
    ]))).toThrow('STARTUP_SIGNER_LABEL_DUPLICATE:owner');
  });
});
