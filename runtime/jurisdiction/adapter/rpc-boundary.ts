import { ethers } from 'ethers';
import { nodeProcess, runtimeIsBrowser } from '../../infra/runtime-process';
import { safeStringify } from '../../protocol/serialization';
import { parseReceiptLogsToJEvents } from './j-event-log-decoder';

export type RpcReceipt = Parameters<typeof parseReceiptLogsToJEvents>[0] & {
  gasUsed?: bigint;
};
export type RpcTxResponse = {
  hash: string;
  wait(confirms?: number, timeout?: number): Promise<unknown | null>;
};
export type FeeOverrides = {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};
export type TxOverrides = FeeOverrides & { gasLimit?: bigint; nonce?: number };
export type UntypedNonPayableMethod = {
  estimateGas: (...args: unknown[]) => Promise<bigint>;
  (...args: unknown[]): Promise<unknown>;
};

export const watcherErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const watcherErrorDetails = (error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error)) return { raw: String(error) };
  const details = error as Error & {
    code?: unknown;
    shortMessage?: unknown;
    info?: unknown;
    cause?: unknown;
  };
  return {
    name: details.name,
    message: details.message,
    code: details.code,
    shortMessage: details.shortMessage,
    info: details.info,
    cause:
      details.cause instanceof Error ? { name: details.cause.name, message: details.cause.message } : details.cause,
  };
};

export const haltProcessForFatalWatcherError = (fatalPayload: Record<string, unknown>): void => {
  const error = new Error(`JADAPTER_WATCHER_FATAL:${safeStringify(fatalPayload)}`);
  if (runtimeIsBrowser) {
    setTimeout(() => {
      throw error;
    }, 0);
    return;
  }
  if (nodeProcess?.exit) {
    nodeProcess.exit(1);
    return;
  }
  throw error;
};

export const eventCarriers = (
  ...contracts: Array<{ interface: unknown; target: unknown }>
): Parameters<typeof parseReceiptLogsToJEvents>[1] =>
  contracts.map(contract => ({
    address: String(contract.target),
    interface: contract.interface as ethers.Interface,
  }));

export const asRpcTxResponse = (tx: unknown): RpcTxResponse => tx as RpcTxResponse;

const decodeRpcLog = (
  value: unknown,
  receiptHash: string,
  receiptIndex: number,
): RpcReceipt['logs'][number] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`J_ADAPTER_RECEIPT_LOG_INVALID:${receiptHash}:${receiptIndex}`);
  }
  const log = value as Record<string, unknown>;
  const address = log['address'];
  const topics = log['topics'];
  const data = log['data'];
  if (
    !ethers.isAddress(address) ||
    !Array.isArray(topics) ||
    topics.some(topic => !ethers.isHexString(topic, 32)) ||
    !ethers.isHexString(data)
  ) {
    throw new Error(`J_ADAPTER_RECEIPT_LOG_INVALID:${receiptHash}:${receiptIndex}`);
  }
  const index = log['index'];
  const logIndex = log['logIndex'];
  if (
    index !== undefined &&
    (!Number.isSafeInteger(index) || Number(index) < 0)
  ) {
    throw new Error(`J_ADAPTER_RECEIPT_LOG_INDEX_INVALID:${receiptHash}:${receiptIndex}`);
  }
  if (
    logIndex !== undefined &&
    (!Number.isSafeInteger(logIndex) || Number(logIndex) < 0)
  ) {
    throw new Error(`J_ADAPTER_RECEIPT_LOG_INDEX_INVALID:${receiptHash}:${receiptIndex}`);
  }
  return {
    address,
    topics,
    data,
    ...(index === undefined ? {} : { index: Number(index) }),
    ...(logIndex === undefined ? {} : { logIndex: Number(logIndex) }),
  };
};

/**
 * Project an untrusted provider receipt into the only shape JAdapter accepts.
 *
 * A successful empty-log receipt still needs canonical chain coordinates;
 * otherwise an RPC fault could be mistaken for a mined transaction with no
 * events.
 */
export const decodeRpcReceipt = (value: unknown): RpcReceipt => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('J_ADAPTER_RECEIPT_INVALID');
  }
  const receipt = value as Record<string, unknown>;
  const blockNumber = receipt['blockNumber'];
  const blockHash = receipt['blockHash'];
  const hash = receipt['hash'];
  const logs = receipt['logs'];
  if (
    !Number.isSafeInteger(blockNumber) ||
    Number(blockNumber) < 1 ||
    !ethers.isHexString(blockHash, 32) ||
    !ethers.isHexString(hash, 32) ||
    !Array.isArray(logs)
  ) {
    throw new Error('J_ADAPTER_RECEIPT_COORDINATES_INVALID');
  }
  const gasUsed = receipt['gasUsed'];
  if (gasUsed !== undefined && typeof gasUsed !== 'bigint') {
    throw new Error('J_ADAPTER_RECEIPT_GAS_USED_INVALID');
  }
  return {
    blockNumber: Number(blockNumber),
    blockHash,
    hash,
    logs: logs.map((log, index) => decodeRpcLog(log, hash, index)),
    ...(gasUsed === undefined ? {} : { gasUsed }),
  };
};

export const applyGasHeadroom = (value: bigint, headroomBps: number): bigint =>
  (value * BigInt(headroomBps) + 9_999n) / 10_000n;

type ErrorWithMessage = { message?: unknown };

export const isNonceSyncError = (error: unknown): boolean => {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as ErrorWithMessage).message ?? '')
      : String(error ?? '');
  const normalized = message.toLowerCase();
  return (
    normalized.includes('nonce too low') ||
    normalized.includes('nonce has already been used') ||
    normalized.includes('nonce expired') ||
    normalized.includes('code=nonce_expired')
  );
};
