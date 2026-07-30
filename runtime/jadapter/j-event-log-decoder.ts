import { ethers } from 'ethers';
import { extractCanonicalDepositoryEventArgs } from './depository-event-codec';
import type { JEvent } from './types';

export type JEventLog = {
  topics: readonly string[];
  data: string;
};

export type JEventCoordinates = {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
};

export type JEventCarrier = {
  address: string;
  interface: ethers.Interface;
};

/**
 * Decode one log only after its carrier and canonical coordinates are known.
 * Transport-specific scanners own address selection; this function owns the
 * single ABI → witnessed-event conversion used by receipts and history.
 */
export const decodeJEventLog = (
  log: JEventLog,
  carrierInterface: ethers.Interface,
  coordinates: JEventCoordinates,
  failureCode: string,
): JEvent => {
  let parsed: ethers.LogDescription | null;
  try {
    parsed = carrierInterface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${failureCode}:${message}`);
  }
  if (!parsed) throw new Error(`${failureCode}:empty`);
  return {
    name: parsed.name,
    args: extractCanonicalDepositoryEventArgs(parsed),
    ...coordinates,
  };
};

const hasEventTopic = (
  carrierInterface: ethers.Interface,
  topic: string,
): boolean =>
  carrierInterface.fragments.some(
    fragment =>
      fragment.type === 'event' &&
      (fragment as ethers.EventFragment).topicHash.toLowerCase() === topic,
  );

export const parseReceiptLogsToJEvents = (
  receipt: {
    logs: Array<{
      address: string;
      topics: readonly string[];
      data: string;
      index?: number;
      logIndex?: number;
    }>;
    blockNumber: number;
    blockHash: string;
    hash: string;
  },
  carriers: JEventCarrier[],
): JEvent[] => {
  if (
    !Number.isSafeInteger(receipt.blockNumber) ||
    receipt.blockNumber < 1 ||
    !ethers.isHexString(receipt.blockHash, 32) ||
    !ethers.isHexString(receipt.hash, 32)
  ) {
    throw new Error('J_ADAPTER_RECEIPT_COORDINATES_INVALID');
  }
  const carrierByAddress = new Map<string, JEventCarrier>();
  for (const carrier of carriers) {
    if (!ethers.isAddress(carrier.address)) {
      throw new Error(
        `J_RECEIPT_CARRIER_ADDRESS_INVALID:${String(carrier.address)}`,
      );
    }
    const address = ethers.getAddress(carrier.address).toLowerCase();
    if (carrierByAddress.has(address)) {
      throw new Error(`J_RECEIPT_CARRIER_ADDRESS_DUPLICATE:${address}`);
    }
    carrierByAddress.set(address, carrier);
  }

  const events: JEvent[] = [];
  for (const [receiptIndex, log] of receipt.logs.entries()) {
    if (!ethers.isAddress(log.address)) {
      throw new Error(
        `J_RECEIPT_LOG_ADDRESS_INVALID:${receipt.hash}:${receiptIndex}` +
          `:${String(log.address)}`,
      );
    }
    if (
      log.index !== undefined &&
      log.logIndex !== undefined &&
      log.index !== log.logIndex
    ) {
      throw new Error(
        `J_RECEIPT_LOG_INDEX_MISMATCH:${receipt.hash}:${receiptIndex}` +
          `:index=${String(log.index)}:logIndex=${String(log.logIndex)}`,
      );
    }
    const logIndex = log.index ?? log.logIndex;
    if (!Number.isSafeInteger(logIndex) || Number(logIndex) < 0) {
      throw new Error(
        `J_RECEIPT_LOG_INDEX_INVALID:${receipt.hash}:${receiptIndex}` +
          `:${String(logIndex)}`,
      );
    }
    const carrier = carrierByAddress.get(
      ethers.getAddress(log.address).toLowerCase(),
    );
    if (!carrier) continue;
    const topic = String(log.topics[0] ?? '').toLowerCase();
    if (!hasEventTopic(carrier.interface, topic)) continue;
    events.push(
      decodeJEventLog(
        log,
        carrier.interface,
        {
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          transactionHash: receipt.hash,
          logIndex: Number(logIndex),
        },
        `J_RECEIPT_LOG_DECODE_FAILED:${receipt.hash}:${receiptIndex}`,
      ),
    );
  }
  return events;
};
