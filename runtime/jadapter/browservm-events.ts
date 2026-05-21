import { ethers } from 'ethers';
import { bytesToHex } from '@ethereumjs/util';
import type { Address } from '@ethereumjs/util';

export type EthereumLog = [
  Address | Uint8Array | string | { toBytes?: () => Uint8Array; toString(): string },
  Uint8Array[],
  Uint8Array,
];

export type EVMEvent = {
  name: string;
  args: Record<string, unknown>;
  blockNumber?: number;
  blockHash?: string;
  timestamp?: number;
};

export type BrowserVmReceiptLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
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
  interfaces: Array<ethers.Interface | null>,
  blockNumber: number,
  blockHash: string,
  timestamp: number,
): EVMEvent[] => {
  const parsers = interfaces.filter((iface): iface is ethers.Interface => iface !== null);
  if (parsers.length === 0) return [];

  const decoded: EVMEvent[] = [];
  for (const log of logs) {
    const topics = log[1].map((topic: Uint8Array) => bytesToHex(topic));
    const data = bytesToHex(log[2]);

    for (const iface of parsers) {
      try {
        const parsed = iface.parseLog({ topics, data });
        if (!parsed) continue;
        decoded.push({
          name: parsed.name,
          args: Object.fromEntries(parsed.fragment.inputs.map((input, index) => [input.name, parsed.args[index]])),
          blockNumber,
          blockHash,
          timestamp,
        });
        break;
      } catch {
        // Try the next interface; BrowserVM combines events from multiple contracts.
      }
    }
  }
  return decoded;
};
