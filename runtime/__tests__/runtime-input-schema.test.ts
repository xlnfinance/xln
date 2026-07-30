import { expect, test } from 'bun:test';

import { decodeRuntimeInput } from '../runtime/input-schema';

test('RuntimeInput decoder owns the exact envelope and RuntimeTx boundary', () => {
  expect(() => decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [],
    ignored: true,
  }, 'RUNTIME_INPUT')).toThrow('RUNTIME_INPUT_FIELDS_INVALID');

  expect(() => decodeRuntimeInput({
    runtimeTxs: [{ type: 'unknown', data: {} }],
    entityInputs: [],
  }, 'RUNTIME_INPUT')).toThrow('RUNTIME_INPUT_RUNTIME_TX_0_DATA_TYPE_UNKNOWN');

  expect(() => decodeRuntimeInput({
    runtimeTxs: [],
    entityInputs: [],
    jInputs: [{ jurisdictionName: 'testnet', jTxs: [], ignored: true }],
  }, 'RUNTIME_INPUT')).toThrow('RUNTIME_INPUT_J_INPUT_FIELDS_INVALID:index=0');
});
