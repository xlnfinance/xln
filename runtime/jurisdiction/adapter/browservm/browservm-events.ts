import { ethers } from 'ethers';
import { bytesToHex } from '@ethereumjs/util';
import type { Address } from '@ethereumjs/util';
import { extractCanonicalDepositoryEventArgs } from '../events/depository-event-codec';
import type { JEvent } from '../types';

export type EthereumLog = [
  Address | Uint8Array | string | { toBytes?: () => Uint8Array; toString(): string },
  Uint8Array[],
  Uint8Array,
];

export type BrowserVmReceiptLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
};

export type BrowserVmEventCarrier = {
  address: string;
  interfaces: readonly ethers.Interface[];
};

const formatLogAddress = (address: EthereumLog[0]): string => {
  if (typeof address === 'string') return address;
  if (address instanceof Uint8Array) return bytesToHex(address);
  if (typeof address === 'object' && address && typeof address.toBytes === 'function') {
    return bytesToHex(address.toBytes());
  }
  return address.toString();
};

export const toBrowserVmReceiptLogs = (
  logs: EthereumLog[],
  txHash: string,
  blockNumber: number,
): BrowserVmReceiptLog[] =>
  logs.map((log, index) => ({
    address: formatLogAddress(log[0]),
    topics: log[1].map((topic: Uint8Array) => bytesToHex(topic)),
    data: bytesToHex(log[2]),
    blockNumber,
    transactionHash: txHash,
    logIndex: index,
  }));

export const decodeBrowserVmEvents = (
  logs: EthereumLog[],
  carriers: readonly BrowserVmEventCarrier[],
  blockNumber: number,
  blockHash: string,
  transactionHash: string,
): JEvent[] => {
  const decoded: JEvent[] = [];
  for (const [logIndex, log] of logs.entries()) {
    const address = formatLogAddress(log[0]).toLowerCase();
    const carrier = carriers.find(candidate => candidate.address.toLowerCase() === address);
    if (!carrier) continue;

    const topics = log[1].map((topic: Uint8Array) => bytesToHex(topic));
    const data = bytesToHex(log[2]);

    let parsedKnownLog = false;
    for (const iface of carrier.interfaces) {
      try {
        const parsed = iface.parseLog({ topics, data });
        if (!parsed) continue;
        const args = parsed.name === 'DisputeFinalized'
          ? extractCanonicalDepositoryEventArgs(parsed)
          : Object.fromEntries(parsed.fragment.inputs.map((input, index) => [input.name, parsed.args[index]]));
        decoded.push({
          name: parsed.name,
          args,
          blockNumber,
          blockHash,
          transactionHash,
          logIndex,
        });
        parsedKnownLog = true;
        break;
      } catch {
        // One carrier can expose both Depository and linked Account events.
      }
    }
    if (!parsedKnownLog) {
      throw new Error(
        `BROWSERVM_KNOWN_CONTRACT_LOG_INVALID:${address}:topic=${topics[0] ?? 'missing'}`,
      );
    }
  }
  return decoded;
};
