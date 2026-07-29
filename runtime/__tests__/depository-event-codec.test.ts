import { describe, expect, test } from 'bun:test';
import { Depository__factory } from '../../jurisdictions/typechain-types/index.ts';
import {
  extractCanonicalDepositoryEventArgs,
  parseKnownDepositoryLog,
} from '../jadapter/depository-event-codec';
import { parseReceiptLogsToJEvents } from '../jadapter/j-event-log-decoder';

const iface = Depository__factory.createInterface();
const word = (suffix: string): string => `0x${suffix.padStart(64, '0')}`;

const encode = (name: string, values: readonly unknown[]) => {
  const fragment = iface.getEvent(name);
  if (!fragment) throw new Error(`missing event ${name}`);
  return iface.encodeEventLog(fragment, values);
};

describe('Depository watcher event codec', () => {
  test.each([
    {
      name: 'TransformerClauseSkipped',
      values: [word('1'), 2n, '0x0000000000000000000000000000000000000003', 3],
    },
    {
      name: 'TransformerDeltaClamped',
      values: [word('1'), 2n, '0x0000000000000000000000000000000000000003', 4n, -5n, -4n],
    },
    {
      name: 'CooperativeClose',
      values: [word('1'), word('2'), 3n],
    },
    {
      name: 'WatchtowerCounterDisputeExecuted',
      values: ['0x0000000000000000000000000000000000000003', word('1'), word('2'), 4n, 5n],
    },
  ])('recognizes known non-canonical $name telemetry before filtering', ({ name, values }) => {
    const encoded = encode(name, values);
    expect(parseKnownDepositoryLog(encoded)?.name).toBe(name);
  });

  test('maps the Solidity DisputeFinalized nonce to the canonical initialNonce field', () => {
    const encoded = encode('DisputeFinalized', [word('1'), word('2'), 7n, word('3'), word('4')]);
    const parsed = parseKnownDepositoryLog(encoded);
    if (!parsed) throw new Error('DisputeFinalized did not parse');
    const args = extractCanonicalDepositoryEventArgs(parsed);
    expect(args['nonce']).toBe(7n);
    expect(args['initialNonce']).toBe(7n);
  });

  test('uses the same canonical DisputeFinalized payload for receipt ingestion', () => {
    const encoded = encode(
      'DisputeFinalized',
      [word('1'), word('2'), 7n, word('3'), word('4')],
    );
    const events = parseReceiptLogsToJEvents(
      {
        logs: [{
          address: '0x0000000000000000000000000000000000000001',
          topics: encoded.topics,
          data: encoded.data,
          index: 0,
        }],
        blockNumber: 1,
        blockHash: word('5'),
        hash: word('6'),
      },
      [{
        address: '0x0000000000000000000000000000000000000001',
        interface: iface,
      }],
    );
    expect(events[0]?.args['initialNonce']).toBe(7n);
  });
});
