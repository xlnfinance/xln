import { encodeInt768 } from "../../../protocol/crypto/abi-money";
import { describe, expect, test } from 'bun:test';
import { Depository__factory } from '../../../../jurisdictions/typechain-types/index.ts';
import {
  extractCanonicalDepositoryEventArgs,
  parseKnownDepositoryLog,
} from '../../../jurisdiction/adapter/events/depository-event-codec';
import { ethers } from 'ethers';
import { decodeJEventLog, parseReceiptLogsToJEvents } from '../../../jurisdiction/adapter/j-event-log-decoder';

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
      name: 'TransformerDeltaClamped',
      values: [word('1'), 2n, '0x0000000000000000000000000000000000000003', 4n, encodeInt768(-5n), encodeInt768(-4n)],
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

  test('halts on a pre-debtSeq DebtCreated from a configured carrier, not from an unrelated emitter', () => {
    // Exact event of the deployment before debtSeq (HEAD 4e1c9a606 Depository ABI).
    const oldIface = new ethers.Interface([
      'event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, (uint256 high, uint256 low) amount, uint256 debtIndex)',
    ]);
    const oldFragment = oldIface.getEvent('DebtCreated');
    if (!oldFragment) throw new Error('missing old DebtCreated');
    expect(oldFragment.topicHash).toBe('0xf77919d8ab0bbcbc7feb0269986072624ad50811e07c7a87aa97e234ad7717db');
    const encoded = oldIface.encodeEventLog(oldFragment, [word('a'), word('b'), 1n, [0n, 7n], 0n]);
    const depository = '0x0000000000000000000000000000000000000001';
    const unrelated = '0x0000000000000000000000000000000000000002';
    const receipt = (address: string) => ({
      logs: [{ address, topics: encoded.topics, data: encoded.data, index: 0 }],
      blockNumber: 1,
      blockHash: word('5'),
      hash: word('6'),
    });
    const carriers = [{ address: depository, interface: iface }];
    expect(() => parseReceiptLogsToJEvents(receipt(depository), carriers)).toThrow(
      `J_RECEIPT_RETIRED_MONEY_ABI:${word('6')}:0:${depository}:${oldFragment.topicHash}`,
    );
    expect(parseReceiptLogsToJEvents(receipt(unrelated), carriers)).toEqual([]);
    // The authenticated watcher decodes every carrier log and already fails closed.
    expect(() => decodeJEventLog(encoded, iface, {
      blockNumber: 1,
      blockHash: word('5'),
      transactionHash: word('6'),
      logIndex: 0,
    }, 'J_WATCHER_CANONICAL_EVENT_DECODE_FAILED')).toThrow('J_WATCHER_CANONICAL_EVENT_DECODE_FAILED:empty');
  });
});
