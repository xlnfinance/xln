import { expect, test } from 'bun:test';
import { decodeAccountTx } from '../../account/tx-validation';
import { requireKnownEntityTxType } from '../../entity/tx/processing/catalog';
import { FailureDispositionError } from '../../protocol/errors/failure-taxonomy';
import { PersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { projectPortableAccountDoc } from '../../storage/read/projections';
import { decodeValidatedBuffer, encodeBuffer } from '../../storage/codec/codec';
import { validateStorageAccountDocValue } from '../../storage/schema/authoritative-schema';
import { entity, makeAccount } from '../helpers/cross-j';

// Obsolete peer payloads reject before interpretation; they cannot authorize financial mutation.
test('retired arbitrary-contract kinds have a typed reject disposition', () => {
  for (const decode of [
    () => decodeAccountTx({ type: 'subcontract_transition', data: {} }, 'RETIRED'),
    () => requireKnownEntityTxType({ type: 'customContract', data: {} }, 'RETIRED'),
  ]) {
    expect(decode).toThrow(FailureDispositionError);
    try { decode(); } catch (error) {
      if (!(error instanceof FailureDispositionError)) throw error;
      expect(error.disposition).toBe('reject');
      expect(error.code).toMatch(/^(ACCOUNT|ENTITY)_TX_KIND_OUT_OF_PROFILE$/);
    }
  }
});
const currentEvidence = {
  transformerAddress: '0x' + '33'.repeat(20), encodedBatch: '0x',
  allowances: [{ deltaIndex: 0, leftAllowance: 0n, rightAllowance: 100n }],
};
const stored = (evidence: typeof currentEvidence) => {
  const account = makeAccount(entity('11'), entity('22'));
  account.state.subcontracts = PersistentAccountStateMap.fromEntries('subcontracts', [[entity('aa'), evidence]]);
  return encodeBuffer(projectPortableAccountDoc(account));
};
test('current Studio subcontract evidence survives the canonical storage codec', () => {
  const restored = decodeValidatedBuffer(stored(currentEvidence), validateStorageAccountDocValue);
  expect(restored.state.subcontracts?.get(entity('aa'))).toEqual(currentEvidence);
});
test('obsolete laptop program fields fail loudly at the canonical storage boundary', () => {
  const obsolete = { ...currentEvidence, initcode: '0x00', source: 'retired experiment' };
  expect(() => decodeValidatedBuffer(stored(obsolete), validateStorageAccountDocValue))
    .toThrow('SUBCONTRACT');
});
