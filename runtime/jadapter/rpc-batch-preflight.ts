import type { Depository } from '../../jurisdictions/typechain-types/index.ts';
import { safeStringify } from '../protocol/serialization';
import { classifyJAdapterFailure, makeJAdapterFailureResult } from './failure';
import { decodeStandardSolidityRevertData, rpcErrorText, rpcLog } from './rpc-public';
import type { JSubmitResult } from './types';

type RevertSource = {
  data?: unknown;
  error?: { data?: unknown };
  info?: { error?: { data?: unknown } };
  reason?: unknown;
  message?: unknown;
};

type ProcessBatchPreflight = {
  depository: Depository;
  encodedBatch: string;
  hankoData: string;
  entityNonce: bigint;
  gasLimit: bigint;
  disputeStartDebug: Array<Record<string, unknown>>;
};

const revertDetail = (depository: Depository, revertData: unknown): string => {
  if (typeof revertData !== 'string') return '';
  const selector = revertData.slice(0, 10);
  if (selector === '0x08c379a0' || selector === '0x4e487b71') {
    return `unknown(${selector})${decodeStandardSolidityRevertData(revertData)}`;
  }
  const payloadBytes = Math.max(0, Math.floor((revertData.length - 2) / 2));
  try {
    const parsed = depository.interface.parseError(revertData);
    if (!parsed) return `unknown(${selector})`;
    const args = Array.from(parsed.args ?? []);
    const suffix = args.length > 0 ? ` args=${JSON.stringify(args.map(value => String(value)))}` : '';
    return `${parsed.name}()${suffix}`;
  } catch (error) {
    rpcLog.warn('revert.contract_error_decode_failed', {
      selector,
      payloadBytes,
      error: rpcErrorText(error),
    });
    return `unknown(${selector})`;
  }
};

export const preflightProcessBatch = async (input: ProcessBatchPreflight): Promise<JSubmitResult | null> => {
  try {
    await input.depository.processBatch.staticCall(input.encodedBatch, input.hankoData, input.entityNonce, {
      gasLimit: input.gasLimit,
    });
    return null;
  } catch (error) {
    const failure = classifyJAdapterFailure(error);
    const source = typeof error === 'object' && error !== null ? (error as RevertSource) : null;
    const revertData = source?.data ?? source?.error?.data ?? source?.info?.error?.data;
    const usableRevertData = revertData === '0x' ? undefined : revertData;
    if (!usableRevertData && failure.category === 'transient') {
      return makeJAdapterFailureResult(error);
    }
    let detail = usableRevertData
      ? revertDetail(input.depository, usableRevertData)
      : String(source?.reason ?? source?.message ?? error);
    if (input.disputeStartDebug.length > 0) {
      detail += ` disputeStart=${safeStringify(input.disputeStartDebug)}`;
    }
    return makeJAdapterFailureResult(error, {
      category: 'terminal',
      code: failure.code === 'J_ADAPTER_TERMINAL' ? 'CALL_EXCEPTION' : failure.code,
      message: `staticCall revert: ${detail}`,
    });
  }
};
