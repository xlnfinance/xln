import { expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { createJAdapter } from '../../../jurisdiction/adapter';
import { generateLazyEntityId } from '../../../entity/factory';
import type { JEvent } from '../../../jurisdiction/adapter/types';
import { counterShortfallDispute, startShortfallDispute } from '../../fixtures/jurisdiction/real-dispute-shortfall';
import {
  decodeBrowserVmEvents,
  type EthereumLog,
} from '../../../jurisdiction/adapter/browservm/browservm-events';

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

test('two dispute transactions share a block with global event indexes and local receipt indexes', async () => {
  const adapter = await createJAdapter({ mode: 'browservm', chainId: 31337 });
  try {
    await adapter.deployStack();
    const vm = adapter.getBrowserVM();
    if (!vm) throw new Error('BROWSERVM_PROVIDER_MISSING');
    const parties = ['11', '22'].map(byte => {
      const wallet = new ethers.Wallet(`0x${byte.repeat(32)}`);
      return { wallet, entityId: generateLazyEntityId([wallet.address], 1n).toLowerCase() };
    }).sort((a, b) => a.entityId.localeCompare(b.entityId));
    const [debtor, creditor] = parties;
    if (!debtor || !creditor) throw new Error('TEST_PARTIES_MISSING');
    const emitted: JEvent[] = [];
    const unsubscribe = vm.onAny(events => { emitted.push(...events); });
    vm.beginJurisdictionBlock(1_700_000_000_000);
    try {
      await startShortfallDispute(adapter, 31337, debtor, creditor, -1n, 'c1', 1n, 7n);
      await counterShortfallDispute(adapter, 31337, debtor, creditor,
        { offdelta: -1n, seedByte: 'c1' }, { offdelta: -1n, seedByte: 'c1' }, 1n, 7n, 8n);
    } finally { vm.endJurisdictionBlock(); unsubscribe(); }
    const height = vm.getBlockHeight();
    const logs = vm.getLogs({ fromBlock: height, toBlock: height });
    expect(logs.map(log => log.logIndex)).toEqual(logs.map((_, index) => index));
    const authenticated = await vm.getAuthenticatedLogsForRange(height, height, [adapter.addresses.depository]);
    expect(logs.map(log => log.logIndex)).toEqual(authenticated.map(log => log.index));
    for (const event of emitted) {
      const log = logs.find(log => log.transactionHash === event.transactionHash &&
        adapter.depository.interface.parseLog(log)?.name === event.name);
      expect(event.logIndex).toBe(log?.logIndex);
    }
    const disputeEvents = emitted.filter(event => ['DisputeStarted', 'CounterDisputeRegistered'].includes(event.name));
    expect(disputeEvents).toHaveLength(2);
    expect(disputeEvents[1]!.logIndex).toBeGreaterThan(disputeEvents[0]!.logIndex!);
    const counterTopic = adapter.depository.interface.getEvent('CounterDisputeRegistered')!.topicHash;
    const counterLog = logs.find(log => log.topics[0] === counterTopic)!;
    expect(adapter.depository.interface.parseLog(counterLog)!.args.proofbody).toBe('0x');
    expect(vm.getLogs({ topics: [counterTopic], fromBlock: height })[0]!.logIndex).toBe(counterLog.logIndex);
    for (const hash of new Set(logs.map(log => log.transactionHash))) {
      const receipt = vm.getTransactionReceipt(hash)!;
      expect(receipt.logs.map(log => log.logIndex)).toEqual(receipt.logs.map((_, index) => index));
    }
  } finally { await adapter.close(); }
}, 30_000);
