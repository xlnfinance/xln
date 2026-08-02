/**
 * JAdapter - RPC Implementation
 * Unified adapter for all JSON-RPC backends (anvil, mainnet, testnet)
 *
 * Features:
 *   - Deploy contracts (anvil) or connect to existing (mainnet/testnet)
 *   - Snapshot/revert only when the configured dev RPC explicitly supports it
 *
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';

import { Depository__factory } from '../../../jurisdictions/typechain-types/index.ts';

import { BLOCKCHAIN } from '../../config/constants';
import { createStructuredLogger } from '../../infra/logger';
import { decodeJBatch, type JBatch } from '../machine/batch';
import type { DisputeFinalizationEvidence } from '../../types/jurisdiction-events';
import { type AuthenticatedReceiptRange, type ReceiptReadProfile } from './receipt-root';
import { type RpcBatchResponse } from './rpc-utils';
import { applyJBlockHeadersIngressTransform } from './watcher';
import { TRON_CHAIN_IDS } from './chain-ids';
import type { JAdapterMode } from './types';

/**
 * A signed transformer is the dispute program, so finalization forwards every
 * available unit except the contract's 2M settlement reserve. Use one portable
 * 15M ceiling across EVM jurisdictions, below Ethereum's EIP-7825 2^24 cap.
 */
export const PROCESS_BATCH_TRANSFORMER_GAS_LIMIT = 15_000_000n;

export const resolveProcessBatchGasLimit = (
  estimatedGasLimit: bigint,
  batch: JBatch,
  mode: JAdapterMode,
): bigint => {
  const transformerFinalizationCount = mode === 'tron'
    ? 0
    : batch.disputeFinalizations.filter(
      finalization => finalization.finalProofbody.transformers.length > 0,
    ).length;
  if (transformerFinalizationCount > 1) {
    throw new Error('J_TRANSFORMER_FINALIZATION_BATCH_LIMIT');
  }
  if (transformerFinalizationCount === 0) return estimatedGasLimit;
  if (estimatedGasLimit > PROCESS_BATCH_TRANSFORMER_GAS_LIMIT) {
    throw new Error('J_TRANSFORMER_FINALIZATION_GAS_LIMIT');
  }
  return PROCESS_BATCH_TRANSFORMER_GAS_LIMIT;
};

export const rpcLog = createStructuredLogger('jadapter.rpc');

export type TxFinalizationEvidence = Omit<DisputeFinalizationEvidence, 'sender' | 'finalProofbodyHash'>;

export const toFinalizationDecimal = (value: unknown): string => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value.toString();
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value.trim())) return value.trim();
  throw new Error('J_DISPUTE_FINALIZATION_DECIMAL_INVALID');
};

export const toFinalizationHex = (value: unknown): string => {
  if (typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return value.toLowerCase();
  throw new Error('J_DISPUTE_FINALIZATION_HEX_INVALID');
};

export const depositoryTransactionInterface = Depository__factory.createInterface();

/** Decode reducer sidecar data from a transaction that emitted DisputeFinalized. */
export const decodeDisputeFinalizationEvidenceCalldata = (data: string): TxFinalizationEvidence[] => {
  try {
    const parsed = depositoryTransactionInterface.parseTransaction({ data });
    if (!parsed) throw new Error('J_DISPUTE_FINALIZATION_CALLDATA_UNKNOWN');
    if (parsed.name === 'processBatch') {
      const encodedBatch = toFinalizationHex(parsed.args[0]);
      if (encodedBatch === '0x') throw new Error('J_DISPUTE_FINALIZATION_BATCH_CALLDATA_MISSING');
      const batch = decodeJBatch(encodedBatch);
      return (batch.disputeFinalizations ?? []).map(finalization => {
        const starterArguments = toFinalizationHex(finalization.starterArguments);
        const otherArguments = toFinalizationHex(finalization.otherArguments);
        const startedByLeft = Boolean(finalization.startedByLeft);
        return {
          counterentity: toFinalizationHex(finalization.counterentity),
          initialNonce: toFinalizationDecimal(finalization.initialNonce),
          finalNonce: toFinalizationDecimal(finalization.finalNonce),
          initialProofbodyHash: toFinalizationHex(finalization.initialProofbodyHash),
          leftArguments: startedByLeft ? starterArguments : otherArguments,
          rightArguments: startedByLeft ? otherArguments : starterArguments,
          startedByLeft,
          sig: toFinalizationHex(finalization.sig),
        };
      });
    }
    if (parsed.name === 'watchtowerCounterDispute') {
      const proof = parsed.args[1];
      if (typeof proof !== 'object' || proof === null) {
        throw new Error('J_DISPUTE_FINALIZATION_PROOF_INVALID');
      }
      const starterArguments = toFinalizationHex(Reflect.get(proof, 'starterArguments'));
      const otherArguments = toFinalizationHex(Reflect.get(proof, 'otherArguments'));
      const startedByLeft = Boolean(Reflect.get(proof, 'startedByLeft'));
      return [
        {
          counterentity: toFinalizationHex(Reflect.get(proof, 'counterentity')),
          initialNonce: toFinalizationDecimal(Reflect.get(proof, 'initialNonce')),
          finalNonce: toFinalizationDecimal(Reflect.get(proof, 'finalNonce')),
          initialProofbodyHash: toFinalizationHex(Reflect.get(proof, 'initialProofbodyHash')),
          leftArguments: startedByLeft ? starterArguments : otherArguments,
          rightArguments: startedByLeft ? otherArguments : starterArguments,
          startedByLeft,
          sig: toFinalizationHex(Reflect.get(proof, 'sig')),
        },
      ];
    }
    throw new Error(`J_DISPUTE_FINALIZATION_CALLDATA_UNSUPPORTED:${parsed.name}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('J_DISPUTE_FINALIZATION_')) throw error;
    throw new Error(
      `J_DISPUTE_FINALIZATION_CALLDATA_DECODE_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const resolveDisputeFinalizationEvidence = (
  candidates: readonly TxFinalizationEvidence[],
  txHash: string,
  args: Record<string, unknown>,
): DisputeFinalizationEvidence => {
  const normalizedHash = String(txHash || '').toLowerCase();
  if (candidates.length === 0) {
    throw new Error(`J_DISPUTE_FINALIZATION_EVIDENCE_EMPTY:${normalizedHash}`);
  }
  const counterentity = String(args['counterentity'] ?? '').toLowerCase();
  const initialNonce = toFinalizationDecimal(args['initialNonce']);
  const initialProofbodyHash = String(args['initialProofbodyHash'] ?? '').toLowerCase();
  const matched = candidates.find(candidate =>
    candidate.counterentity.toLowerCase() === counterentity &&
    candidate.initialNonce === initialNonce &&
    candidate.initialProofbodyHash.toLowerCase() === initialProofbodyHash);
  if (!matched) {
    throw new Error(`J_DISPUTE_FINALIZATION_EVIDENCE_NOT_FOUND:${normalizedHash}`);
  }
  return {
    sender: toFinalizationHex(args['sender']),
    counterentity: matched.counterentity,
    initialNonce: matched.initialNonce,
    finalNonce: matched.finalNonce,
    initialProofbodyHash: matched.initialProofbodyHash,
    finalProofbodyHash: toFinalizationHex(args['finalProofbodyHash']),
    leftArguments: matched.leftArguments,
    rightArguments: matched.rightArguments,
    startedByLeft: matched.startedByLeft,
    sig: matched.sig,
  };
};

export const isTronChainId = (chainId: number): boolean => TRON_CHAIN_IDS.has(chainId);

export const resolveWatcherPollToBlock = (
  fromBlock: number,
  safeToBlock: number,
  maxBlocksPerPoll = BLOCKCHAIN.J_WATCHER_MAX_BLOCKS_PER_POLL,
): number => {
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 1) {
    throw new Error(`J_WATCHER_FROM_BLOCK_INVALID:${String(fromBlock)}`);
  }
  if (!Number.isSafeInteger(safeToBlock) || safeToBlock < fromBlock) {
    throw new Error(`J_WATCHER_SAFE_TO_BLOCK_INVALID:${String(safeToBlock)}`);
  }
  if (!Number.isSafeInteger(maxBlocksPerPoll) || maxBlocksPerPoll < 1) {
    throw new Error(`J_WATCHER_BLOCK_RANGE_INVALID:${String(maxBlocksPerPoll)}`);
  }
  return Math.min(safeToBlock, fromBlock + maxBlocksPerPoll - 1);
};

/**
 * Verify the receipt/header binding before the determinism harness replaces
 * external chain identities with its recorded ingress. Applying the replay
 * transform first would mix a fresh receipt with a different run's header and,
 * worse, could let a transform disguise an actually inconsistent RPC result.
 */
export const assertAuthenticatedWatcherLogHeaders = (
  authenticatedRange: Pick<AuthenticatedReceiptRange, 'headers' | 'logs'>,
): Array<{ jHeight: number; jBlockHash: string }> => {
  const authenticatedHeaders = authenticatedRange.headers.map(({ jHeight, jBlockHash }) => ({
    jHeight,
    jBlockHash,
  }));
  const authenticatedHeaderHashes = new Map(authenticatedHeaders.map(header => [header.jHeight, header.jBlockHash]));
  for (const log of authenticatedRange.logs) {
    const headerHash = authenticatedHeaderHashes.get(log.blockNumber);
    if (headerHash !== log.blockHash.toLowerCase()) {
      throw new Error(
        `J_RECEIPT_LOG_HEADER_MISMATCH:${log.blockNumber}:` +
          `receipt=${log.blockHash}:header=${headerHash ?? 'missing'}`,
      );
    }
  }
  return authenticatedHeaders;
};

export const prepareAuthenticatedWatcherIngress = (
  authenticatedRange: AuthenticatedReceiptRange,
  expectedParent?: NonNullable<ReceiptReadProfile['expectedParent']>,
): {
  headers: Array<{ jHeight: number; jBlockHash: string }>;
  logs: AuthenticatedReceiptRange['logs'];
  tipBlockHash: string;
} => {
  const authenticatedHeaders = assertAuthenticatedWatcherLogHeaders(authenticatedRange);
  const ingressHeaders =
    authenticatedRange.anchor.jHeight === authenticatedHeaders[0]?.jHeight
      ? authenticatedHeaders
      : [
          {
            jHeight: authenticatedRange.anchor.jHeight,
            jBlockHash: authenticatedRange.anchor.jBlockHash,
          },
          ...authenticatedHeaders,
        ];
  const replayHeaders = applyJBlockHeadersIngressTransform(ingressHeaders);
  const replayHashByHeight = new Map(replayHeaders.map(header => [header.jHeight, header.jBlockHash]));
  if (expectedParent) {
    const actual = replayHashByHeight.get(expectedParent.height);
    const expected = expectedParent.hash.toLowerCase();
    if (actual !== expected) {
      const code = expectedParent.finalized ? 'J_RECEIPT_FINALIZED_PARENT_REORG' : 'J_RECEIPT_RANGE_REORG';
      throw new Error(`${code}:height=${expectedParent.height}:expected=${expected}:actual=${actual ?? 'missing'}`);
    }
  }
  const headers = authenticatedHeaders.map(({ jHeight }) => {
    const jBlockHash = replayHashByHeight.get(jHeight);
    if (!jBlockHash) throw new Error(`J_AUTHENTICATED_REPLAY_HEADER_MISSING:${jHeight}`);
    return { jHeight, jBlockHash };
  });
  const logs = authenticatedRange.logs.map(log => {
    const blockHash = replayHashByHeight.get(log.blockNumber);
    if (!blockHash) throw new Error(`J_AUTHENTICATED_LOG_REPLAY_HEADER_MISSING:${log.blockNumber}`);
    return { ...log, blockHash };
  });
  const tipBlockHash = headers.at(-1)?.jBlockHash;
  if (!tipBlockHash) throw new Error('J_AUTHENTICATED_RANGE_TIP_UNAVAILABLE');
  return { headers, logs, tipBlockHash };
};

export const readRequiredRpcBatchBigInt = (
  responses: Map<number, RpcBatchResponse>,
  id: number,
  label: string,
): bigint => {
  const item = responses.get(id);
  if (!item) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_RPC_MISSING:${label}:id=${id}`);
  }
  if (item.error) {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_RPC_ERROR:${label}:${item.error.message || 'unknown'}`);
  }
  if (typeof item.result !== 'string') {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_RPC_INVALID_RESULT:${label}:id=${id}`);
  }
  try {
    return BigInt(item.result);
  } catch {
    throw new Error(`EXTERNAL_WALLET_SNAPSHOT_RPC_INVALID_BIGINT:${label}:id=${id}`);
  }
};

export const readOptionalRpcBatchBigInt = (
  responses: Map<number, RpcBatchResponse>,
  id: number,
  label: string,
): { ok: true; value: bigint } | { ok: false; error: string } => {
  try {
    return { ok: true, value: readRequiredRpcBatchBigInt(responses, id, label) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export type ExternalWalletTrackedOwnerCursor = {
  entityId: string;
  watchAfterBlock: number;
  balanceAfterBlockByToken: Map<string, number>;
  allowanceAfterBlockByKey: Map<string, number>;
};

export const normalizeTrackedKey = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase();

export const rpcErrorText = (error: unknown): string => {
  if (error instanceof Error) {
    const err = error as Error & {
      code?: unknown;
      shortMessage?: unknown;
      info?: unknown;
      cause?: unknown;
    };
    return [err.message, err.code, err.shortMessage, err.info, err.cause]
      .map(value => {
        try {
          return typeof value === 'string' ? value : JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .filter(Boolean)
      .join(' ');
  }
  return String(error);
};

export type RevertDecodeLogger = {
  warn(event: string, details: Record<string, unknown>): void;
};

export const decodeStandardSolidityRevertData = (revertData: string, log: RevertDecodeLogger = rpcLog): string => {
  const selector = revertData.slice(0, 10);
  const payloadBytes = Math.max(0, Math.floor((revertData.length - 2) / 2));
  try {
    if (selector === '0x08c379a0') {
      const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], `0x${revertData.slice(10)}`);
      return ` reason="${String(reason)}"`;
    }
    if (selector === '0x4e487b71') {
      const [panicCode] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], `0x${revertData.slice(10)}`);
      return ` panic=0x${BigInt(panicCode).toString(16)}`;
    }
    return '';
  } catch (error) {
    log.warn(selector === '0x08c379a0' ? 'revert.error_string_decode_failed' : 'revert.panic_decode_failed', {
      selector,
      payloadBytes,
      error: rpcErrorText(error),
    });
    return '';
  }
};

// HTTP 429 is a throttle, not a failed endpoint: a shared public RPC rate-limits
// by IP and recovers on its own. Treating it as fatal permanently halted the
// jurisdiction watcher, and every later restart short-circuited on the recorded
// fatal. It belongs with 503, which already lives in this list.
export const isTransientRpcUnavailableError = (error: unknown): boolean =>
  /J_HISTORY_HEADER_MISSING:height=\d+ error=none|J_RECEIPT_RANGE_REORG|J_RECEIPT_RANGE_PARENT_MISMATCH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|Failed to fetch|NetworkError|Load failed|Unexpected end of JSON input|PROXY_UPSTREAM_TIMEOUT|RPC_BATCH_TIMEOUT:\d+|RPC_BATCH_HTTP_429|RPC_BATCH_HTTP_50[0234]|429 Too Many Requests|50[0234] (Bad Gateway|Gateway Timeout|Service Unavailable|Internal Server Error)|server response (429|50[0234])|responseStatus["': ]+(429|50[0234])/i.test(
    rpcErrorText(error),
  );

export const shouldEmitExternalWalletBalanceDelta = (
  tracked: Pick<ExternalWalletTrackedOwnerCursor, 'watchAfterBlock' | 'balanceAfterBlockByToken'>,
  tokenAddress: string,
  blockNumber: number,
): boolean => {
  const normalizedToken = normalizeTrackedKey(tokenAddress);
  if (!normalizedToken || !tracked.balanceAfterBlockByToken.has(normalizedToken)) return false;
  const baselineBlock = tracked.balanceAfterBlockByToken.get(normalizedToken) ?? 0;
  return blockNumber > Math.max(baselineBlock, tracked.watchAfterBlock || 0);
};

export const shouldEmitExternalWalletAllowanceDelta = (
  tracked: Pick<ExternalWalletTrackedOwnerCursor, 'watchAfterBlock' | 'allowanceAfterBlockByKey'>,
  tokenAddress: string,
  spender: string,
  blockNumber: number,
): boolean => {
  const normalizedToken = normalizeTrackedKey(tokenAddress);
  const normalizedSpender = normalizeTrackedKey(spender);
  if (!normalizedToken || !normalizedSpender) return false;
  const key = `${normalizedToken}:${normalizedSpender}`;
  if (!tracked.allowanceAfterBlockByKey.has(key)) return false;
  const baselineBlock = tracked.allowanceAfterBlockByKey.get(key) ?? 0;
  return blockNumber > Math.max(baselineBlock, tracked.watchAfterBlock || 0);
};

export type ApprovalReceiptLog = {
  address?: string;
  topics: readonly string[];
  data: string;
  index?: number;
  logIndex?: number;
};

export const approvalEventInterface = new ethers.Interface([
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
]);
export const approvalEventFragment = approvalEventInterface.getEvent('Approval');
if (!approvalEventFragment) throw new Error('APPROVAL_EVENT_FRAGMENT_MISSING');

export const resolveApprovalReceiptLogIndex = (params: {
  receiptHash: string;
  logs: readonly ApprovalReceiptLog[];
  tokenAddress: string;
  owner: string;
  spender: string;
  allowance: bigint;
}): number => {
  const tokenAddress = ethers.getAddress(params.tokenAddress).toLowerCase();
  const owner = ethers.getAddress(params.owner).toLowerCase();
  const spender = ethers.getAddress(params.spender).toLowerCase();
  const matchingIndices: number[] = [];

  for (const log of params.logs) {
    if (String(log.address || '').toLowerCase() !== tokenAddress) continue;
    if (String(log.topics[0] || '').toLowerCase() !== approvalEventFragment.topicHash.toLowerCase()) continue;
    const parsed = approvalEventInterface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) throw new Error(`APPROVAL_EVENT_DECODE_FAILED:${params.receiptHash}`);
    if (
      ethers.getAddress(String(parsed.args[0])).toLowerCase() !== owner ||
      ethers.getAddress(String(parsed.args[1])).toLowerCase() !== spender ||
      BigInt(parsed.args[2]) !== params.allowance
    )
      continue;
    if (log.index !== undefined && log.logIndex !== undefined && log.index !== log.logIndex) {
      throw new Error(
        `APPROVAL_EVENT_LOG_INDEX_MISMATCH:${params.receiptHash}` +
          `:index=${String(log.index)}:logIndex=${String(log.logIndex)}`,
      );
    }
    const logIndex = log.index ?? log.logIndex;
    if (!Number.isSafeInteger(logIndex) || Number(logIndex) < 0) {
      throw new Error(`APPROVAL_EVENT_LOG_INDEX_INVALID:${params.receiptHash}:${String(logIndex)}`);
    }
    matchingIndices.push(Number(logIndex));
  }
  if (matchingIndices.length !== 1) {
    throw new Error(`APPROVAL_EVENT_MATCH_COUNT_INVALID:${params.receiptHash}:${matchingIndices.length}`);
  }
  return matchingIndices[0]!;
};

/**
 * Create RPC adapter - works with any JSON-RPC provider
 *
 * Modes:
 *   - anvil/rpc with no fromReplica: Deploys fresh contracts
 *   - rpc with fromReplica: Connects to existing contracts
 */
