import { ethers } from 'ethers';
import { extractCanonicalDepositoryEventArgs } from './events/depository-event-codec';
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

/**
 * Money topics of earlier Depository deployments. A configured carrier that
 * emits one runs an old deployment whose state the current ABI cannot carry
 * (pre-debtSeq DebtCreated has no queue generation), so stop instead of
 * skipping it. Same set as rscore j_watcher/abi.rs
 * require_current_depository_money_abi.
 */
const RETIRED_DEPOSITORY_MONEY_TOPICS = new Set([
  '0x784575545124eef27f8fcc1472fb5f2483beb9cc23e6fe3dbf588eb7bd501f7c',
  '0xae767eeb0c57abd46e2e0b422895ba3b89372fbd0510a58f00d996faf66f027d',
  '0x1ffe8e6348fe244a8988797c02b57999821149e7b25c9f93a85c77819efdde67',
  '0x0971ac81b80f99fe0089c3fbe4af4fa1148f2ce78bc6345e76b05be73500de1f',
  '0xf77919d8ab0bbcbc7feb0269986072624ad50811e07c7a87aa97e234ad7717db',
]);

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
    logs: ReadonlyArray<{
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
    // Non-carrier emitters (tokens, wrappers) are skipped before the retired
    // fence, so an unrelated contract cannot force this halt.
    if (!carrier) continue;
    const topic = String(log.topics[0] ?? '').toLowerCase();
    if (!hasEventTopic(carrier.interface, topic)) {
      if (RETIRED_DEPOSITORY_MONEY_TOPICS.has(topic)) {
        throw new Error(
          `J_RECEIPT_RETIRED_MONEY_ABI:${receipt.hash}:${receiptIndex}` +
            `:${ethers.getAddress(log.address).toLowerCase()}:${topic}`,
        );
      }
      continue;
    }
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
