import { expect, test } from 'bun:test';
import { Depository__factory } from '../../../../jurisdictions/typechain-types';
import { createEmptyEnv } from '../../../runtime';
import { successfulJReceiptResult } from '../../../runtime/j-submit/j-submit';
import { indexReserveUpdatedEvents, findReserveUpdatedEvidence } from '../../../jurisdiction/machine/events/event-evidence';

const word = (suffix: string): string => `0x${suffix.padStart(64, '0')}`;

test('prepared receipt preserves external recipient evidence without creating local Entity state', () => {
  const env = createEmptyEnv('prepared-external-recipient-evidence');
  const recipient = word('12');
  const address = `0x${'13'.padStart(40, '0')}`;
  const iface = Depository__factory.createInterface();
  const log = iface.encodeEventLog('ReserveUpdated', [recipient, 1, 10000001n]);
  const result = successfulJReceiptResult({
    hash: word('14'), blockHash: word('15'), blockNumber: 42,
    logs: [{ address, ...log, index: 3 }],
  }, [{ address, interface: iface }]);
  indexReserveUpdatedEvents(env, result.events);
  expect(findReserveUpdatedEvidence(env, recipient, 1, 10000001n)).toMatchObject({
    transactionHash: word('14'), blockHash: word('15'), blockNumber: 42,
    args: { entity: recipient, tokenId: '1', newBalance: '10000001' },
  });
  expect(findReserveUpdatedEvidence(env, recipient, 1, 10000002n)).toBeNull();
  expect(env.state.eReplicas.size).toBe(0);
});
