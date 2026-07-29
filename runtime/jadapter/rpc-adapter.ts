import type { ContractRunner, Provider, Signer } from 'ethers';
import { ethers } from 'ethers';
import type {
  Account,
  DeltaTransformer,
  Depository,
  EntityProvider,
} from '../../jurisdictions/typechain-types/index.ts';
import {
  Account__factory,
  DeltaTransformer__factory,
  Depository__factory,
  EntityProvider__factory,
} from '../../jurisdictions/typechain-types/index.ts';
import { BLOCKCHAIN } from '../constants';
import {
  assertEntityProviderActionJTxBinding,
  assertEntityProviderActionResolutionReceipt,
} from '../entity/entity-provider-action';
import { normalizeEntityId } from '../entity/id';
import { prepareSignedBatch } from '../hanko/batch';
import { hashDisputeProofHankoPayload } from '../hanko/onchain-domain';
import { decodeJBatch, getBatchSize, isBatchEmpty, preflightBatchForE2 } from '../jurisdiction/batch';
import { getCertifiedBoardStackKey } from '../jurisdiction/board-registry';
import { requireUsableContractAddress } from '../jurisdiction/contract-address';
import { getEntityCertifiedJAnchor, getValidatorJExpectedBlockHash } from '../jurisdiction/local-history';
import {
  buildCertifiedRegistrationEvidence,
  markLocalJAuthorityRuntimeTx,
} from '../jurisdiction/registration-evidence';
import { assertSealedJBatchBinding } from '../jurisdiction/sealed-batch';
import { compareStableText, safeStringify } from '../protocol/serialization';
import { resolveEntityProposerId } from '../runtime/entity-output-signer';
import type { DisputeFinalizationEvidence, RuntimeState, JTx, RuntimeInput, RuntimeTx } from '../types';
import { TOKEN_REGISTRATION_AMOUNT, defaultTokensForJurisdiction, getDefaultTokenSupply } from '../jurisdiction/default-tokens';
import { extractCanonicalDepositoryEventArgs, parseKnownDepositoryLog } from './depository-event-codec';
import { classifyJAdapterFailure, makeJAdapterFailureResult } from './failure';
import {
  buildExternalTokenToReserveBatch,
  computeAccountKey,
  packTokenReference,
  parseReceiptLogsToJEvents,
} from './helpers';
import { CANONICAL_J_EVENTS } from '../jurisdiction/event-catalog';
import { DEV_CHAIN_IDS } from './index';
import { normalizeReceiptHash, parseReceiptQuantity } from '../jurisdiction/receipt-codec';
import { readAuthenticatedReceiptRange, type RpcBatchCall } from './receipt-root';
import { createRpcLifecycleMethods } from './rpc-lifecycle';
import { readAndAssertRpcChainId } from './rpc-network';
import {
  PROCESS_BATCH_GAS_FLOOR,
  applyProcessBatchGasFloor,
  decodeDisputeFinalizationEvidenceCalldata,
  decodeStandardSolidityRevertData,
  isTransientRpcUnavailableError,
  isTronChainId,
  prepareAuthenticatedWatcherIngress,
  resolveWatcherPollToBlock,
  rpcErrorText,
  rpcLog,
  shouldEmitExternalWalletAllowanceDelta,
  shouldEmitExternalWalletBalanceDelta,
  toFinalizationDecimal,
  toFinalizationHex,
  type ExternalWalletTrackedOwnerCursor,
  type TxFinalizationEvidence,
} from './rpc-public';
import { createRpcReadMethods } from './rpc-reads';
import {
  firstAddress,
  isDebugEventEmitter,
  linkArtifactBytecode,
  sendRpcBatch,
  type RpcBatchRequest,
  type RpcBatchResponse,
} from './rpc-utils';
import { createRpcWalletWriteMethods } from './rpc-wallet-writes';
import { assertDepositoryEntityProviderBinding } from './stack-binding';
import type {
  BrowserVMProvider,
  JAdapter,
  JAdapterAddresses,
  JAdapterConfig,
  JBatchReceipt,
  JEvent,
  JReserveMint,
  JSubmitResult,
} from './types';
import {
  applyJBlockHeadersIngressTransform,
  enqueueJHistoryRange,
  enqueueJHistoryRewindForReplicaKeys,
  findWatcherJurisdictionReplica,
  getMinimumCommittedSignerJHeight,
  getMinimumScannedSignerJHeight,
  getWatcherStartBlock,
  isEntityReplicaRelevantToWatcher,
  isWatcherJHistoryRangeDurable,
  processEventBatch,
  rememberPendingWatcherJBlock,
  resolveCommittedWatcherCursor,
  updateWatcherJurisdictionCursor,
  type EventBatchCounter,
  type PendingWatcherJBlockMap,
  type PendingWatcherJHistoryRange,
  type JEventIngress,
} from './watcher';
import { shouldAuditCanonicalWatcherState } from './watcher-poll-policy';
import {
  applyGasHeadroom,
  asFactoryRunner,
  asRpcReceipt,
  asRpcTxResponse,
  eventCarriers,
  haltProcessForFatalWatcherError,
  isNonceSyncError,
  makeAccountFactory,
  makeDeltaTransformerFactory,
  makeErc20MockFactory,
  makeHankoVerifierFactory,
  watcherErrorDetails,
  watcherErrorMessage,
  type FeeOverrides,
  type RpcReceipt,
  type TxOverrides,
  type UntypedActionMethod,
  type UntypedNonPayableMethod,
} from './rpc-boundary';

export async function createRpcAdapter(
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
  signer: Signer,
): Promise<JAdapter> {
  const watchOnly = Boolean(config.watchOnly && !DEV_CHAIN_IDS.has(config.chainId));
  const traceEnabled = process.env['JADAPTER_TRACE'] === '1';
  const mintDebugEnabled = process.env['XLN_JADAPTER_MINT_DEBUG'] === '1';
  let quietLogs = false;
  const trace = (phase: string, extra?: Record<string, unknown>): void => {
    if (!traceEnabled) return;
    console.log(`[JAdapter:rpc][trace] ${phase}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
  };
  const TX_WAIT_TIMEOUT_MS = Math.max(
    10_000,
    Math.floor(Number(process.env['JADAPTER_TX_WAIT_TIMEOUT_MS'] ?? config.txWaitTimeoutMs ?? 300_000)),
  );
  const TX_WAIT_CONFIRMS = Math.max(
    1,
    Math.floor(Number(process.env['JADAPTER_TX_WAIT_CONFIRMS'] ?? config.txWaitConfirms ?? 1)),
  );
  const GAS_HEADROOM_BPS = Math.max(10_000, Math.floor(Number(process.env['JADAPTER_GAS_HEADROOM_BPS'] ?? '12000')));
  const MAX_FEE_PER_GAS_GWEI = Math.max(1, Math.floor(Number(process.env['JADAPTER_MAX_FEE_GWEI'] ?? '200')));
  const MAX_FEE_PER_GAS_WEI = ethers.parseUnits(String(MAX_FEE_PER_GAS_GWEI), 'gwei');
  const isTransientRpcUnavailable = (error: unknown): boolean => {
    return isTransientRpcUnavailableError(error);
  };
  const isLocalLatestStateStaticCallRace = (error: unknown): boolean => {
    if (!DEV_CHAIN_IDS.has(config.chainId)) return false;
    const detail = safeStringify({
      message: watcherErrorMessage(error),
      details: watcherErrorDetails(error),
    });
    return /missing revert data|CALL_EXCEPTION|BlockOutOfRangeError|Failed to load state snapshot|No such file/i.test(
      detail,
    );
  };

  trace('provider.eth_chainId:start');
  const rpcChainId = await readAndAssertRpcChainId(provider, config.chainId);
  trace('provider.eth_chainId:done', { rpcChainId, configChainId: Number(config.chainId) });

  const estimateProcessBatchGas = async (
    estimate: () => Promise<bigint>,
  ): Promise<{ gasLimit: bigint; usedFallback: boolean; error?: unknown }> => {
    if (config.mode === 'tron') {
      return {
        gasLimit: applyGasHeadroom(await estimate(), GAS_HEADROOM_BPS),
        usedFallback: false,
      };
    }
    return estimateGasWithHeadroomResult(estimate, PROCESS_BATCH_GAS_FLOOR);
  };

  const resolveProcessBatchGasLimit = (gasLimit: bigint, hasDisputeFinalization: boolean): bigint =>
    config.mode === 'tron' ? gasLimit : applyProcessBatchGasFloor(gasLimit, hasDisputeFinalization);

  const resolveDeploymentDisputeDelayBlocks = (): number => {
    const raw = config.defaultDisputeDelayBlocks ?? (DEV_CHAIN_IDS.has(config.chainId) ? 5_760 : NaN);
    if (!Number.isSafeInteger(raw) || raw <= 0 || raw > 65_535) {
      throw new Error(`JADAPTER_DEPLOY_DISPUTE_DELAY_INVALID:${String(raw)}`);
    }
    return raw;
  };

  const formatReserveMintDebug = (mint: JReserveMint | undefined): string => {
    if (!mint) return 'none';
    return JSON.stringify({
      entityId: mint.entityId,
      tokenId: mint.tokenId,
      amount: mint.amount.toString(),
    });
  };

  const buildFeeOverrides = async (): Promise<FeeOverrides> => {
    if (config.mode === 'tron') return {};
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      return {
        maxFeePerGas: feeData.maxFeePerGas > MAX_FEE_PER_GAS_WEI ? MAX_FEE_PER_GAS_WEI : feeData.maxFeePerGas,
        maxPriorityFeePerGas:
          feeData.maxPriorityFeePerGas > MAX_FEE_PER_GAS_WEI ? MAX_FEE_PER_GAS_WEI : feeData.maxPriorityFeePerGas,
      };
    }
    throw new Error(
      `[JAdapter:rpc] EIP-1559 fee data unavailable for chainId=${config.chainId}. Refusing gasPrice-only mode.`,
    );
  };

  const waitForReceipt = async (txLike: unknown, label: string): Promise<RpcReceipt> => {
    const tx = asRpcTxResponse(txLike);
    const receipt = await tx.wait(TX_WAIT_CONFIRMS, TX_WAIT_TIMEOUT_MS);
    if (!receipt) {
      throw new Error(`${label} transaction not mined (hash=${tx.hash})`);
    }
    return asRpcReceipt(receipt);
  };

  const getBatchSignerPrivateKey = (): string => {
    if (config.privateKey) return config.privateKey;
    const signerPrivateKey = (signer as ethers.Wallet | { privateKey?: string }).privateKey;
    if (typeof signerPrivateKey === 'string' && signerPrivateKey.startsWith('0x')) {
      return signerPrivateKey;
    }
    throw new Error('[JAdapter:rpc] processBatch requires a signer private key for Hanko signing');
  };

  const signerForPrivateKey = async (privateKey: string): Promise<Signer> => {
    const forkable = signer as Signer & { forPrivateKey?: (key: string) => Signer };
    if (config.mode === 'tron') {
      if (forkable.forPrivateKey) return forkable.forPrivateKey(privateKey);
      const { createTronSigner } = await import('./tron-signer');
      return createTronSigner({
        provider,
        privateKey,
        rpcUrl: String(config.rpcUrl || ''),
        fullHost: config.tronFullHost,
        apiKey: config.tronApiKey || process.env['TRONGRID_API_KEY'],
      });
    }
    return new ethers.Wallet(privateKey, provider);
  };

  const processSignedBatch = async (
    entityId: string,
    batch: import('../jurisdiction/batch').JBatch,
    txSigner?: Signer,
    batchSignerPrivateKey?: string,
  ): Promise<JBatchReceipt> => {
    const activeSigner = txSigner ?? signer;
    return runSerializedBatchFor(activeSigner, async () => {
      try {
        const chainId = BigInt(config.chainId);
        const depositoryAddress = await depository.getAddress();
        const currentNonce = await depository.entityNonces(normalizeEntityId(entityId));
        const { encodedBatch, hankoData, nextNonce } = prepareSignedBatch(
          batch,
          entityId,
          batchSignerPrivateKey ?? getBatchSignerPrivateKey(),
          chainId,
          depositoryAddress,
          currentNonce,
        );

        const depositoryWithSigner = txSigner
          ? depository.connect(txSigner as unknown as Parameters<typeof depository.connect>[0])
          : depository;
        const feeOverrides = await buildFeeOverrides();
        const gasEstimate = await estimateProcessBatchGas(() =>
          depositoryWithSigner.processBatch.estimateGas(encodedBatch, hankoData, nextNonce),
        );
        const gasLimit = resolveProcessBatchGasLimit(gasEstimate.gasLimit, batch.disputeFinalizations.length > 0);

        const tx = await depositoryWithSigner.processBatch(encodedBatch, hankoData, nextNonce, {
          gasLimit,
          nonce: await allocateSerializedSignerNonceFor(activeSigner),
          ...feeOverrides,
        });
        const receipt = await waitForReceipt(tx, 'processBatch');
        const events = parseReceiptLogsToJEvents(receipt, eventCarriers(depository, entityProvider));

        return {
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          events,
        };
      } catch (error) {
        await resetSerializedSignerNonceFor(activeSigner);
        throw error;
      }
    });
  };

  type GasEstimateResult = {
    gasLimit: bigint;
    usedFallback: boolean;
    error?: unknown;
  };
  const estimateGasWithHeadroomResult = async (
    estimate: () => Promise<bigint>,
    fallback: bigint,
  ): Promise<GasEstimateResult> => {
    try {
      return {
        gasLimit: applyGasHeadroom(await estimate(), GAS_HEADROOM_BPS),
        usedFallback: false,
      };
    } catch (error) {
      return { gasLimit: fallback, usedFallback: true, error };
    }
  };
  const estimateGasWithHeadroom = async (estimate: () => Promise<bigint>, fallback: bigint): Promise<bigint> =>
    (await estimateGasWithHeadroomResult(estimate, fallback)).gasLimit;

  type SendTxOptions = {
    gasFallback: bigint;
    minimumGasLimit?: bigint;
    txNonce: number | null;
    resetSignerNonce: boolean;
  };

  const sendTypedTx = async (
    label: string,
    method: unknown,
    args: unknown[],
    options: SendTxOptions,
  ): Promise<RpcReceipt> => {
    const txMethod = method as UntypedNonPayableMethod;
    const estimatedGasLimit = await estimateGasWithHeadroom(() => txMethod.estimateGas(...args), options.gasFallback);
    const gasLimit =
      options.minimumGasLimit !== undefined && estimatedGasLimit < options.minimumGasLimit
        ? options.minimumGasLimit
        : estimatedGasLimit;
    if (options.resetSignerNonce) {
      maybeResetSignerNonce();
    }
    const feeOverrides = await buildFeeOverrides();
    const overrides: TxOverrides =
      options.txNonce === null ? { gasLimit, ...feeOverrides } : { gasLimit, nonce: options.txNonce, ...feeOverrides };
    const tx = await txMethod(...args, overrides);
    return waitForReceipt(tx, label);
  };

  const resolveFinalityDepth = (scenarioMode: boolean): number => {
    if (scenarioMode || DEV_CHAIN_IDS.has(config.chainId)) return 0;
    if (config.confirmationDepth !== undefined && Number.isFinite(config.confirmationDepth)) {
      const configuredDepth = Math.max(0, Math.floor(config.confirmationDepth));
      if (isTronChainId(config.chainId) && configuredDepth !== 0) {
        throw new Error('TRON_CONFIRMATION_DEPTH_FORBIDDEN: use the SolidityNode solidified head');
      }
      return configuredDepth;
    }
    if (config.chainId === 1) return 12;
    if (isTronChainId(config.chainId)) return 0;
    return 2;
  };

  const readCurrentRpcBlockNumber = async (): Promise<number> => {
    const raw = await (provider as ethers.JsonRpcProvider).send('eth_blockNumber', []);
    let blockNumber: number;
    try {
      blockNumber = Number(BigInt(String(raw)));
    } catch {
      throw new Error(`J_WATCHER_BLOCK_NUMBER_INVALID:${String(raw)}`);
    }
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new Error(`J_WATCHER_BLOCK_NUMBER_INVALID:${String(raw)}`);
    }
    return blockNumber;
  };

  const readTronSolidifiedBlockNumber = async (): Promise<number> => {
    const fullHost = String(config.tronFullHost || config.rpcUrl || '')
      .replace(/\/jsonrpc\/?$/i, '')
      .replace(/\/$/, '');
    if (!fullHost) throw new Error('TRON_FULL_HOST_MISSING');
    const response = await fetch(`${fullHost}/walletsolidity/getnowblock`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.tronApiKey ? { 'TRON-PRO-API-KEY': config.tronApiKey } : {}),
      },
      body: '{}',
    });
    if (!response.ok) throw new Error(`TRON_SOLIDIFIED_HEAD_HTTP:${response.status}`);
    const payload = (await response.json()) as { block_header?: { raw_data?: { number?: unknown } } };
    const blockNumber = Number(payload.block_header?.raw_data?.number);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new Error(`TRON_SOLIDIFIED_HEAD_INVALID:${String(payload.block_header?.raw_data?.number)}`);
    }
    return blockNumber;
  };

  const readSafeWatcherBlockNumber = async (): Promise<number> =>
    isTronChainId(config.chainId) ? readTronSolidifiedBlockNumber() : readCurrentRpcBlockNumber();

  const sendTronRpcCall = async (request: RpcBatchRequest): Promise<RpcBatchResponse> => {
    const rpcUrl = String(config.rpcUrl || '').trim();
    if (!rpcUrl) throw new Error('TRON_RPC_URL_MISSING');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.tronApiKey ? { 'TRON-PRO-API-KEY': config.tronApiKey } : {}),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`TRON_RPC_HTTP:${request.method}:${response.status}`);
      const payload = (await response.json()) as RpcBatchResponse;
      if (payload.id !== request.id) {
        throw new Error(`TRON_RPC_ID_MISMATCH:${request.method}:${request.id}:${String(payload.id)}`);
      }
      return payload;
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        throw new Error(`TRON_RPC_TIMEOUT:${request.method}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const sendTronRpcCalls = async (requests: readonly RpcBatchRequest[]): Promise<Map<number, RpcBatchResponse>> => {
    const responses = new Map<number, RpcBatchResponse>();
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < requests.length) {
        const request = requests[nextIndex++];
        if (!request) return;
        responses.set(request.id, await sendTronRpcCall(request));
      }
    };
    await Promise.all(Array.from({ length: Math.min(12, requests.length) }, worker));
    return responses;
  };

  const sendAuthenticatedRpcBatch = async (calls: readonly RpcBatchCall[]): Promise<unknown[]> => {
    if (calls.length === 0) return [];
    const rpcUrl = String(config.rpcUrl || '').trim();
    if (!rpcUrl) throw new Error('J_RECEIPT_BATCH_RPC_URL_MISSING');
    const batch: RpcBatchRequest[] = calls.map((call, index) => ({
      id: index + 1,
      jsonrpc: '2.0',
      method: call.method,
      params: call.params,
    }));
    const responses = isTronChainId(config.chainId) ? await sendTronRpcCalls(batch) : await sendRpcBatch(rpcUrl, batch);
    return batch.map(request => {
      const response = responses.get(request.id);
      if (!response) throw new Error(`J_RECEIPT_BATCH_RESPONSE_MISSING:${request.id}:${request.method}`);
      if (response.error) {
        throw new Error(
          `J_RECEIPT_BATCH_CALL_FAILED:${request.id}:${request.method}:` +
            `${String(response.error.message || 'unknown')}`,
        );
      }
      if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
        throw new Error(`J_RECEIPT_BATCH_RESULT_MISSING:${request.id}:${request.method}`);
      }
      return response.result;
    });
  };

  const readBlockHeadersAtHeights = async (
    heights: number[],
  ): Promise<Array<{ jHeight: number; jBlockHash: string }>> => {
    const rpcUrl = String(config.rpcUrl || '').trim();
    if (!rpcUrl) throw new Error('J_HISTORY_HEADER_RPC_URL_MISSING');
    const canonicalHeights = [...new Set(heights)].sort((left, right) => left - right);
    const requests: RpcBatchRequest[] = canonicalHeights.map(jHeight => ({
      id: jHeight,
      jsonrpc: '2.0',
      method: 'eth_getBlockByNumber',
      params: [ethers.toQuantity(jHeight), false],
    }));
    const responses = isTronChainId(config.chainId)
      ? await sendTronRpcCalls(requests)
      : await sendRpcBatch(rpcUrl, requests);
    const headers = requests.map(({ id }) => {
      const response = responses.get(id);
      const block =
        response?.result && typeof response.result === 'object'
          ? (response.result as { hash?: unknown; number?: unknown; parentHash?: unknown })
          : null;
      if (response?.error || !block) {
        throw new Error(`J_HISTORY_HEADER_MISSING:height=${id} error=${String(response?.error?.message || 'none')}`);
      }
      const number = Number(parseReceiptQuantity(block.number, 'HEADER_BLOCK_NUMBER'));
      if (number !== id) throw new Error(`J_HISTORY_HEADER_NUMBER_MISMATCH:expected=${id}:actual=${number}`);
      return {
        jHeight: number,
        jBlockHash: normalizeReceiptHash(block.hash, 'HEADER_BLOCK_HASH'),
        parentHash: normalizeReceiptHash(block.parentHash, 'HEADER_PARENT_HASH'),
      };
    });
    for (let index = 1; index < headers.length; index += 1) {
      const parent = headers[index - 1]!;
      const child = headers[index]!;
      if (child.jHeight === parent.jHeight + 1 && child.parentHash !== parent.jBlockHash) {
        throw new Error(
          `J_HISTORY_HEADER_PARENT_MISMATCH:height=${child.jHeight}:` +
            `expected=${parent.jBlockHash}:actual=${child.parentHash}`,
        );
      }
    }
    return applyJBlockHeadersIngressTransform(
      headers.map(({ jHeight, jBlockHash }) => ({
        jHeight,
        jBlockHash,
      })),
    );
  };

  // Serialize batch submissions per signer EOA to avoid nonce races across concurrent entity batches.
  const batchSubmitQueues = new Map<string, Promise<unknown>>();
  const nextSerializedSignerNonces = new Map<string, number>();
  const getSerializedSignerKey = async (activeSigner: Signer): Promise<string> => {
    return (await activeSigner.getAddress()).toLowerCase();
  };
  const runSerializedBatchFor = async <T>(activeSigner: Signer, work: () => Promise<T>): Promise<T> => {
    const signerKey = await getSerializedSignerKey(activeSigner);
    const previous = batchSubmitQueues.get(signerKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    batchSubmitQueues.set(
      signerKey,
      next.finally(() => {
        if (batchSubmitQueues.get(signerKey) === next) {
          batchSubmitQueues.delete(signerKey);
        }
      }),
    );
    return next;
  };
  const runSerializedBatch = async <T>(work: () => Promise<T>): Promise<T> => {
    return runSerializedBatchFor(signer, work);
  };

  type NonceResettableSigner = {
    resetNonce(): void;
  };
  const maybeResetSignerNonceFor = (activeSigner: Signer): void => {
    const candidate = activeSigner as unknown as Partial<NonceResettableSigner>;
    if (typeof candidate.resetNonce === 'function') {
      try {
        candidate.resetNonce();
      } catch (error) {
        rpcLog.warn('signer.nonce_reset_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  const maybeResetSignerNonce = (): void => {
    maybeResetSignerNonceFor(signer);
  };

  const resetSerializedSignerNonceFor = async (activeSigner: Signer): Promise<void> => {
    const signerKey = await getSerializedSignerKey(activeSigner);
    nextSerializedSignerNonces.delete(signerKey);
    maybeResetSignerNonceFor(activeSigner);
  };
  const resetSerializedSignerNonce = async (): Promise<void> => {
    await resetSerializedSignerNonceFor(signer);
  };

  const readSignerTxNonceFor = async (activeSigner: Signer): Promise<number> => {
    const signerAddress = await activeSigner.getAddress();
    return Math.max(
      await provider.getTransactionCount(signerAddress, 'latest'),
      await provider.getTransactionCount(signerAddress, 'pending'),
    );
  };
  const allocateSerializedSignerNonceFor = async (activeSigner: Signer): Promise<number> => {
    if (config.mode === 'tron') return 0;
    const signerKey = await getSerializedSignerKey(activeSigner);
    const chainNonce = await readSignerTxNonceFor(activeSigner);
    const cachedNonce = nextSerializedSignerNonces.has(signerKey)
      ? (nextSerializedSignerNonces.get(signerKey) ?? null)
      : null;
    let nextNonce = cachedNonce;
    if (nextNonce === null || chainNonce > nextNonce) {
      nextNonce = chainNonce;
    }
    const nonce = nextNonce;
    nextSerializedSignerNonces.set(signerKey, nonce + 1);
    return nonce;
  };
  const allocateSerializedSignerNonce = async (): Promise<number> => {
    return allocateSerializedSignerNonceFor(signer);
  };

  const sendSignerTxWithExplicitNonce = async (
    activeSigner: Signer,
    label: string,
    send: (nonce: number, feeOverrides: FeeOverrides) => Promise<unknown>,
  ): Promise<RpcReceipt> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          await resetSerializedSignerNonceFor(activeSigner);
          console.warn(`⚠️ [JAdapter:rpc] retrying ${label} after nonce sync (attempt ${attempt}/2)`);
        }
        const nonce = await allocateSerializedSignerNonceFor(activeSigner);
        const feeOverrides = await buildFeeOverrides();
        console.log(`🔐 [JAdapter:rpc] ${label} nonce=${nonce}`);
        const tx = await send(nonce, feeOverrides);
        return await waitForReceipt(tx, label);
      } catch (error) {
        if (attempt < 2 && isNonceSyncError(error)) {
          continue;
        }
        await resetSerializedSignerNonceFor(activeSigner);
        throw error;
      }
    }
    throw new Error(`${label} failed after nonce retry`);
  };

  const addresses: JAdapterAddresses = {
    account: '',
    depository: '',
    entityProvider: '',
    deltaTransformer: '',
  };

  let account: Account;
  let depository: Depository;
  let entityProvider: EntityProvider;
  let deltaTransformer: DeltaTransformer;
  let deployed = false;
  let stackBindingVerified = false;
  let closePromise: Promise<void> | null = null;
  let entityProviderDeploymentBlock = Number(config.fromReplica?.entityProviderDeploymentBlock ?? 0);

  const verifyStackBinding = async (context: string): Promise<void> => {
    stackBindingVerified = false;
    await assertDepositoryEntityProviderBinding(context, depository, addresses.entityProvider);
    stackBindingVerified = true;
  };

  // If fromReplica provided, connect to existing contracts
  if (config.fromReplica) {
    if (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1) {
      throw new Error('RPC_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_REQUIRED');
    }
    addresses.account = firstAddress(
      config.fromReplica.jadapter?.addresses?.account,
      config.fromReplica.contracts?.account,
    );
    addresses.depository = firstAddress(
      config.fromReplica.jadapter?.addresses?.depository,
      config.fromReplica.contracts?.depository,
      config.fromReplica.depositoryAddress,
    );
    addresses.entityProvider = firstAddress(
      config.fromReplica.jadapter?.addresses?.entityProvider,
      config.fromReplica.contracts?.entityProvider,
      config.fromReplica.entityProviderAddress,
    );
    addresses.deltaTransformer = firstAddress(
      config.fromReplica.jadapter?.addresses?.deltaTransformer,
      config.fromReplica.contracts?.deltaTransformer,
    );

    rpcLog.info('contracts.connect_from_replica.start', {
      chainId: config.chainId,
      account: addresses.account,
      depository: addresses.depository,
      entityProvider: addresses.entityProvider,
      deltaTransformer: addresses.deltaTransformer,
    });

    const missingReplicaAddresses = [
      !addresses.account ? 'account' : null,
      !addresses.depository ? 'depository' : null,
      !addresses.entityProvider ? 'entityProvider' : null,
      !addresses.deltaTransformer ? 'deltaTransformer' : null,
    ].filter((value): value is string => Boolean(value));
    if (missingReplicaAddresses.length > 0) {
      throw new Error(`fromReplica: Missing required addresses (${missingReplicaAddresses.join(', ')})`);
    }

    trace('fromReplica.getCode:start');
    const accountCode = await provider.getCode(addresses.account);
    const depCode = await provider.getCode(addresses.depository);
    const epCode = await provider.getCode(addresses.entityProvider);
    const transformerCode = await provider.getCode(addresses.deltaTransformer);
    trace('fromReplica.getCode:done', {
      accountLen: accountCode.length,
      depLen: depCode.length,
      epLen: epCode.length,
      transformerLen: transformerCode.length,
    });

    if (accountCode === '0x' || depCode === '0x' || epCode === '0x' || transformerCode === '0x') {
      throw new Error(
        '[JAdapter:rpc] fromReplica contract addresses have no code on chain: ' +
          `account=${addresses.account || 'none'} code=${accountCode} ` +
          `depository=${addresses.depository || 'none'} code=${depCode} ` +
          `entityProvider=${addresses.entityProvider || 'none'} code=${epCode} ` +
          `deltaTransformer=${addresses.deltaTransformer || 'none'} code=${transformerCode}`,
      );
    } else {
      trace('fromReplica.connect:start');
      // Use any cast to handle ethers version mismatch between root and jurisdictions
      account = Account__factory.connect(addresses.account, asFactoryRunner(signer));
      depository = Depository__factory.connect(addresses.depository, asFactoryRunner(signer));
      entityProvider = EntityProvider__factory.connect(addresses.entityProvider, asFactoryRunner(signer));
      deltaTransformer = DeltaTransformer__factory.connect(addresses.deltaTransformer, asFactoryRunner(signer));
      trace('fromReplica.connect:done');
      trace('fromReplica.getAddress:start');
      addresses.account = await account.getAddress();
      addresses.depository = await depository.getAddress();
      addresses.entityProvider = await entityProvider.getAddress();
      addresses.deltaTransformer = await deltaTransformer.getAddress();
      await verifyStackBinding('rpc_from_replica');
      trace('fromReplica.getAddress:done', { addresses });
      deployed = true;
      trace('fromReplica.setDeltaTransformer:start');
      trace('fromReplica.setDeltaTransformer:done');
      rpcLog.info('contracts.connected', {
        chainId: config.chainId,
        account: addresses.account,
        depository: addresses.depository,
        entityProvider: addresses.entityProvider,
        deltaTransformer: addresses.deltaTransformer,
      });
    }
  }

  const getLiveDepositoryAddress = async (): Promise<string> =>
    requireUsableContractAddress('depository', depository ? await depository.getAddress() : addresses.depository);

  const getLiveEntityProviderAddress = async (): Promise<string> =>
    requireUsableContractAddress(
      'entity_provider',
      entityProvider ? await entityProvider.getAddress() : addresses.entityProvider,
    );

  const readEntityProviderActionReceipt = async (entityId: string, actionNonce: bigint): Promise<JEvent | null> => {
    const normalizedEntityId = normalizeEntityId(entityId);
    if (actionNonce <= 0n || actionNonce > ethers.MaxUint256) {
      throw new Error(`ENTITY_PROVIDER_ACTION_RECEIPT_NONCE_INVALID:${actionNonce.toString()}`);
    }
    if (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1) {
      throw new Error('ENTITY_PROVIDER_DEPLOYMENT_BLOCK_UNAVAILABLE');
    }
    const providerAddress = await getLiveEntityProviderAddress();
    const logs = (
      await Promise.all(
        (['EntityProviderActionExecuted', 'EntityProviderActionCancelled'] as const).map(async eventName => {
          const event = entityProvider.interface.getEvent(eventName);
          return await provider.getLogs({
            address: providerAddress,
            fromBlock: entityProviderDeploymentBlock,
            toBlock: 'latest',
            topics: [
              event.topicHash,
              ethers.zeroPadValue(normalizedEntityId, 32),
              ethers.zeroPadValue(ethers.toBeHex(actionNonce), 32),
            ],
          });
        }),
      )
    ).flat();
    if (logs.length > 1) {
      throw new Error(`ENTITY_PROVIDER_ACTION_RECEIPT_DUPLICATE:${normalizedEntityId}:${actionNonce.toString()}`);
    }
    const log = logs[0];
    if (!log) return null;
    const parsed = entityProvider.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (
      !parsed ||
      (parsed.name !== 'EntityProviderActionExecuted' && parsed.name !== 'EntityProviderActionCancelled')
    ) {
      throw new Error(`ENTITY_PROVIDER_ACTION_RECEIPT_DECODE_FAILED:${log.transactionHash}`);
    }
    return {
      name: parsed.name,
      args: Object.fromEntries(parsed.fragment.inputs.map((input, index) => [input.name, parsed.args[index]])),
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    };
  };

  const hasProcessedBatch = async (entityId: string, batchHash: string, entityNonce: bigint): Promise<boolean> => {
    const normalizedEntityId = normalizeEntityId(entityId);
    if (!ethers.isHexString(batchHash, 32)) {
      throw new Error(`HANKO_BATCH_RECEIPT_HASH_INVALID:${batchHash}`);
    }
    if (entityNonce <= 0n || entityNonce > ethers.MaxUint256) {
      throw new Error(`HANKO_BATCH_RECEIPT_NONCE_INVALID:${entityNonce.toString()}`);
    }
    const event = depository.interface.getEvent('HankoBatchProcessed');
    if (!event) throw new Error('HANKO_BATCH_EVENT_ABI_MISSING');
    const logs = await provider.getLogs({
      address: await getLiveDepositoryAddress(),
      fromBlock: Math.max(0, entityProviderDeploymentBlock),
      toBlock: 'latest',
      topics: [event.topicHash, ethers.zeroPadValue(normalizedEntityId, 32), ethers.zeroPadValue(batchHash, 32)],
    });
    const exact = logs.filter(log => {
      const parsed = depository.interface.parseLog({ topics: [...log.topics], data: log.data });
      return parsed?.name === 'HankoBatchProcessed' && BigInt(parsed.args['nonce']) === entityNonce;
    });
    if (exact.length > 1) {
      throw new Error(`HANKO_BATCH_RECEIPT_DUPLICATE:${normalizedEntityId}:${batchHash}:${entityNonce.toString()}`);
    }
    return exact.length === 1;
  };

  const adapter: JAdapter = {
    mode: config.mode,
    chainId: config.chainId,
    provider,
    signer,

    get account() {
      return account;
    },
    get depository() {
      return depository;
    },
    get entityProvider() {
      return entityProvider;
    },
    get deltaTransformer() {
      return deltaTransformer;
    },
    get addresses() {
      return addresses;
    },
    get entityProviderDeploymentBlock() {
      if (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1) {
        throw new Error('ENTITY_PROVIDER_DEPLOYMENT_BLOCK_UNAVAILABLE');
      }
      return entityProviderDeploymentBlock;
    },

    async deployStack() {
      if (deployed) {
        await verifyStackBinding('rpc_reuse_existing');
        rpcLog.info('contracts.reuse_existing', { chainId: config.chainId });
        return;
      }

      rpcLog.info('contracts.deploy.start', { chainId: config.chainId });

      // Deploy Account library
      // Use any cast to handle ethers version mismatch between root and jurisdictions
      const accountFactory = makeAccountFactory(signer);
      const accountContract = await accountFactory.deploy();
      await accountContract.waitForDeployment();
      addresses.account = await accountContract.getAddress();
      account = accountContract;
      rpcLog.debug('contracts.deploy.account', { chainId: config.chainId, account: addresses.account });

      // Deploy and link the bounded Hanko verifier before EntityProvider.
      const hankoVerifierFactory = makeHankoVerifierFactory(signer);
      const hankoVerifierContract = await hankoVerifierFactory.deploy();
      await hankoVerifierContract.waitForDeployment();
      const hankoVerifierAddress = await hankoVerifierContract.getAddress();
      const linkedEntityProviderBytecode = linkArtifactBytecode(EntityProvider__factory.bytecode, {
        'contracts/HankoVerifier.sol:HankoVerifier': hankoVerifierAddress,
      });
      const entityProviderFactory = new ethers.ContractFactory(
        EntityProvider__factory.abi,
        linkedEntityProviderBytecode,
        signer,
      );
      const foundationRecipient = await signer.getAddress();
      const entityProviderContract = (await entityProviderFactory.deploy(
        foundationRecipient,
      )) as unknown as EntityProvider;
      await entityProviderContract.waitForDeployment();
      const entityProviderReceipt = await entityProviderContract.deploymentTransaction()?.wait();
      if (!entityProviderReceipt || !Number.isSafeInteger(entityProviderReceipt.blockNumber)) {
        throw new Error('ENTITY_PROVIDER_DEPLOYMENT_RECEIPT_MISSING');
      }
      entityProviderDeploymentBlock = entityProviderReceipt.blockNumber;
      addresses.entityProvider = await entityProviderContract.getAddress();
      entityProvider = entityProviderContract;
      rpcLog.debug('contracts.deploy.entity_provider', {
        chainId: config.chainId,
        entityProvider: addresses.entityProvider,
        foundationRecipient,
        hankoVerifier: hankoVerifierAddress,
      });

      // Deploy Depository (needs Account library linked)
      const linkedDepositoryBytecode = linkArtifactBytecode(Depository__factory.bytecode, {
        'contracts/Account.sol:Account': addresses.account,
      });
      const depositoryFactory = new ethers.ContractFactory(
        Depository__factory.abi,
        linkedDepositoryBytecode,
        signer as ContractRunner,
      );
      // Fresh dev-chain deployments can exceed 30M after linking + viaIR.
      let deployGasLimit = DEV_CHAIN_IDS.has(config.chainId)
        ? BigInt(process.env['JADAPTER_DEPLOY_GAS_LIMIT'] ?? '60000000')
        : 30_000_000n;
      if (!DEV_CHAIN_IDS.has(config.chainId)) {
        try {
          const latestBlock = await provider.getBlock('latest');
          if (latestBlock?.gasLimit) {
            const margin = 1_000_000n;
            deployGasLimit = latestBlock.gasLimit > margin ? latestBlock.gasLimit - margin : latestBlock.gasLimit;
          }
        } catch (error) {
          rpcLog.warn('contracts.deploy.gas_limit_lookup_failed', {
            chainId: config.chainId,
            fallbackGasLimit: deployGasLimit.toString(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const depositoryContract = await depositoryFactory.deploy(
        addresses.entityProvider,
        resolveDeploymentDisputeDelayBlocks(),
        { gasLimit: deployGasLimit },
      );
      await depositoryContract.waitForDeployment();
      addresses.depository = await depositoryContract.getAddress();
      depository = Depository__factory.connect(addresses.depository, asFactoryRunner(signer));
      await verifyStackBinding('rpc_deploy');
      rpcLog.debug('contracts.deploy.depository', { chainId: config.chainId, depository: addresses.depository });

      // Deploy DeltaTransformer
      const deltaTransformerFactory = makeDeltaTransformerFactory(signer);
      const deltaTransformerContract = await deltaTransformerFactory.deploy();
      await deltaTransformerContract.waitForDeployment();
      addresses.deltaTransformer = await deltaTransformerContract.getAddress();
      deltaTransformer = deltaTransformerContract;
      rpcLog.debug('contracts.deploy.delta_transformer', {
        chainId: config.chainId,
        deltaTransformer: addresses.deltaTransformer,
      });

      // Deploy bootstrap ERC20 test tokens. The first three IDs stay stable
      // across dev chains (USDC=1, WETH=2, USDT=3); Tron-like local chains
      // receive extra jurisdiction-specific tokens after those IDs.
      const erc20Factory = makeErc20MockFactory(signer);
      const bootstrapTokens = defaultTokensForJurisdiction({ chainId: config.chainId });
      for (const token of bootstrapTokens) {
        const tokenSupply = getDefaultTokenSupply(token.decimals);
        const erc20Contract = await erc20Factory.deploy(token.name, token.symbol, token.decimals, tokenSupply);
        await erc20Contract.waitForDeployment();
        const erc20Address = await erc20Contract.getAddress();
        rpcLog.debug('contracts.deploy.erc20', {
          chainId: config.chainId,
          symbol: token.symbol,
          address: erc20Address,
        });

        // Pre-fund Depository with ERC20 so withdrawals (reserveToExternalToken) work.
        // mintToReserve only updates internal accounting — the Depository needs real ERC20 balance.
        const prefundTx = await erc20Contract.mint(addresses.depository, tokenSupply, await buildFeeOverrides());
        await waitForReceipt(prefundTx, `erc20.mint-to-depository.${token.symbol}`);
        rpcLog.debug('contracts.deploy.erc20_prefunded', {
          chainId: config.chainId,
          symbol: token.symbol,
          amount: ethers.formatUnits(tokenSupply, token.decimals),
        });

        const approveTx = await erc20Contract.approve(
          addresses.depository,
          TOKEN_REGISTRATION_AMOUNT,
          await buildFeeOverrides(),
        );
        await waitForReceipt(approveTx, `erc20.approve.${token.symbol}`);
        const registerTx = await depository.adminRegisterExternalToken(
          {
            entity: ethers.ZeroHash,
            contractAddress: erc20Address,
            externalTokenId: 0,
            tokenType: 0,
            internalTokenId: 0,
            amount: TOKEN_REGISTRATION_AMOUNT,
          },
          await buildFeeOverrides(),
        );
        await waitForReceipt(registerTx, `depository.externalTokenToReserve.${token.symbol}`);
        const packed = packTokenReference(0, erc20Address, 0n);
        const tokenId = await depository.tokenToId(packed);
        if (tokenId === 0n) {
          throw new Error(`[JAdapter:rpc] Failed to register bootstrap ERC20 token ${token.symbol}`);
        }
        rpcLog.debug('contracts.deploy.token_registered', {
          chainId: config.chainId,
          symbol: token.symbol,
          tokenId: tokenId.toString(),
        });
      }

      deployed = true;

      rpcLog.info('contracts.deploy.ready', {
        chainId: config.chainId,
        tokens: bootstrapTokens.map(token => token.symbol),
        account: addresses.account,
        depository: addresses.depository,
        entityProvider: addresses.entityProvider,
        deltaTransformer: addresses.deltaTransformer,
      });
    },

    ...createRpcLifecycleMethods({
      provider,
      chainId: config.chainId,
      ...(config.stateFile ? { stateFile: config.stateFile } : {}),
      markStackBindingUnverified: () => {
        stackBindingVerified = false;
      },
      verifyStackBinding,
    }),

    ...createRpcReadMethods({
      provider,
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
      get depository() {
        return depository;
      },
      get entityProvider() {
        return entityProvider;
      },
      hasProcessedBatch,
      readEntityProviderActionReceipt,
    }),

    // === WRITE METHODS ===
    // === WRITE METHODS ===

    async processBatch(encodedBatch: string, hankoData: string, nonce: bigint): Promise<JBatchReceipt> {
      return runSerializedBatch(async () => {
        try {
          const batch = decodeJBatch(encodedBatch);
          const receipt = await sendTypedTx('processBatch', depository.processBatch, [encodedBatch, hankoData, nonce], {
            gasFallback: PROCESS_BATCH_GAS_FLOOR,
            ...(config.mode === 'tron' || batch.disputeFinalizations.length === 0
              ? {}
              : { minimumGasLimit: PROCESS_BATCH_GAS_FLOOR }),
            txNonce: await allocateSerializedSignerNonce(),
            resetSignerNonce: true,
          });
          const events = parseReceiptLogsToJEvents(receipt, eventCarriers(depository, entityProvider));

          return {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            events,
          };
        } catch (error) {
          await resetSerializedSignerNonce();
          throw error;
        }
      });
    },

    async enforceDebts(entityId: string, tokenId: number, maxIterations: number | bigint = 100n): Promise<void> {
      await runSerializedBatch(async () => {
        try {
          const iterationCap = BigInt(maxIterations);
          await sendTypedTx('enforceDebts', depository.enforceDebts, [entityId, BigInt(tokenId), iterationCap], {
            gasFallback: 500_000n,
            txNonce: await allocateSerializedSignerNonce(),
            resetSignerNonce: false,
          });
        } catch (error) {
          await resetSerializedSignerNonce();
          throw error;
        }
      });
    },

    async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<JEvent[]> {
      // For dev chains (anvil), allow debug funding for testnet
      if (DEV_CHAIN_IDS.has(config.chainId)) {
        return runSerializedBatch(async () => {
          try {
            const receipt = await sendTypedTx('mintToReserve', depository.mintToReserve, [entityId, tokenId, amount], {
              gasFallback: 1_000_000n,
              txNonce: await allocateSerializedSignerNonce(),
              resetSignerNonce: false,
            });
            return parseReceiptLogsToJEvents(receipt, eventCarriers(depository));
          } catch (error) {
            await resetSerializedSignerNonce();
            throw error;
          }
        });
      }
      // Real networks: must use real deposits
      throw new Error('debugFundReserves only available on configured dev chains - use real token deposits');
    },

    async debugFundReservesBatch(mints: JReserveMint[]): Promise<JEvent[]> {
      if (!DEV_CHAIN_IDS.has(config.chainId)) {
        throw new Error('debugFundReservesBatch only available on configured dev chains');
      }
      if (mints.length === 0) return [];
      if (mintDebugEnabled && !quietLogs) {
        console.log(
          `[JAdapter:rpc] mintToReserve loop start chainId=${config.chainId} ` +
            `count=${mints.length} ` +
            `first=${formatReserveMintDebug(mints[0])}`,
        );
      }
      return runSerializedBatch(async () => {
        try {
          const events: JEvent[] = [];
          for (const mint of mints) {
            const receipt = await sendTypedTx(
              'mintToReserve',
              depository.mintToReserve,
              [mint.entityId, BigInt(mint.tokenId), mint.amount],
              {
                gasFallback: 1_000_000n,
                txNonce: await allocateSerializedSignerNonce(),
                resetSignerNonce: false,
              },
            );
            events.push(...parseReceiptLogsToJEvents(receipt, eventCarriers(depository)));
          }
          return events;
        } catch (error) {
          await resetSerializedSignerNonce();
          throw error;
        }
      });
    },

    async externalTokenToReserve(
      signerPrivateKey: Uint8Array,
      entityId: string,
      tokenAddress: string,
      amount: bigint,
      options?: {
        tokenType?: number;
        externalTokenId?: bigint;
        internalTokenId?: number;
      },
    ): Promise<JEvent[]> {
      const walletPrivateKey = `0x${Buffer.from(signerPrivateKey).toString('hex')}`;
      const signerWallet = await signerForPrivateKey(walletPrivateKey);
      const signerAddress = await signerWallet.getAddress();

      const tokenType = options?.tokenType ?? 0;
      const externalTokenIdRaw = options?.externalTokenId ?? 0n;
      const externalTokenId = typeof externalTokenIdRaw === 'bigint' ? externalTokenIdRaw : BigInt(externalTokenIdRaw);
      const internalTokenId = options?.internalTokenId ?? 0;

      if (tokenType !== 0) {
        throw new Error('RPC adapter externalTokenToReserve currently supports ERC20 only');
      }

      const erc20 = new ethers.Contract(
        tokenAddress,
        [
          'function balanceOf(address owner) view returns (uint256)',
          'function approve(address spender, uint256 amount) returns (bool)',
          'function allowance(address owner, address spender) view returns (uint256)',
        ],
        signerWallet,
      );

      const tokenCode = await provider.getCode(tokenAddress);
      if (!tokenCode || tokenCode === '0x') {
        throw new Error(`ERC20 token not deployed at ${tokenAddress}`);
      }

      const balanceFn = erc20.getFunction('balanceOf') as (owner: string) => Promise<bigint>;
      const externalBalance = await balanceFn(signerAddress);
      if (externalBalance < amount) {
        throw new Error(
          `Insufficient external token balance: have ${externalBalance}, need ${amount} at ${tokenAddress}`,
        );
      }

      const allowanceFn = erc20.getFunction('allowance') as (owner: string, spender: string) => Promise<bigint>;
      const liveDepositoryAddress = await getLiveDepositoryAddress();
      const allowance: bigint = await allowanceFn(signerAddress, liveDepositoryAddress);
      if (allowance < amount) {
        const approveFn = erc20.getFunction('approve') as (
          spender: string,
          amount: bigint,
          overrides?: TxOverrides,
        ) => Promise<unknown>;
        await runSerializedBatchFor(signerWallet, async () => {
          if (allowance > 0n) {
            await sendSignerTxWithExplicitNonce(signerWallet, 'erc20ApproveReset', (nonce, feeOverrides) =>
              approveFn(liveDepositoryAddress, 0n, {
                ...feeOverrides,
                nonce,
              }),
            );
          }
          await sendSignerTxWithExplicitNonce(signerWallet, 'erc20ApproveMax', (nonce, feeOverrides) =>
            approveFn(liveDepositoryAddress, ethers.MaxUint256, {
              ...feeOverrides,
              nonce,
            }),
          );
        });
        console.log(`[JAdapter:rpc] Approved max allowance for current token at Depository`);
      }

      const batch = buildExternalTokenToReserveBatch({
        entityId,
        tokenAddress,
        amount,
        tokenType,
        externalTokenId,
        internalTokenId,
      });
      const receipt = await processSignedBatch(entityId, batch, signerWallet, walletPrivateKey);
      const normalizedEntityId = normalizeEntityId(entityId);
      const batchProcessed = receipt.events.find(
        event =>
          event.name === 'HankoBatchProcessed' &&
          String(event.args['entityId'] || '').toLowerCase() === normalizedEntityId,
      );
      if (batchProcessed && batchProcessed.args['success'] === false) {
        throw new Error(`externalTokenToReserve failed on-chain for ${normalizedEntityId.slice(-8)}`);
      }
      const reserveUpdated = receipt.events.find(
        event =>
          event.name === 'ReserveUpdated' && String(event.args['entity'] || '').toLowerCase() === normalizedEntityId,
      );
      if (!reserveUpdated) {
        const eventNames = receipt.events.map(event => event.name).join(',') || 'none';
        throw new Error(
          `externalTokenToReserve missing ReserveUpdated for ${normalizedEntityId.slice(-8)} (events=${eventNames})`,
        );
      }

      console.log(`[JAdapter:rpc] Deposited ${amount} tokens to entity ${entityId.slice(0, 16)}...`);
      return receipt.events;
    },

    ...createRpcWalletWriteMethods({
      provider,
      signerForPrivateKey,
      buildFeeOverrides,
      waitForReceipt,
      asRpcTxResponse,
      runSerializedBatchFor,
      sendSignerTxWithExplicitNonce,
    }),

    // === High-level J-tx submission ===
    async submitTx(
      jTx: JTx,
      options: { env: RuntimeState; signerId?: string; signerPrivateKey?: Uint8Array; timestamp?: number },
    ): Promise<JSubmitResult> {
      const { env, signerId, signerPrivateKey, timestamp } = options;

      if (jTx.type === 'batch') {
        try {
          assertSealedJBatchBinding(jTx, {
            chainId: config.chainId,
            depositoryAddress: addresses.depository,
          });
        } catch (error) {
          return makeJAdapterFailureResult(error);
        }
      }

      console.log(`📤 [JAdapter:rpc] submitTx type=${jTx.type} entity=${jTx.entityId.slice(-4)}`);

      if (jTx.type === 'debtEnforcement') {
        const entityId = String(jTx.entityId || '').toLowerCase();
        const tokenId = Number(jTx.data.tokenId);
        const maxIterations = BigInt(jTx.data.maxIterations);
        if (!entityId || !Number.isInteger(tokenId) || tokenId < 0 || maxIterations <= 0n) {
          return { success: false, error: 'Invalid debt enforcement payload' };
        }
        try {
          await adapter.enforceDebts(entityId, tokenId, maxIterations);
          console.log(`✅ [JAdapter:rpc] Debt enforcement submitted token=${tokenId} entity=${entityId.slice(-4)}`);
          return { success: true };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          rpcLog.error('debt_enforcement.failed', { entityId, tokenId, error: msg });
          return makeJAdapterFailureResult(error);
        }
      }

      if (
        jTx.type === 'entityProviderTransfer' ||
        jTx.type === 'entityProviderReleaseControlShares' ||
        jTx.type === 'entityProviderCancelAction'
      ) {
        const intent = jTx.data.intent;
        if (!jTx.data.hankoSignature) {
          return {
            success: false,
            error: `ENTITY_PROVIDER_ACTION_CONSENSUS_HANKO_MISSING:${normalizeEntityId(jTx.entityId)}`,
          };
        }
        try {
          if (watchOnly && !signerPrivateKey) {
            throw new Error('JADAPTER_WATCH_ONLY_SIGNER_REQUIRED:entityProviderAction');
          }
          const actionSigner =
            watchOnly && signerPrivateKey
              ? await signerForPrivateKey(`0x${Buffer.from(signerPrivateKey).toString('hex')}`)
              : signer;
          const submittingEntityProvider = entityProvider.connect(
            actionSigner as unknown as Parameters<typeof entityProvider.connect>[0],
          );
          assertEntityProviderActionJTxBinding(jTx, {
            chainId: config.chainId,
            entityProviderAddress: await getLiveEntityProviderAddress(),
            depositoryAddress: await getLiveDepositoryAddress(),
          });
          return await runSerializedBatch(async (): Promise<JSubmitResult> => {
            const chainNonce = await entityProvider.entityActionNonces(intent.entityId);
            if (chainNonce >= intent.actionNonce) {
              const exactReceipt = await readEntityProviderActionReceipt(intent.entityId, intent.actionNonce);
              if (!exactReceipt) {
                throw new Error(
                  `ENTITY_PROVIDER_ACTION_NONCE_CONSUMED_WITHOUT_RECEIPT:` +
                    `${intent.entityId}:${intent.actionNonce.toString()}:${chainNonce.toString()}`,
                );
              }
              assertEntityProviderActionResolutionReceipt(intent, exactReceipt);
              return {
                success: true,
                txHash: exactReceipt.transactionHash,
                blockNumber: exactReceipt.blockNumber,
                events: [exactReceipt],
              };
            }
            if (chainNonce + 1n !== intent.actionNonce) {
              throw new Error(
                `ENTITY_PROVIDER_ACTION_CHAIN_NONCE_MISMATCH:` +
                  `${intent.actionNonce.toString()}:${(chainNonce + 1n).toString()}`,
              );
            }

            const args: unknown[] =
              intent.payload.kind === 'entityTransferTokens'
                ? [
                    intent.entityNumber,
                    intent.payload.transfer.to,
                    intent.payload.transfer.tokenId,
                    intent.payload.transfer.amount,
                    jTx.data.hankoSignature,
                  ]
                : intent.payload.kind === 'releaseControlShares'
                  ? [
                      intent.entityNumber,
                      intent.payload.release.depositoryAddress,
                      intent.payload.release.controlAmount,
                      intent.payload.release.dividendAmount,
                      intent.payload.release.purpose,
                      jTx.data.hankoSignature,
                    ]
                  : [
                      intent.entityNumber,
                      intent.payload.cancel.cancelledActionHash,
                      intent.payload.cancel.cancelledActionKind,
                      jTx.data.hankoSignature,
                    ];
            const method = (intent.payload.kind === 'entityTransferTokens'
              ? submittingEntityProvider.entityTransferTokens
              : intent.payload.kind === 'releaseControlShares'
                ? submittingEntityProvider.releaseControlShares
                : submittingEntityProvider.cancelEntityProviderAction) as unknown as UntypedActionMethod;
            try {
              await method.staticCall(...args);
            } catch (error) {
              const classified = classifyJAdapterFailure(error);
              return makeJAdapterFailureResult(error, {
                category: classified.category === 'transient' ? 'transient' : 'terminal',
                code: classified.code,
                message: `EntityProvider action staticCall failed: ${classified.message}`,
              });
            }
            const gasLimit = await estimateGasWithHeadroom(() => method.estimateGas(...args), 1_500_000n);
            const receipt = await sendSignerTxWithExplicitNonce(
              actionSigner,
              `EntityProvider.${intent.payload.kind}`,
              (nonce, feeOverrides) => method(...args, { gasLimit, nonce, ...feeOverrides }),
            );
            const events = parseReceiptLogsToJEvents(receipt, eventCarriers(depository, entityProvider));
            const exact = events.filter(
              event => event.name === 'EntityProviderActionExecuted' || event.name === 'EntityProviderActionCancelled',
            );
            if (exact.length !== 1) {
              throw new Error(`ENTITY_PROVIDER_ACTION_RECEIPT_COUNT_INVALID:${exact.length}`);
            }
            const action = exact[0]!;
            assertEntityProviderActionResolutionReceipt(intent, action);
            return {
              success: true,
              txHash: receipt.hash,
              blockNumber: receipt.blockNumber,
              events,
            };
          });
        } catch (error) {
          return makeJAdapterFailureResult(error);
        }
      }

      if (jTx.type === 'batch') {
        const batchData = jTx.data;
        const batch = batchData.batch;
        const effectiveTimestamp = typeof timestamp === 'number' ? timestamp : env.timestamp;

        if (isBatchEmpty(batch)) {
          console.log(`📦 [JAdapter:rpc] Empty batch, skipping`);
          return { success: true };
        }

        const normalizedId = normalizeEntityId(jTx.entityId);
        const preflightIssues = preflightBatchForE2(normalizedId, batch, Math.floor(Number(effectiveTimestamp) / 1000));
        if (preflightIssues.length > 0) {
          console.warn(
            `⚠️ [JAdapter:rpc] batch preflight issues (${normalizedId.slice(-4)}): ${preflightIssues.join(' | ')}`,
          );
        }

        // Validate bilateral settlement signatures before submission.
        for (const settlement of batch.settlements) {
          if (settlement.diffs.length > 0 && settlement.sig === '0x') {
            return { success: false, error: `Settlement missing hanko sig` };
          }
        }

        return runSerializedBatch(async () => {
          const depositoryAddr = await getLiveDepositoryAddress();
          const batchRequiresExternalSubmitter = batch.externalTokenToReserve.length > 0;
          const expectedExternalSignerId = batchRequiresExternalSubmitter
            ? resolveEntityProposerId(env, normalizedId, 'jadapter.rpc.submitTx.external-batch')
            : '';
          const effectiveExternalSignerId = batchRequiresExternalSubmitter
            ? String(signerId || batchData.signerId || '').trim()
            : '';
          if (batchRequiresExternalSubmitter && !effectiveExternalSignerId) {
            return {
              success: false,
              error: `EXTERNAL_BATCH_SIGNER_MISSING:${normalizedId}`,
            };
          }
          if (
            batchRequiresExternalSubmitter &&
            expectedExternalSignerId.toLowerCase() !== effectiveExternalSignerId.toLowerCase()
          ) {
            return {
              success: false,
              error:
                `EXTERNAL_BATCH_SIGNER_MISMATCH:${normalizedId}` +
                `:expected=${expectedExternalSignerId}` +
                `:got=${effectiveExternalSignerId}`,
            };
          }
          if (watchOnly && !signerPrivateKey) {
            throw new Error(`JADAPTER_WATCH_ONLY_SIGNER_REQUIRED:batch:${normalizedId}`);
          }
          const submitterWallet =
            signerPrivateKey && (watchOnly || batchRequiresExternalSubmitter)
              ? await signerForPrivateKey(`0x${Buffer.from(signerPrivateKey).toString('hex')}`)
              : null;
          if (batchRequiresExternalSubmitter) {
            if (!submitterWallet) {
              throw new Error(
                `Missing signer private key for externalTokenToReserve batch from ${jTx.entityId.slice(-4)}`,
              );
            }
            const walletAddress = await submitterWallet.getAddress();
            if (walletAddress.toLowerCase() !== expectedExternalSignerId.toLowerCase()) {
              throw new Error(
                `EXTERNAL_BATCH_EOA_MISMATCH:${normalizedId}:expected=${expectedExternalSignerId}:wallet=${walletAddress}`,
              );
            }
          }
          const submitterDepository = submitterWallet
            ? depository.connect(submitterWallet as unknown as Parameters<typeof depository.connect>[0])
            : depository;
          // Consensus batches must arrive fully sealed by entity consensus.
          // Do not fall back to reading the live chain nonce and locally signing here:
          // this submit path runs after an R-frame is already durable, so a local-sign
          // fallback can desync side effects from the committed entity frame.
          let encodedBatch: string;
          let hankoData: string;
          let nextNonce: bigint;

          if (batchData.hankoSignature && batchData.encodedBatch && typeof batchData.entityNonce === 'number') {
            // Entity consensus already signed — use pre-provided hanko
            encodedBatch = batchData.encodedBatch;
            hankoData = batchData.hankoSignature;
            nextNonce = BigInt(batchData.entityNonce);
            console.log(`🔐 [JAdapter:rpc] Using consensus hanko: nonce=${nextNonce}`);
          } else {
            const missing = [
              batchData.hankoSignature ? '' : 'hankoSignature',
              batchData.encodedBatch ? '' : 'encodedBatch',
              typeof batchData.entityNonce === 'number' ? '' : 'entityNonce',
            ]
              .filter(Boolean)
              .join(',');
            return {
              success: false,
              error: `J_BATCH_CONSENSUS_HANKO_MISSING:${normalizedId}:missing=${missing || 'unknown'}`,
            };
          }

          let disputeStartDebug: Array<Record<string, unknown>> = [];
          if (batch.disputeStarts.length > 0) {
            const { inspectHankoForHash } = await import('../hanko/signing');
            disputeStartDebug = await Promise.all(
              batch.disputeStarts.map(async start => {
                const accountKey = computeAccountKey(normalizedId, start.counterentity);
                const disputeHash = hashDisputeProofHankoPayload(
                  { chainId: config.chainId, depositoryAddress: depositoryAddr },
                  accountKey,
                  start.nonce,
                  start.proofbodyHash,
                  start.watchSeed,
                );
                const hankoDebug = await inspectHankoForHash(start.sig, disputeHash);
                const matchingClaim = hankoDebug.claims.find(
                  claim => String(claim.entityId).toLowerCase() === String(start.counterentity).toLowerCase(),
                );
                return {
                  contractGuard: 'EntityProvider.sol:469 require(entityId == boardHash)',
                  senderEntityId: normalizedId,
                  counterentity: start.counterentity,
                  nonce: start.nonce,
                  proofbodyHash: start.proofbodyHash,
                  starterInitialArgumentsBytes: Math.max(start.starterInitialArguments.length - 2, 0) / 2,
                  starterIncrementedArgumentsBytes: Math.max(start.starterIncrementedArguments.length - 2, 0) / 2,
                  disputeHash,
                  accountKey,
                  sigBytes: Math.max(start.sig.length - 2, 0) / 2,
                  recoveredAddresses: hankoDebug.recoveredAddresses,
                  matchingClaim: matchingClaim
                    ? {
                        entityId: matchingClaim.entityId,
                        threshold: matchingClaim.threshold,
                        entityIndexes: matchingClaim.entityIndexes,
                        weights: matchingClaim.weights,
                        boardEntityIds: matchingClaim.boardEntityIds,
                        reconstructedBoardHash: matchingClaim.reconstructedBoardHash,
                        entityMatchesBoardHash:
                          String(matchingClaim.entityId).toLowerCase() ===
                          String(matchingClaim.reconstructedBoardHash).toLowerCase(),
                      }
                    : null,
                };
              }),
            );
            console.log(`🧾 [JAdapter:rpc] disputeStart.batch ${safeStringify(disputeStartDebug)}`);
          }

          try {
            console.log(`📦 [JAdapter:rpc] processBatch (${getBatchSize(batch)} ops) nonce=${nextNonce}`);
            // ERC20 approvals are explicit user actions handled before batching.
            // submitTx must not mutate external allowances as a hidden side effect.
            const gasEstimate = await estimateProcessBatchGas(() =>
              submitterDepository.processBatch.estimateGas(encodedBatch, hankoData, nextNonce),
            );
            const gasLimit = resolveProcessBatchGasLimit(gasEstimate.gasLimit, batch.disputeFinalizations.length > 0);
            const resolvedFeeOverrides = await buildFeeOverrides();
            const requestedFeeOverrides = batchData.feeOverrides;
            if (requestedFeeOverrides?.maxFeePerGasWei) {
              resolvedFeeOverrides['maxFeePerGas'] = BigInt(requestedFeeOverrides.maxFeePerGasWei);
            }
            if (requestedFeeOverrides?.maxPriorityFeePerGasWei) {
              resolvedFeeOverrides['maxPriorityFeePerGas'] = BigInt(requestedFeeOverrides.maxPriorityFeePerGasWei);
            }
            if (requestedFeeOverrides?.gasBumpBps && requestedFeeOverrides.gasBumpBps > 0) {
              const bumpBps = BigInt(Math.floor(requestedFeeOverrides.gasBumpBps));
              const factor = 10_000n + bumpBps;
              if (resolvedFeeOverrides['maxFeePerGas']) {
                resolvedFeeOverrides['maxFeePerGas'] =
                  (resolvedFeeOverrides['maxFeePerGas'] * factor + 9_999n) / 10_000n;
              }
              if (resolvedFeeOverrides['maxPriorityFeePerGas']) {
                resolvedFeeOverrides['maxPriorityFeePerGas'] =
                  (resolvedFeeOverrides['maxPriorityFeePerGas'] * factor + 9_999n) / 10_000n;
              }
            }

            // Pre-flight: staticCall to decode revert reason before sending real tx
            try {
              await submitterDepository.processBatch.staticCall(encodedBatch, hankoData, nextNonce, {
                gasLimit,
              });
            } catch (simErr: unknown) {
              const simFailure = classifyJAdapterFailure(simErr);
              // Decode revert data using contract ABI (typechain-connected interface).
              const revertSource =
                typeof simErr === 'object' && simErr !== null
                  ? (simErr as {
                      data?: unknown;
                      error?: { data?: unknown };
                      info?: { error?: { data?: unknown } };
                      reason?: unknown;
                      message?: unknown;
                    })
                  : null;
              const revertData = revertSource?.data ?? revertSource?.error?.data ?? revertSource?.info?.error?.data;
              let errDetail = '';
              let localSnapshotRaceAfterGasEstimate = false;
              if (revertData && revertData !== '0x') {
                const sig = typeof revertData === 'string' ? revertData.slice(0, 10) : '';
                const payloadBytes =
                  typeof revertData === 'string' ? Math.max(0, Math.floor((revertData.length - 2) / 2)) : 0;
                let errName = `unknown(${sig})`;
                let decoded = '';
                if (typeof revertData === 'string' && sig !== '0x08c379a0' && sig !== '0x4e487b71') {
                  try {
                    const parsedError = depository.interface.parseError(revertData);
                    if (parsedError) {
                      const args = Array.from(parsedError.args ?? []);
                      const argStr = args.length > 0 ? ` args=${JSON.stringify(args.map(v => String(v)))}` : '';
                      errName = `${parsedError.name}()`;
                      decoded = argStr;
                    }
                  } catch (error) {
                    rpcLog.warn('revert.contract_error_decode_failed', {
                      selector: sig,
                      payloadBytes,
                      error: rpcErrorText(error),
                    });
                  }
                }
                if (typeof revertData === 'string') {
                  decoded = decodeStandardSolidityRevertData(revertData);
                }
                errDetail = `${errName}${decoded}`;
              } else {
                errDetail = String(revertSource?.reason ?? revertSource?.message ?? simErr);
                localSnapshotRaceAfterGasEstimate =
                  !gasEstimate.usedFallback && isLocalLatestStateStaticCallRace(simErr);
              }
              if (!localSnapshotRaceAfterGasEstimate && disputeStartDebug.length > 0) {
                errDetail += ` disputeStart=${safeStringify(disputeStartDebug)}`;
              }
              if (localSnapshotRaceAfterGasEstimate) {
                console.warn(
                  '⚠️ [JAdapter:rpc] processBatch preflight hit local dev-chain latest-state snapshot race ' +
                    'after successful gas estimate; continuing to submit the already-estimated batch',
                );
              } else {
                // Bail — do NOT submit a known-bad batch on-chain
                if (!revertData && simFailure.category === 'transient') {
                  return makeJAdapterFailureResult(simErr);
                }
                return makeJAdapterFailureResult(simErr, {
                  category: 'terminal',
                  code: simFailure.code === 'J_ADAPTER_TERMINAL' ? 'CALL_EXCEPTION' : simFailure.code,
                  message: `staticCall revert: ${errDetail}`,
                });
              }
            }

            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                if (attempt > 1) {
                  if (submitterWallet) {
                    await resetSerializedSignerNonceFor(submitterWallet);
                  } else {
                    await resetSerializedSignerNonce();
                  }
                  console.warn(`⚠️ [JAdapter:rpc] retrying processBatch after nonce sync (attempt ${attempt}/2)`);
                }
                const tx = submitterWallet
                  ? await submitterDepository.processBatch(encodedBatch, hankoData, nextNonce, {
                      gasLimit,
                      nonce: await allocateSerializedSignerNonceFor(submitterWallet),
                      ...resolvedFeeOverrides,
                    })
                  : await depository.processBatch(encodedBatch, hankoData, nextNonce, {
                      gasLimit,
                      nonce: await allocateSerializedSignerNonce(),
                      ...resolvedFeeOverrides,
                    });
                const minedReceipt = await waitForReceipt(tx, 'submitTx:processBatch');
                const txHash = minedReceipt.hash ?? tx.hash;
                const blockNum = minedReceipt.blockNumber ?? 0;
                const events = parseReceiptLogsToJEvents(
                  asRpcReceipt(minedReceipt),
                  eventCarriers(depository, entityProvider),
                );
                console.log(`✅ [JAdapter:rpc] Batch executed: block=${blockNum} gas=${minedReceipt.gasUsed}`);
                return { success: true, txHash, blockNumber: blockNum, events };
              } catch (error) {
                if (attempt < 2 && isNonceSyncError(error)) {
                  continue;
                }
                await resetSerializedSignerNonce();
                const msg = error instanceof Error ? error.message : String(error);
                rpcLog.error('process_batch.failed', {
                  entityId: normalizedId,
                  attempt,
                  error: msg,
                });
                return makeJAdapterFailureResult(error);
              }
            }
            return { success: false, error: 'processBatch failed after nonce retry' };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            rpcLog.error('process_batch.failed', { entityId: normalizedId, error: msg });
            return makeJAdapterFailureResult(error);
          }
        });
      }

      if (jTx.type === 'mint') {
        const entityId = String(jTx.data.entityId || jTx.entityId || '');
        const tokenId = Number(jTx.data.tokenId);
        const amount = jTx.data.amount;
        if (!entityId || !Number.isFinite(tokenId) || amount <= 0n) {
          return { success: false, error: 'Invalid mint payload' };
        }
        if (!DEV_CHAIN_IDS.has(config.chainId)) {
          console.warn(`⚠️ [JAdapter:rpc] Mint only allowed on configured dev chains`);
          return { success: false, error: 'Mint not supported on non-dev RPC chains' };
        }
        try {
          const events = await adapter.debugFundReserves(entityId, tokenId, amount);
          const blockNumber = events[events.length - 1]?.blockNumber;
          console.log(`✅ [JAdapter:rpc] Minted ${amount} token=${tokenId} to ${entityId.slice(-4)}`);
          return { success: true, events, ...(typeof blockNumber === 'number' ? { blockNumber } : {}) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          rpcLog.error('mint.failed', { entityId, tokenId, error: msg });
          return makeJAdapterFailureResult(error);
        }
      }

      const unhandledType: never = jTx;
      return { success: false, error: `Unknown JTx type: ${String(unhandledType)}` };
    },

    // === J-Watcher integration (RPC polling — uses shared event conversion from watcher.ts) ===
    startWatching(env: RuntimeState): void {
      if (!stackBindingVerified) {
        throw new Error(`J_STACK_BINDING_UNVERIFIED:rpc:chainId=${config.chainId}`);
      }
      if (watcherEnv) {
        rpcLog.debug('watcher.already_running', { chainId: config.chainId });
        return;
      }
      type ContractListenerSource = {
        removeAllListeners(): unknown;
      };
      // Canonical RPC polling below is the single long-lived J watcher path for this adapter.
      // Drop any ethers contract.on() listeners first so JsonRpcProvider does not keep its own
      // parallel polling loop alive beside the 1s watcher interval.
      (depository as unknown as ContractListenerSource | undefined)?.removeAllListeners?.();
      (entityProvider as unknown as ContractListenerSource | undefined)?.removeAllListeners?.();
      watcherStopping = false;
      watcherEnv = env;
      consecutiveTransientWatcherFailures = 0;
      lastTransientWatcherLogAt = 0;
      txCounter.value = 0;
      txCounter._seenLogs = { set: new Set<string>(), order: [] as string[] };
      const pendingWatcherJBlocks: PendingWatcherJBlockMap = new Map();
      let pendingWatcherJHistoryRange: PendingWatcherJHistoryRange | null = null;
      let lastPendingHistoryWaitKey = '';
      let reorgRewindPendingReplicaKeys: string[] = [];
      let lastAuthorityHeaderAuditKey = '';
      let lastObservedHead = -1;
      let lastCanonicalAuditAtMs = 0;
      const watchPollMs = BLOCKCHAIN.J_WATCHER_POLL_INTERVAL_MS;
      const manualPolling = env.scenarioMode === true;
      const confirmationDepth = resolveFinalityDepth(!!env?.scenarioMode);
      const startBlock = getWatcherStartBlock(env, addresses.depository, config.chainId);
      lastSyncedBlock = Math.max(0, startBlock - 1);
      watcherScanProgress = { scannedThroughHeight: 0, replicaScannedThrough: {} };
      rpcLog.info('watcher.start', {
        chainId: config.chainId,
        pollMs: watchPollMs,
        depth: confirmationDepth,
        fromBlock: startBlock,
      });

      const entityProviderIface = EntityProvider__factory.createInterface();
      const erc20WatchIface = new ethers.Interface([
        'event Transfer(address indexed from, address indexed to, uint256 value)',
        'event Approval(address indexed owner, address indexed spender, uint256 value)',
      ]);
      let erc20WatchTokensCache: Array<{ tokenId: number; address: string }> = [];
      let erc20WatchTokensLoadedAt = 0;
      const normalizeEvmAddress = (value: unknown): string => {
        const candidate = String(value || '')
          .trim()
          .toLowerCase();
        return /^0x[0-9a-f]{40}$/.test(candidate) ? candidate : '';
      };
      const readWatchedErc20Tokens = async (): Promise<Array<{ tokenId: number; address: string }>> => {
        const now = Date.now();
        if (erc20WatchTokensCache.length > 0 && now - erc20WatchTokensLoadedAt < 10_000) {
          return erc20WatchTokensCache;
        }
        const tokens: Array<{ tokenId: number; address: string }> = [];
        try {
          const length = Number(await depository.getTokensLength());
          for (let tokenId = 1; tokenId < length; tokenId++) {
            const [contractAddress] = await depository._tokens(tokenId);
            const normalized = normalizeEvmAddress(contractAddress);
            if (!normalized || normalized === ethers.ZeroAddress) continue;
            tokens.push({ tokenId, address: normalized });
          }
        } catch (error) {
          emitWatcherDebug({
            event: 'j_watch_erc20_registry_read_failed',
            error: watcherErrorDetails(error),
          });
          // The token set defines which log addresses belong to the canonical
          // observation. Advancing the cursor with a stale/empty registry can
          // permanently omit a newly registered token's Transfer/Approval.
          // Abort this poll so the same block range is retried after RPC heals.
          throw new Error(
            `J_WATCH_ERC20_REGISTRY_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
          );
        }
        erc20WatchTokensCache = tokens;
        erc20WatchTokensLoadedAt = now;
        return erc20WatchTokensCache;
      };
      const buildTrackedExternalOwners = (activeEnv: RuntimeState): Map<string, ExternalWalletTrackedOwnerCursor[]> => {
        const owners = new Map<string, Map<string, ExternalWalletTrackedOwnerCursor>>();
        const readBlock = (value: unknown): number => {
          const numeric = Number(value || 0);
          return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
        };
        const getTracked = (owner: string, entityId: string): ExternalWalletTrackedOwnerCursor | null => {
          const normalizedOwner = normalizeEvmAddress(owner);
          const normalizedEntity = String(entityId || '')
            .trim()
            .toLowerCase();
          if (!normalizedOwner || !normalizedEntity) return null;
          let byEntity = owners.get(normalizedOwner);
          if (!byEntity) {
            byEntity = new Map();
            owners.set(normalizedOwner, byEntity);
          }
          let tracked = byEntity.get(normalizedEntity);
          if (!tracked) {
            tracked = {
              entityId: normalizedEntity,
              watchAfterBlock: 0,
              balanceAfterBlockByToken: new Map(),
              allowanceAfterBlockByKey: new Map(),
            };
            byEntity.set(normalizedEntity, tracked);
          }
          return tracked;
        };
        for (const replica of activeEnv.eReplicas?.values?.() || []) {
          const entityId = String(replica.state?.entityId || replica.entityId || '')
            .trim()
            .toLowerCase();
          const externalWallet = replica.state?.externalWallet;
          if (!entityId || !externalWallet) continue;
          for (const [owner, balances] of externalWallet.balances?.entries?.() || []) {
            const tracked = getTracked(owner, entityId);
            if (!tracked) continue;
            for (const [tokenAddress, record] of balances.entries()) {
              const normalizedToken = normalizeEvmAddress(tokenAddress);
              if (!normalizedToken) continue;
              tracked.balanceAfterBlockByToken.set(
                normalizedToken,
                Math.max(tracked.balanceAfterBlockByToken.get(normalizedToken) ?? 0, readBlock(record.jHeight)),
              );
            }
          }
          for (const [owner, allowances] of externalWallet.allowances?.entries?.() || []) {
            const tracked = getTracked(owner, entityId);
            if (!tracked) continue;
            for (const [allowanceKey, record] of allowances.entries()) {
              const [tokenAddress, spender] = String(allowanceKey || '').split(':');
              const normalizedToken = normalizeEvmAddress(tokenAddress);
              const normalizedSpender = normalizeEvmAddress(spender);
              if (!normalizedToken || !normalizedSpender) continue;
              const key = `${normalizedToken}:${normalizedSpender}`;
              tracked.allowanceAfterBlockByKey.set(
                key,
                Math.max(tracked.allowanceAfterBlockByKey.get(key) ?? 0, readBlock(record.jHeight)),
              );
            }
          }
        }
        for (const [entityId, entityOwners] of activeEnv.runtimeState?.externalWalletWatchOwners?.entries?.() || []) {
          for (const [owner, afterBlock] of entityOwners) {
            const tracked = getTracked(owner, entityId);
            if (!tracked) continue;
            tracked.watchAfterBlock = Math.max(tracked.watchAfterBlock, readBlock(afterBlock));
          }
        }
        return new Map(
          [...owners.entries()].map(([owner, entityBlocks]) => [
            owner,
            [...entityBlocks.values()].sort((left, right) => compareStableText(left.entityId, right.entityId)),
          ]),
        );
      };
      const txFinalizationEvidenceCache = new Map<string, Promise<TxFinalizationEvidence[]>>();
      const readTxFinalizationEvidence = async (txHash: string): Promise<TxFinalizationEvidence[]> => {
        const normalizedHash = String(txHash || '').toLowerCase();
        if (!normalizedHash || normalizedHash === '0x') {
          throw new Error('J_DISPUTE_FINALIZATION_TX_HASH_MISSING');
        }
        const cached = txFinalizationEvidenceCache.get(normalizedHash);
        if (cached) return await cached;
        const promise = (async (): Promise<TxFinalizationEvidence[]> => {
          const txProvider = provider as Provider & {
            getTransaction?: (hash: string) => Promise<{ data?: string } | null>;
          };
          if (typeof txProvider.getTransaction !== 'function') {
            throw new Error('J_DISPUTE_FINALIZATION_TX_LOOKUP_UNAVAILABLE');
          }
          const tx = await txProvider.getTransaction(txHash);
          const data = typeof tx?.data === 'string' ? tx.data : '';
          if (!data || data === '0x') {
            throw new Error(`J_DISPUTE_FINALIZATION_TX_CALLDATA_MISSING:${normalizedHash}`);
          }
          return decodeDisputeFinalizationEvidenceCalldata(data);
        })();
        txFinalizationEvidenceCache.set(normalizedHash, promise);
        if (txFinalizationEvidenceCache.size > 2_000) {
          const oldest = txFinalizationEvidenceCache.keys().next().value;
          if (oldest) txFinalizationEvidenceCache.delete(oldest);
        }
        try {
          return await promise;
        } catch (error) {
          // A transient RPC failure must be retryable on the next watcher poll;
          // retaining a rejected Promise would permanently poison this tx hash.
          if (txFinalizationEvidenceCache.get(normalizedHash) === promise) {
            txFinalizationEvidenceCache.delete(normalizedHash);
          }
          throw error;
        }
      };
      const findDisputeFinalizationEvidence = async (
        txHash: string,
        args: Record<string, unknown>,
      ): Promise<DisputeFinalizationEvidence | undefined> => {
        const candidates = await readTxFinalizationEvidence(txHash);
        if (candidates.length === 0) {
          throw new Error(`J_DISPUTE_FINALIZATION_EVIDENCE_EMPTY:${String(txHash).toLowerCase()}`);
        }
        const counterentity = String(args['counterentity'] ?? '').toLowerCase();
        const initialNonce = toFinalizationDecimal(args['initialNonce']);
        const initialProofbodyHash = String(args['initialProofbodyHash'] ?? '').toLowerCase();
        const matched = candidates.find(
          candidate =>
            candidate.counterentity.toLowerCase() === counterentity &&
            candidate.initialNonce === initialNonce &&
            candidate.initialProofbodyHash.toLowerCase() === initialProofbodyHash,
        );
        if (!matched) {
          throw new Error(`J_DISPUTE_FINALIZATION_EVIDENCE_NOT_FOUND:${String(txHash).toLowerCase()}`);
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

      const emitWatcherDebug = (payload: Record<string, unknown>) => {
        const p2p = watcherEnv?.runtimeState?.p2p;
        if (isDebugEventEmitter(p2p)) {
          p2p.sendDebugEvent({
            level: 'info',
            code: 'J_WATCH_RPC',
            ...payload,
          });
        }
      };
      const readCommittedWatcherCursor = (activeEnv: RuntimeState): number =>
        Math.max(0, getWatcherStartBlock(activeEnv, addresses.depository, config.chainId) - 1);
      const commitScannedWatcherCursor = (activeEnv: RuntimeState, candidateCursor: number): number => {
        const currentCursor = readCommittedWatcherCursor(activeEnv);
        const watcherReplica = findWatcherJurisdictionReplica(activeEnv, addresses.depository, config.chainId);
        if (!watcherReplica) {
          throw new Error(`J_WATCHER_JURISDICTION_NOT_FOUND:cursor:${config.chainId}:${addresses.depository}`);
        }
        // Empty authenticated tails are transient watcher progress, not
        // Runtime state. Persisting their raw scan tip creates heartbeat
        // R-frames and can make a restart skip evidence that no Entity has
        // certified. The durable cursor may advance only through the common
        // Entity-certified prefix; later empty blocks are safely rescanned.
        const certifiedCursor = getMinimumCommittedSignerJHeight(activeEnv, watcherReplica);
        const durableCandidate = certifiedCursor === null ? currentCursor : Math.min(candidateCursor, certifiedCursor);
        const resolvedCursor = resolveCommittedWatcherCursor(
          activeEnv,
          pendingWatcherJBlocks,
          durableCandidate,
          currentCursor,
        );
        if (resolvedCursor > currentCursor) {
          updateWatcherJurisdictionCursor(activeEnv, resolvedCursor, addresses.depository, config.chainId);
        }
        return resolvedCursor;
      };
      const reconcileWatcherCanonicalTip = async (activeEnv: RuntimeState): Promise<boolean> => {
        if (reorgRewindPendingReplicaKeys.length > 0) {
          const stillPending = reorgRewindPendingReplicaKeys.some(replicaKey => {
            const replica = activeEnv.eReplicas.get(replicaKey);
            if (!replica?.jHistory) return false;
            const certifiedAnchor = getEntityCertifiedJAnchor(replica.state);
            return !certifiedAnchor || replica.jHistory.scannedThroughHeight > certifiedAnchor.height;
          });
          if (stillPending) return true;
          reorgRewindPendingReplicaKeys = [];
        }
        if (lastSyncedBlock <= 0) return false;
        const watcherReplica = findWatcherJurisdictionReplica(activeEnv, addresses.depository, config.chainId);
        if (!watcherReplica) return false;
        const relevantReplicaEntries = [...activeEnv.eReplicas.entries()].filter(([, replica]) =>
          isEntityReplicaRelevantToWatcher(activeEnv, replica, watcherReplica),
        );
        const relevantReplicas = relevantReplicaEntries.map(([, replica]) => replica);
        if (relevantReplicas.length === 0) return false;

        const finalizedAnchors = new Map<number, string>();
        for (const replica of relevantReplicas) {
          const certifiedAnchor = getEntityCertifiedJAnchor(replica.state);
          if (!certifiedAnchor) continue;
          const existing = finalizedAnchors.get(certifiedAnchor.height);
          if (existing && existing !== certifiedAnchor.hash) {
            throw new Error(`J_HISTORY_FINALIZED_ANCHOR_DIVERGENCE:height=${certifiedAnchor.height}`);
          }
          finalizedAnchors.set(certifiedAnchor.height, certifiedAnchor.hash);
        }
        const localFrontiers = relevantReplicaEntries.flatMap(([replicaKey, replica]) => {
          if (!replica.jHistory) return [];
          const height = Number(replica.jHistory.scannedThroughHeight);
          const hash = getValidatorJExpectedBlockHash(replica.state, replica.jHistory, height);
          if (!hash) throw new Error(`J_HISTORY_LOCAL_TIP_UNKNOWN:${replicaKey}:${height}`);
          return [{ replicaKey, replica, height, hash }];
        });
        const auditHeights = [
          ...new Set([lastSyncedBlock, ...finalizedAnchors.keys(), ...localFrontiers.map(frontier => frontier.height)]),
        ].sort((left, right) => left - right);
        const canonicalHeaders = new Map(
          (await readBlockHeadersAtHeights(auditHeights)).map(header => [header.jHeight, header.jBlockHash] as const),
        );
        for (const [height, expectedAnchorHash] of finalizedAnchors) {
          const canonicalAnchorHash = canonicalHeaders.get(height);
          if (!canonicalAnchorHash) throw new Error(`J_HISTORY_HEADER_MISSING:height=${height}`);
          if (expectedAnchorHash !== canonicalAnchorHash) {
            const owners = relevantReplicas
              .filter(replica => getEntityCertifiedJAnchor(replica.state)?.height === height)
              .map(replica => {
                const entityId = String(replica.entityId || replica.state.entityId || '').slice(0, 10);
                const jurisdiction = replica.state.config.jurisdiction;
                return `${entityId}/${String(jurisdiction?.name || 'unnamed')}/${String(jurisdiction?.chainId ?? 'missing')}`;
              })
              .join(',');
            throw new Error(
              `J_HISTORY_FINALIZED_REORG:${height}` +
                `:chain=${config.chainId}` +
                `:owners=${owners || 'unknown'}` +
                `:expected=${expectedAnchorHash}:canonical=${canonicalAnchorHash}`,
            );
          }
        }

        const targetedRewinds = new Map<
          string,
          {
            height: number;
            canonicalHash: string;
            replicaKeys: string[];
          }
        >();
        for (const frontier of localFrontiers) {
          const canonicalHash = canonicalHeaders.get(frontier.height);
          if (!canonicalHash) throw new Error(`J_HISTORY_HEADER_MISSING:height=${frontier.height}`);
          if (frontier.hash === canonicalHash) continue;
          const certifiedAnchor = getEntityCertifiedJAnchor(frontier.replica.state);
          if (certifiedAnchor?.height === frontier.height) {
            throw new Error(
              `J_HISTORY_FINALIZED_REORG:${frontier.height}:chain=${config.chainId}` +
                `:expected=${certifiedAnchor.hash}:canonical=${canonicalHash}`,
            );
          }
          const key = `${frontier.height}:${canonicalHash}`;
          const group = targetedRewinds.get(key) ?? {
            height: frontier.height,
            canonicalHash,
            replicaKeys: [],
          };
          group.replicaKeys.push(frontier.replicaKey);
          targetedRewinds.set(key, group);
        }
        if (targetedRewinds.size > 0) {
          const rewoundReplicaKeys = new Set<string>();
          for (const group of targetedRewinds.values()) {
            for (const replicaKey of enqueueJHistoryRewindForReplicaKeys(
              activeEnv,
              group.height,
              group.canonicalHash,
              group.replicaKeys,
              addresses.depository,
              config.chainId,
            ))
              rewoundReplicaKeys.add(replicaKey);
          }
          reorgRewindPendingReplicaKeys = [...rewoundReplicaKeys].sort();
          for (const [height, replicaKeys] of pendingWatcherJBlocks) {
            for (const replicaKey of rewoundReplicaKeys) replicaKeys.delete(replicaKey);
            if (replicaKeys.size === 0) pendingWatcherJBlocks.delete(height);
          }
          txCounter._seenLogs = { set: new Set<string>(), order: [] };
          emitWatcherDebug({
            event: 'j_watch_local_frontier_rewind_enqueued',
            replicaCount: reorgRewindPendingReplicaKeys.length,
            frontiers: [...targetedRewinds.values()].map(group => ({
              height: group.height,
              canonicalBlockHash: group.canonicalHash,
              replicaCount: group.replicaKeys.length,
            })),
          });
          return true;
        }

        const expectedTipHashes = new Set(
          relevantReplicas
            .map(replica => getValidatorJExpectedBlockHash(replica.state, replica.jHistory, lastSyncedBlock))
            .filter((hash): hash is string => Boolean(hash)),
        );
        if (expectedTipHashes.size === 0) return false;
        if (expectedTipHashes.size !== 1) {
          throw new Error(`J_HISTORY_LOCAL_TIP_DIVERGENCE:height=${lastSyncedBlock}`);
        }
        const canonicalTipHash = canonicalHeaders.get(lastSyncedBlock);
        if (!canonicalTipHash) throw new Error(`J_HISTORY_HEADER_MISSING:height=${lastSyncedBlock}`);
        const expectedTipHash = [...expectedTipHashes][0]!;
        if (canonicalTipHash === expectedTipHash) return false;
        const mismatchingReplicaKeys = relevantReplicaEntries.flatMap(([replicaKey, replica]) =>
          getValidatorJExpectedBlockHash(replica.state, replica.jHistory, lastSyncedBlock) === expectedTipHash
            ? [replicaKey]
            : [],
        );
        if (mismatchingReplicaKeys.length === 0) {
          throw new Error(`J_HISTORY_REORG_WITHOUT_REWINDABLE_SUFFIX:${lastSyncedBlock}`);
        }
        reorgRewindPendingReplicaKeys = enqueueJHistoryRewindForReplicaKeys(
          activeEnv,
          lastSyncedBlock,
          canonicalTipHash,
          mismatchingReplicaKeys,
          addresses.depository,
          config.chainId,
        );
        if (reorgRewindPendingReplicaKeys.length === 0) {
          throw new Error(`J_HISTORY_REORG_WITHOUT_REWINDABLE_SUFFIX:${lastSyncedBlock}`);
        }
        pendingWatcherJBlocks.clear();
        txCounter._seenLogs = { set: new Set<string>(), order: [] };
        lastSyncedBlock = Math.max(
          0,
          Math.min(...relevantReplicas.map(replica => Number(replica.state.lastFinalizedJHeight || 0))),
        );
        emitWatcherDebug({
          event: 'j_watch_reorg_rewind_enqueued',
          conflictingHeight: lastSyncedBlock,
          expectedBlockHash: expectedTipHash,
          canonicalBlockHash: canonicalTipHash,
          rewindToHeight: lastSyncedBlock,
          replicaCount: reorgRewindPendingReplicaKeys.length,
        });
        return true;
      };
      const assertAuthorityEvidenceCanonical = async (activeEnv: RuntimeState, currentHead: number): Promise<void> => {
        const stackKey = getCertifiedBoardStackKey({
          chainId: config.chainId,
          depositoryAddress: addresses.depository,
          entityProviderAddress: addresses.entityProvider,
        });
        const evidence = Array.from(activeEnv.runtimeState?.certifiedRegistrationEvidence?.values() ?? []).filter(
          candidate => candidate.stackKey === stackKey,
        );
        const currentHeader = (await readBlockHeadersAtHeights([currentHead]))[0];
        if (!currentHeader) throw new Error(`J_AUTHORITY_HEAD_HEADER_MISSING:${currentHead}`);
        const auditKey = `${currentHead}:${currentHeader.jBlockHash}:${evidence.length}`;
        if (lastAuthorityHeaderAuditKey === auditKey) return;
        if (evidence.length === 0) {
          lastAuthorityHeaderAuditKey = auditKey;
          return;
        }
        const heights = evidence.flatMap(candidate => [candidate.activationHeight, candidate.observedThroughHeight]);
        const canonicalHeaders = new Map(
          (await readBlockHeadersAtHeights(heights)).map(header => [header.jHeight, header.jBlockHash]),
        );
        for (const candidate of evidence) {
          const activationHash = canonicalHeaders.get(candidate.activationHeight);
          if (activationHash !== candidate.blockHash) {
            throw new Error(
              `J_AUTHORITY_FINALIZED_REORG:entity=${candidate.entityId}:height=${candidate.activationHeight}:` +
                `expected=${candidate.blockHash}:canonical=${activationHash ?? 'missing'}`,
            );
          }
          const tipHash = canonicalHeaders.get(candidate.observedThroughHeight);
          if (tipHash !== candidate.observedTipBlockHash) {
            throw new Error(
              `J_AUTHORITY_FINALITY_TIP_REORG:entity=${candidate.entityId}:` +
                `height=${candidate.observedThroughHeight}:expected=${candidate.observedTipBlockHash}:` +
                `canonical=${tipHash ?? 'missing'}`,
            );
          }
        }
        lastAuthorityHeaderAuditKey = auditKey;
      };
      const isJEventIngressPaused = (activeEnv: RuntimeState): boolean =>
        !!activeEnv.runtimeState?.persistenceQuiescing && !activeEnv.scenarioMode;
      const pauseJEventWatcherForQuiesce = (details: Record<string, unknown>): void => {
        emitWatcherDebug({
          event: 'j_watch_paused_persistence_quiescing',
          lastSyncedBlock,
          ...details,
        });
      };
      if (watcherFatalError) {
        emitWatcherDebug({
          event: 'j_watch_fatal_already_halted',
          message: watcherFatalError,
          lastSyncedBlock,
        });
        rpcLog.error('watcher.already_halted', { error: watcherFatalError });
        return;
      }
      const doPoll = (): Promise<void> => {
        if (!watcherEnv) return Promise.resolve();
        if (pollInFlight) return pollInFlight;
        let pollStep = 'start';
        let pollFromBlock: number | null = null;
        let pollToBlock: number | null = null;
        pollInFlight = (async () => {
          const activeEnv = watcherEnv;
          const pollGeneration = watcherGeneration;
          const watcherPollCancelled = (): boolean =>
            watcherStopping || watcherEnv !== activeEnv || watcherGeneration !== pollGeneration;
          if (!activeEnv || watcherPollCancelled()) return;
          if (isJEventIngressPaused(activeEnv)) {
            pauseJEventWatcherForQuiesce({ step: 'before-block-number' });
            return;
          }
          pollStep = 'eth_blockNumber';
          const currentBlock = await readCurrentRpcBlockNumber();
          if (watcherPollCancelled()) return;
          // Ethereum finality is expressed by confirmationDepth below, so its
          // current and safe watcher heads have the same RPC source. Reuse the
          // authenticated read above instead of polling eth_blockNumber twice.
          // TRON is different: only SolidityNode exposes the solidified head.
          const safeHead = isTronChainId(config.chainId) ? await readSafeWatcherBlockNumber() : currentBlock;
          const safeToBlock = safeHead - confirmationDepth;
          if (safeToBlock <= 0) return;
          const watcherReplica = findWatcherJurisdictionReplica(activeEnv, addresses.depository, config.chainId);
          if (!watcherReplica) {
            throw new Error(`J_WATCHER_JURISDICTION_NOT_FOUND:poll:${config.chainId}:${addresses.depository}`);
          }
          const minimumLocalScan = getMinimumScannedSignerJHeight(activeEnv, watcherReplica);
          const nextGlobalBlock = lastSyncedBlock + 1;
          const nextReplicaCatchUpBlock = minimumLocalScan === null ? nextGlobalBlock : minimumLocalScan + 1;
          const fromBlock = Math.min(nextGlobalBlock, nextReplicaCatchUpBlock);
          const nowMs = Date.now();
          const canonicalAuditDue = shouldAuditCanonicalWatcherState({
            currentHead: currentBlock,
            lastObservedHead,
            nowMs,
            lastAuditAtMs: lastCanonicalAuditAtMs,
            hasRangeWork: fromBlock <= safeToBlock,
            hasPendingHistory: pendingWatcherJHistoryRange !== null,
            hasPendingReorg: reorgRewindPendingReplicaKeys.length > 0,
          });
          lastObservedHead = currentBlock;
          if (canonicalAuditDue) {
            pollStep = `verifyAuthorityEvidence:${currentBlock}`;
            await assertAuthorityEvidenceCanonical(activeEnv, currentBlock);
            pollStep = `verifyCanonicalTip:${lastSyncedBlock}`;
            if (await reconcileWatcherCanonicalTip(activeEnv)) {
              pendingWatcherJHistoryRange = null;
              watcherScanProgress = { scannedThroughHeight: 0, replicaScannedThrough: {} };
              lastCanonicalAuditAtMs = nowMs;
              return;
            }
            lastCanonicalAuditAtMs = nowMs;
          }
          if (pendingWatcherJHistoryRange) {
            if (!isWatcherJHistoryRangeDurable(activeEnv, pendingWatcherJHistoryRange)) {
              const waitKey = `${pendingWatcherJHistoryRange.fromBlock}:${pendingWatcherJHistoryRange.toBlock}`;
              if (lastPendingHistoryWaitKey !== waitKey) {
                lastPendingHistoryWaitKey = waitKey;
                rpcLog.info('watcher.waiting_for_durable_history_range', {
                  chainId: config.chainId,
                  fromBlock: pendingWatcherJHistoryRange.fromBlock,
                  toBlock: pendingWatcherJHistoryRange.toBlock,
                  replicas: [...pendingWatcherJHistoryRange.replicaKeys],
                });
              }
              return;
            }
            pendingWatcherJHistoryRange = null;
            lastPendingHistoryWaitKey = '';
          }
          // Multi-signer replicas can finalize a previously scanned range
          // before this poll begins. In that case there is no local-history
          // write left to await, but the Runtime-level watcher cursor still
          // needs its own durable RuntimeTx. Restricting this commit to the
          // pending-range branch leaves the cursor permanently one block
          // behind and turns a fully idle watcher into a false drain stall.
          commitScannedWatcherCursor(activeEnv, lastSyncedBlock);
          // A replica imported after the watcher reached the tip has no local
          // authenticated history yet. The global cursor must not hide that
          // per-replica gap: rescan from the earliest local cursor while keeping
          // lastSyncedBlock monotonic. Exact duplicate ranges reconcile as no-ops.
          if (fromBlock > safeToBlock) return;

          const toBlock = resolveWatcherPollToBlock(fromBlock, safeToBlock);
          pollFromBlock = fromBlock;
          pollToBlock = toBlock;
          const parentHeight = fromBlock - 1;
          const relevantReplicas = [...activeEnv.eReplicas.values()].filter(replica =>
            isEntityReplicaRelevantToWatcher(activeEnv, replica, watcherReplica),
          );
          const expectedParentHashes =
            parentHeight > 0
              ? new Set(
                  relevantReplicas
                    .map(replica => getValidatorJExpectedBlockHash(replica.state, replica.jHistory, parentHeight))
                    .filter((hash): hash is string => Boolean(hash)),
                )
              : new Set<string>();
          if (expectedParentHashes.size > 1) {
            throw new Error(`J_HISTORY_RANGE_PARENT_DIVERGENCE:height=${parentHeight}`);
          }
          const expectedParentHash = [...expectedParentHashes][0];
          const expectedParentFinalized =
            expectedParentHash !== undefined &&
            relevantReplicas.some(replica => {
              const certifiedAnchor = getEntityCertifiedJAnchor(replica.state);
              return certifiedAnchor?.height === parentHeight && certifiedAnchor.hash === expectedParentHash;
            });
          // Commit the watcher cursor only after a successful poll+apply.
          // Advancing it before getLogs()/event processing can persist a speculative
          // blockNumber into WAL snapshots and permanently skip finalized J events.
          pollStep = 'resolveDepository';
          const liveDepositoryAddress = (await getLiveDepositoryAddress()).toLowerCase();
          pollStep = 'resolveEntityProvider';
          const liveEntityProviderAddress = (await getLiveEntityProviderAddress()).toLowerCase();
          pollStep = 'resolveErc20Registry';
          const watchedTokens = await readWatchedErc20Tokens();
          pollStep = 'authenticatedReceipts';
          const authenticatedRange = await readAuthenticatedReceiptRange(
            (method, params) => (provider as ethers.JsonRpcProvider).send(method, params),
            fromBlock,
            toBlock,
            [liveDepositoryAddress, liveEntityProviderAddress, ...watchedTokens.map(token => token.address)],
            {
              commitment: isTronChainId(config.chainId) ? 'tron-complete-receipts' : 'ethereum-trie',
            },
            sendAuthenticatedRpcBatch,
          );
          if (watcherPollCancelled()) return;
          const authenticatedIngress = prepareAuthenticatedWatcherIngress(
            authenticatedRange,
            expectedParentHash
              ? {
                  height: parentHeight,
                  hash: expectedParentHash,
                  finalized: expectedParentFinalized,
                }
              : undefined,
          );
          const headers = authenticatedIngress.headers;
          const authenticatedLogs = authenticatedIngress.logs;
          const rangeTipHash = authenticatedIngress.tipBlockHash;
          const tokenByAddress = new Map(watchedTokens.map(token => [token.address, token]));
          const logs = authenticatedLogs.map(log => ({
            kind:
              log.address.toLowerCase() === liveDepositoryAddress
                ? ('depository' as const)
                : log.address.toLowerCase() === liveEntityProviderAddress
                  ? ('entityProvider' as const)
                  : ('erc20' as const),
            log,
          }));

          if (logs.length > 0) {
            const rawEvents: JEventIngress[] = [];
            const authorityTxsByBlock = new Map<number, RuntimeTx[]>();
            const trackedExternalOwners = buildTrackedExternalOwners(activeEnv);
            for (const { kind, log } of logs) {
              try {
                const parsed =
                  kind === 'depository'
                    ? parseKnownDepositoryLog(log)
                    : kind === 'entityProvider'
                      ? entityProviderIface.parseLog({ topics: log.topics as string[], data: log.data })
                      : erc20WatchIface.parseLog({ topics: log.topics as string[], data: log.data });
                if (!parsed) {
                  throw new Error(
                    `unrecognized ${kind} log at block=${String(log.blockNumber)} index=${String(log.index)}`,
                  );
                }
                if (
                  kind === 'entityProvider' &&
                  (parsed.name === 'EntityRegistered' || parsed.name === 'FoundationBootstrapped')
                ) {
                  // Receipt/header authentication already happened against the
                  // fresh RPC range. From this boundary onward every consumer,
                  // including authority evidence, uses the same replay identity.
                  const evidence = buildCertifiedRegistrationEvidence(activeEnv, watcherReplica, parsed.name, log, {
                    observedThroughHeight: toBlock,
                    observedTipBlockHash: rangeTipHash,
                    observedHeadHeight: currentBlock,
                    confirmationDepth,
                  });
                  const tx = markLocalJAuthorityRuntimeTx({
                    type: 'recordAuthenticatedJAuthority',
                    data: evidence,
                  });
                  authorityTxsByBlock.set(log.blockNumber, [...(authorityTxsByBlock.get(log.blockNumber) ?? []), tx]);
                }
                if (kind === 'erc20') {
                  const tokenAddress = normalizeEvmAddress(log.address);
                  const token = tokenByAddress.get(tokenAddress);
                  if (!token) continue;
                  if (parsed.name === 'Transfer') {
                    const from = normalizeEvmAddress(parsed.args[0]);
                    const to = normalizeEvmAddress(parsed.args[1]);
                    if (from && to && from === to) continue;
                    const amount = BigInt(parsed.args[2] ?? 0n);
                    const deltas = [
                      ...(from && from !== ethers.ZeroAddress
                        ? [{ owner: from, balanceDelta: `-${amount.toString()}` }]
                        : []),
                      ...(to && to !== ethers.ZeroAddress ? [{ owner: to, balanceDelta: amount.toString() }] : []),
                    ];
                    for (const delta of deltas) {
                      for (const tracked of trackedExternalOwners.get(delta.owner) ?? []) {
                        if (
                          !shouldEmitExternalWalletBalanceDelta(tracked, tokenAddress, Number(log.blockNumber || 0))
                        ) {
                          continue;
                        }
                        rawEvents.push({
                          name: 'ExternalWalletDelta',
                          args: {
                            entityId: tracked.entityId,
                            owner: delta.owner,
                            tokenAddress,
                            tokenId: token.tokenId,
                            balanceDelta: delta.balanceDelta,
                          },
                          blockNumber: log.blockNumber,
                          blockHash: log.blockHash,
                          transactionHash: log.transactionHash,
                          logIndex: log.index,
                        });
                      }
                    }
                  } else if (parsed.name === 'Approval') {
                    const owner = normalizeEvmAddress(parsed.args[0]);
                    const spender = normalizeEvmAddress(parsed.args[1]);
                    const allowance = BigInt(parsed.args[2] ?? 0n).toString();
                    if (!owner || !spender) continue;
                    for (const tracked of trackedExternalOwners.get(owner) ?? []) {
                      if (
                        !shouldEmitExternalWalletAllowanceDelta(
                          tracked,
                          tokenAddress,
                          spender,
                          Number(log.blockNumber || 0),
                        )
                      ) {
                        continue;
                      }
                      rawEvents.push({
                        name: 'ExternalWalletDelta',
                        args: {
                          entityId: tracked.entityId,
                          owner,
                          tokenAddress,
                          tokenId: token.tokenId,
                          spender,
                          allowance,
                        },
                        blockNumber: log.blockNumber,
                        blockHash: log.blockHash,
                        transactionHash: log.transactionHash,
                        logIndex: log.index,
                      });
                    }
                  }
                  continue;
                }
                if (!CANONICAL_J_EVENTS.some(name => name === parsed.name)) continue;
                // Extract named args from ethers v6 Result (array-like, named keys
                // not enumerable via Object.keys). Use positional fallback for unnamed params.
                const args: Record<string, unknown> = kind === 'depository' ? extractCanonicalDepositoryEventArgs(parsed) : {};
                if (kind !== 'depository') {
                  for (let idx = 0; idx < parsed.fragment.inputs.length; idx++) {
                    const input = parsed.fragment.inputs[idx];
                    if (!input) continue;
                    const key = input.name || String(idx);
                    args[key] = parsed.args[idx]; // Use positional index (always works)
                    if (input.name) args[input.name] = parsed.args[idx];
                  }
                }
                const disputeFinalizationEvidence =
                  parsed.name === 'DisputeFinalized'
                    ? await findDisputeFinalizationEvidence(log.transactionHash, args)
                    : undefined;
                rawEvents.push({
                  name: parsed.name,
                  args,
                  blockNumber: log.blockNumber,
                  blockHash: log.blockHash,
                  transactionHash: log.transactionHash,
                  logIndex: log.index,
                  ...(disputeFinalizationEvidence ? { disputeFinalizationEvidence } : {}),
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(
                  `J_EVENT_LOG_DECODE_FAILED:block=${String(log.blockNumber)} ` +
                    `tx=${String(log.transactionHash || 'unknown')} index=${String(log.index)}: ${message}`,
                );
              }
            }

            if (watcherPollCancelled()) {
              emitWatcherDebug({
                event: 'j_watch_shutdown_poll_aborted',
                message: 'watcher cancellation observed before J-event ingress',
                chainId: config.chainId,
                rpcUrl: config.rpcUrl,
                step: 'before-process-event-batch',
                fromBlock,
                toBlock,
                lastSyncedBlock,
              });
              return;
            }
            const observedInputs: RuntimeInput[] = [];
            if (rawEvents.length > 0) {
              if (isJEventIngressPaused(activeEnv)) {
                pauseJEventWatcherForQuiesce({
                  step: 'before-process-event-batch',
                  fromBlock,
                  toBlock,
                  rawEventCount: rawEvents.length,
                });
                return;
              }
              const eventCounts: Record<string, number> = {};
              for (const e of rawEvents) {
                eventCounts[e.name] = (eventCounts[e.name] || 0) + 1;
              }

              const byBlock = new Map<number, JEventIngress[]>();
              for (const e of rawEvents) {
                const bn = e.blockNumber ?? 0;
                if (!byBlock.has(bn)) byBlock.set(bn, []);
                byBlock.get(bn)!.push(e);
              }
              for (const [blockNum, events] of byBlock) {
                const blockHash = events[0]?.blockHash ?? '0x0';
                pollStep = `processEventBatch:${blockNum}`;
                const builtInput = processEventBatch(
                  events,
                  activeEnv,
                  blockNum,
                  blockHash,
                  txCounter,
                  'rpc',
                  addresses.depository,
                  true,
                  'chain',
                  config.chainId,
                  fromBlock <= lastSyncedBlock,
                  authorityTxsByBlock.get(blockNum) ?? [],
                );
                if (builtInput) observedInputs.push(builtInput);
              }
              emitWatcherDebug({
                event: 'j_watch_batch',
                fromBlock,
                toBlock,
                chainTip: currentBlock,
                confirmationDepth,
                blockCount: byBlock.size,
                rawEventCount: rawEvents.length,
                eventCounts,
              });
            }
            // Authenticated receipts may contain valid watched-address logs
            // that are irrelevant to this Runtime (for example an ERC20
            // transfer between untracked owners). Those blocks still extend
            // every relevant validator's authenticated local J-prefix.
            if (watcherPollCancelled()) return;
            if (isJEventIngressPaused(activeEnv)) {
              pauseJEventWatcherForQuiesce({
                step: 'before-authenticated-history-range-ingress',
                fromBlock,
                toBlock,
              });
              return;
            }
            const rangeReplicaKeys = enqueueJHistoryRange(
              activeEnv,
              observedInputs,
              toBlock,
              rangeTipHash,
              addresses.depository,
              headers,
              config.chainId,
            );
            rememberPendingWatcherJBlock(pendingWatcherJBlocks, toBlock, rangeReplicaKeys.finalityReplicaKeys);
            if (rangeReplicaKeys.scannedReplicaKeys.length > 0) {
              if (pendingWatcherJHistoryRange) throw new Error('J_WATCHER_PENDING_SCAN_ALREADY_EXISTS');
              pendingWatcherJHistoryRange = {
                fromBlock,
                toBlock,
                tipBlockHash: rangeTipHash,
                replicaKeys: new Set(rangeReplicaKeys.scannedReplicaKeys),
              };
            }
            lastSyncedBlock = Math.max(lastSyncedBlock, toBlock);
            rememberWatcherScanProgress(activeEnv, watcherReplica, toBlock);
            consecutiveTransientWatcherFailures = 0;
            return;
          }

          if (watcherPollCancelled()) return;

          if (isJEventIngressPaused(activeEnv)) {
            pauseJEventWatcherForQuiesce({
              step: 'before-authenticated-empty-range-ingress',
              fromBlock,
              toBlock,
            });
            return;
          }

          // `readAuthenticatedLogsForRange` verifies complete receipts against
          // the canonical block commitment. An authenticated empty tail is final
          // evidence, not a best-effort eth_getLogs result, so advancing is safe.
          const rangeReplicaKeys = enqueueJHistoryRange(
            activeEnv,
            [],
            toBlock,
            rangeTipHash,
            addresses.depository,
            headers,
            config.chainId,
          );
          rememberPendingWatcherJBlock(pendingWatcherJBlocks, toBlock, rangeReplicaKeys.finalityReplicaKeys);
          if (rangeReplicaKeys.scannedReplicaKeys.length > 0) {
            if (pendingWatcherJHistoryRange) throw new Error('J_WATCHER_PENDING_SCAN_ALREADY_EXISTS');
            pendingWatcherJHistoryRange = {
              fromBlock,
              toBlock,
              tipBlockHash: rangeTipHash,
              replicaKeys: new Set(rangeReplicaKeys.scannedReplicaKeys),
            };
          }

          lastSyncedBlock = Math.max(lastSyncedBlock, toBlock);
          rememberWatcherScanProgress(activeEnv, watcherReplica, toBlock);
          consecutiveTransientWatcherFailures = 0;
        })()
          .catch((error: unknown) => {
            const message = watcherErrorMessage(error);
            if (watcherStopping) {
              emitWatcherDebug({
                event: 'j_watch_shutdown_poll_aborted',
                message,
                chainId: config.chainId,
                rpcUrl: config.rpcUrl,
                step: pollStep,
                fromBlock: pollFromBlock,
                toBlock: pollToBlock,
                lastSyncedBlock,
              });
              return;
            }
            if (isTransientRpcUnavailable(error)) {
              consecutiveTransientWatcherFailures += 1;
              const now = Date.now();
              if (consecutiveTransientWatcherFailures === 1 || now - lastTransientWatcherLogAt >= 10_000) {
                lastTransientWatcherLogAt = now;
                emitWatcherDebug({
                  event: 'j_watch_transient_rpc_unavailable',
                  message,
                  chainId: config.chainId,
                  rpcUrl: config.rpcUrl,
                  step: pollStep,
                  fromBlock: pollFromBlock,
                  toBlock: pollToBlock,
                  lastSyncedBlock,
                  consecutiveFailures: consecutiveTransientWatcherFailures,
                  error: watcherErrorDetails(error),
                });
                // A single null header immediately after eth_blockNumber is a
                // normal RPC read race. Keep the structured diagnostic, but only
                // raise operator-visible severity once the inconsistency persists.
                if (consecutiveTransientWatcherFailures >= 3) {
                  console.warn(
                    `[JAdapter:rpc] transient watcher RPC unavailable ` +
                      `(chain=${config.chainId}, failures=${consecutiveTransientWatcherFailures}): ${message}`,
                  );
                }
              }
              return;
            }
            const fatalPayload = {
              event: 'j_watch_error',
              message,
              chainId: config.chainId,
              rpcUrl: config.rpcUrl,
              step: pollStep,
              fromBlock: pollFromBlock,
              toBlock: pollToBlock,
              lastSyncedBlock,
              error: watcherErrorDetails(error),
            };
            emitWatcherDebug({
              ...fatalPayload,
            });
            watcherFatalError = message;
            if (watcherInterval) {
              clearInterval(watcherInterval);
            }
            watcherInterval = null;
            watcherEnv = null;
            pollNowHandler = null;
            emitWatcherDebug({
              event: 'j_watch_fatal_halt',
              message,
              chainId: config.chainId,
              rpcUrl: config.rpcUrl,
              step: pollStep,
              fromBlock: pollFromBlock,
              toBlock: pollToBlock,
              lastSyncedBlock,
            });
            rpcLog.error('watcher.fatal_exit', fatalPayload);
            haltProcessForFatalWatcherError(fatalPayload);
          })
          .finally(() => {
            pollInFlight = null;
          });
        return pollInFlight;
      };

      pollNowHandler = doPoll;
      if (!manualPolling) {
        watcherInterval = setInterval(() => {
          void doPoll();
        }, watchPollMs);
        void doPoll();
      }

      rpcLog.info('watcher.ready', {
        chainId: config.chainId,
        mode: manualPolling ? 'manual' : 'interval',
        pollMs: watchPollMs,
      });
    },

    async pollNow(): Promise<void> {
      const fn = pollNowHandler;
      if (fn) await fn();
    },

    isWatching(): boolean {
      return watcherEnv !== null;
    },

    stopWatching(): void {
      watcherStopping = true;
      watcherGeneration += 1;
      if (watcherInterval) {
        clearInterval(watcherInterval);
        watcherInterval = null;
      }
      watcherEnv = null;
      pollNowHandler = null;
      rpcLog.info('watcher.stopped', { chainId: config.chainId });
    },

    async stopWatchingAndWait(): Promise<void> {
      const inFlightWatcherPoll = pollInFlight;
      adapter.stopWatching();
      if (inFlightWatcherPoll) await inFlightWatcherPoll;
    },

    getBrowserVM(): BrowserVMProvider | null {
      return null;
    },

    setBlockTimestamp(_timestamp: number): void {
      // RPC mode follows chain timestamps from mined blocks; runtime logical time is separate.
    },

    setQuietLogs(quiet: boolean): void {
      quietLogs = quiet;
    },

    registerEntityWallet(_entityId: string, _privateKey: string): void {
      // no-op in RPC mode
    },

    async captureStateRoot(): Promise<Uint8Array | null> {
      return null;
    },

    async getCurrentBlockNumber(): Promise<number> {
      // Explicit watcher drains are finality barriers. JsonRpcProvider may
      // cache getBlockNumber() across a just-mined registration receipt, which
      // would let bootstrap stop one block before its authority evidence.
      return await readSafeWatcherBlockNumber();
    },

    getWatcherScanProgress() {
      return watcherScanProgress;
    },

    getFinalityDepth(): number {
      return resolveFinalityDepth(false);
    },

    async syncRuntimeState(): Promise<null> {
      return null;
    },

    close(): Promise<void> {
      closePromise ??= (async () => {
        await adapter.stopWatchingAndWait();
        depository?.removeAllListeners();
        entityProvider?.removeAllListeners();
        const lifecycleProvider = provider as Provider & {
          destroy?: () => void | Promise<void>;
        };
        if (typeof lifecycleProvider.destroy === 'function') {
          await lifecycleProvider.destroy();
        }
      })();
      return closePromise;
    },
  };

  // Watcher state
  let watcherInterval: ReturnType<typeof setInterval> | null = null;
  let watcherEnv: RuntimeState | null = null;
  let pollInFlight: Promise<void> | null = null;
  let pollNowHandler: (() => Promise<void>) | null = null;
  let watcherFatalError: string | null = null;
  let watcherStopping = false;
  let watcherGeneration = 0;
  let lastSyncedBlock = 0;
  let watcherScanProgress = {
    scannedThroughHeight: 0,
    replicaScannedThrough: {} as Record<string, number>,
  };
  const rememberWatcherScanProgress = (
    env: RuntimeState,
    watcherReplica: NonNullable<ReturnType<typeof findWatcherJurisdictionReplica>>,
    scannedThroughHeight: number,
  ): void => {
    const byReplica = new Map(Object.entries(watcherScanProgress.replicaScannedThrough));
    for (const [key, replica] of env.eReplicas.entries()) {
      if (!isEntityReplicaRelevantToWatcher(env, replica, watcherReplica)) continue;
      byReplica.set(key, Math.max(byReplica.get(key) ?? 0, scannedThroughHeight));
    }
    watcherScanProgress = {
      scannedThroughHeight: Math.max(watcherScanProgress.scannedThroughHeight, scannedThroughHeight),
      replicaScannedThrough: Object.fromEntries(
        [...byReplica.entries()].sort(([left], [right]) => compareStableText(left, right)),
      ),
    };
  };
  let consecutiveTransientWatcherFailures = 0;
  let lastTransientWatcherLogAt = 0;
  const txCounter: EventBatchCounter = { value: 0 };

  trace('return adapter');
  return adapter;
}
