import { expect, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  decodeBrowserVmEvents,
  type EthereumLog,
} from '../jadapter/browservm-events';

const knownAddress = '0x1111111111111111111111111111111111111111';
const unknownAddress = '0x2222222222222222222222222222222222222222';
const iface = new ethers.Interface(['event ValueObserved(uint256 value)']);

const log = (
  address: string,
  topics: readonly string[],
  data: string,
): EthereumLog => [
  address,
  topics.map(topic => ethers.getBytes(topic)),
  ethers.getBytes(data),
];

test('BrowserVM decodes a valid log from a known protocol carrier', () => {
  const encoded = iface.encodeEventLog(iface.getEvent('ValueObserved')!, [7n]);
  const events = decodeBrowserVmEvents(
    [log(knownAddress, encoded.topics, encoded.data)],
    [{ address: knownAddress, interfaces: [iface] }],
    1,
    `0x${'33'.repeat(32)}`,
    `0x${'44'.repeat(32)}`,
  );

  expect(events).toHaveLength(1);
  expect(events[0]?.name).toBe('ValueObserved');
  expect(events[0]?.args['value']).toBe(7n);
});

test('BrowserVM ignores telemetry from an unknown carrier', () => {
  const events = decodeBrowserVmEvents(
    [log(unknownAddress, [`0x${'55'.repeat(32)}`], '0x')],
    [{ address: knownAddress, interfaces: [iface] }],
    1,
    `0x${'33'.repeat(32)}`,
    `0x${'44'.repeat(32)}`,
  );

  expect(events).toEqual([]);
});

test('BrowserVM fails closed on an undecodable log from a known carrier', () => {
  expect(() => decodeBrowserVmEvents(
    [log(knownAddress, [`0x${'55'.repeat(32)}`], '0x')],
    [{ address: knownAddress, interfaces: [iface] }],
    1,
    `0x${'33'.repeat(32)}`,
    `0x${'44'.repeat(32)}`,
  )).toThrow('BROWSERVM_KNOWN_CONTRACT_LOG_INVALID');
});
