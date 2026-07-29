import { ethers } from 'ethers';
import type { Signer } from 'ethers';
import {
  Account__factory,
  DeltaTransformer__factory,
  ERC20Mock__factory,
  HankoVerifier__factory,
} from '../../jurisdictions/typechain-types/index.ts';
import { nodeProcess, runtimeIsBrowser } from '../infra/runtime-process';
import { safeStringify } from '../protocol/serialization';
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

export const asFactoryRunner = (runner: unknown): Parameters<typeof Account__factory.connect>[1] =>
  runner as Parameters<typeof Account__factory.connect>[1];

const asFactorySigner = (runner: unknown): Signer => runner as Signer;

export const makeAccountFactory = (runner: unknown): Account__factory => new Account__factory(asFactorySigner(runner));

export const makeHankoVerifierFactory = (runner: unknown): HankoVerifier__factory =>
  new HankoVerifier__factory(asFactorySigner(runner));

export const makeDeltaTransformerFactory = (runner: unknown): DeltaTransformer__factory =>
  new DeltaTransformer__factory(asFactorySigner(runner));

export const makeErc20MockFactory = (runner: unknown): ERC20Mock__factory =>
  new ERC20Mock__factory(asFactorySigner(runner));

export const eventCarriers = (
  ...contracts: Array<{ interface: unknown; target: unknown }>
): Parameters<typeof parseReceiptLogsToJEvents>[1] =>
  contracts.map(contract => ({
    address: String(contract.target),
    interface: contract.interface as ethers.Interface,
  }));

export const asRpcTxResponse = (tx: unknown): RpcTxResponse => tx as RpcTxResponse;

export const asRpcReceipt = (receipt: unknown): RpcReceipt => receipt as RpcReceipt;

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
