import { describe, expect, test } from 'bun:test';

import {
  MAX_RUNTIME_J_INPUT_BYTES,
  MAX_RUNTIME_J_TXS,
  MAX_RUNTIME_J_TXS_PER_JURISDICTION,
  createEmptyEnv,
  validateRuntimeInputAdmission,
} from '../runtime';
import type { JTx, RuntimeInput } from '../types';

const jurisdiction = 'Testnet';
const tx = (): JTx => ({
  type: 'debtEnforcement',
  entityId: `0x${'11'.repeat(32)}`,
  data: { tokenId: 1, maxIterations: 1n },
  timestamp: 1,
});

const env = () => {
  const value = createEmptyEnv('j-ingress-admission');
  value.runtimeState = { lifecyclePhase: 'running', loopActive: true };
  value.jReplicas.set(jurisdiction, {} as never);
  value.jReplicas.set('Testnet2', {} as never);
  value.jReplicas.set('Testnet3', {} as never);
  return value;
};

const input = (jInputs: RuntimeInput['jInputs']): RuntimeInput => ({
  runtimeTxs: [],
  entityInputs: [],
  jInputs,
});

describe('runtime J ingress admission', () => {
  test('bounds total and per-jurisdiction J transactions before apply', () => {
    expect(() => validateRuntimeInputAdmission(env(), input([
      { jurisdictionName: jurisdiction, jTxs: Array.from({ length: MAX_RUNTIME_J_TXS_PER_JURISDICTION }, tx) },
      { jurisdictionName: 'Testnet2', jTxs: Array.from({ length: MAX_RUNTIME_J_TXS_PER_JURISDICTION }, tx) },
      { jurisdictionName: 'Testnet3', jTxs: [tx()] },
    ]))).toThrow('Too many J transactions');

    expect(() => validateRuntimeInputAdmission(env(), input([{
      jurisdictionName: jurisdiction,
      jTxs: Array.from({ length: MAX_RUNTIME_J_TXS_PER_JURISDICTION + 1 }, tx),
    }]))).toThrow(`Too many J transactions for ${jurisdiction}`);
  });

  test('bounds encoded J bytes and rejects unknown jurisdiction', () => {
    const oversized = tx() as JTx & { padding: string };
    oversized.padding = 'x'.repeat(MAX_RUNTIME_J_INPUT_BYTES + 1);
    expect(() => validateRuntimeInputAdmission(env(), input([{
      jurisdictionName: jurisdiction,
      jTxs: [oversized],
    }]))).toThrow('J payload too large');

    expect(() => validateRuntimeInputAdmission(env(), input([{
      jurisdictionName: 'missing',
      jTxs: [tx()],
    }]))).toThrow('Unknown J jurisdiction');
  });
});
