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
  ERC20Mock__factory,
  EntityProvider__factory,
  HankoVerifier__factory,
} from '../../jurisdictions/typechain-types/index.ts';
import { BLOCKCHAIN } from '../constants';
import { normalizeEntityId } from '../entity/id';
import { prepareSignedBatch } from '../hanko/batch';
import { decodeJBatch } from '../jurisdiction/batch';
import { getCertifiedBoardStackKey } from '../jurisdiction/board-registry';
import { requireUsableContractAddress } from '../jurisdiction/contract-address';
import { getEntityCertifiedJAnchor, getValidatorJExpectedBlockHash } from '../jurisdiction/local-history';
import { compareStableText, safeStringify } from '../protocol/serialization';
import type { DisputeFinalizationEvidence, RuntimeState, JTx, RuntimeInput } from '../types';
import {
  TOKEN_REGISTRATION_AMOUNT,
  defaultTokensForJurisdiction,
  getDefaultTokenSupply,
} from '../jurisdiction/default-tokens';
import { makeJAdapterFailureResult } from './failure';
import { buildExternalTokenToReserveBatch, packTokenReference } from './helpers';
import { parseReceiptLogsToJEvents } from './j-event-log-decoder';
import { DEV_CHAIN_IDS } from './index';
import { normalizeReceiptHash, parseReceiptQuantity } from '../jurisdiction/receipt-codec';
import { readAuthenticatedReceiptRange, type RpcBatchCall } from './receipt-root';
import { createRpcLifecycleMethods } from './rpc-lifecycle';
import { readAndAssertRpcChainId } from './rpc-network';
import {
  PROCESS_BATCH_GAS_FLOOR,
  applyProcessBatchGasFloor,
  resolveDisputeFinalizationEvidence,
  isTransientRpcUnavailableError,
  isTronChainId,
  prepareAuthenticatedWatcherIngress,
  resolveWatcherPollToBlock,
  rpcLog,
} from './rpc-public';
import { createRpcReadMethods } from './rpc-reads';
import { createRpcTransactionSequencer } from './rpc-transaction-sequencer';
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
  assertFinalizedWatcherAnchors,
  collectTargetedWatcherRewinds,
  collectWatcherCanonicalAudit,
} from './watcher-reconciliation';
import { submitDebtEnforcement, submitMint } from './rpc-submit-basic';
import {
  applyBatchFeeOverrides,
  planRpcBatchSubmission,
} from './rpc-batch-plan';
import { buildDisputeStartDebug } from './rpc-batch-dispute-debug';
import { preflightProcessBatch } from './rpc-batch-preflight';
import { submitEntityProviderAction } from './rpc-submit-entity-provider';
import {
  applyGasHeadroom,
  asRpcReceipt,
  asRpcTxResponse,
  eventCarriers,
  haltProcessForFatalWatcherError,
  watcherErrorDetails,
  watcherErrorMessage,
  type FeeOverrides,
  type RpcReceipt,
  type TxOverrides,
  type UntypedNonPayableMethod,
} from './rpc-boundary';
import {
  buildTrackedExternalOwners,
  createTxFinalizationEvidenceReader,
  createWatchedErc20TokenReader,
} from './rpc-watcher-inputs';
import { decodeAuthenticatedWatcherEvents } from './rpc-watcher-events';

const requireWatcherBlockHash = (
  events: readonly JEventIngress[],
  blockNumber: number,
): string => {
  const blockHash = events[0]?.blockHash;
  if (!blockHash) {
    throw new Error(`J_EVENT_WATCHER_BLOCK_HASH_MISSING:${blockNumber}`);
  }
  return blockHash;
};

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
    return transactionSequencer.runFor(activeSigner, async () => {
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
          nonce: await transactionSequencer.allocateFor(activeSigner),
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
        await transactionSequencer.resetFor(activeSigner);
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
      await transactionSequencer.reset();
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

  const transactionSequencer = createRpcTransactionSequencer({
    provider,
    primarySigner: signer,
    usesEvmNonce: config.mode !== 'tron',
    buildFeeOverrides,
    waitForReceipt,
  });

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
      account = Account__factory.connect(addresses.account, signer);
      depository = Depository__factory.connect(addresses.depository, signer);
      entityProvider = EntityProvider__factory.connect(addresses.entityProvider, signer);
      deltaTransformer = DeltaTransformer__factory.connect(addresses.deltaTransformer, signer);
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

  const submitRpcBatch = async (
    jTx: Extract<JTx, { type: 'batch' }>,
    options: Parameters<JAdapter['submitTx']>[1],
  ): Promise<JSubmitResult> => {
    let planned: ReturnType<typeof planRpcBatchSubmission>;
    try {
      planned = planRpcBatchSubmission(
        jTx,
        options.env,
        options.signerId,
        config.chainId,
        addresses.depository,
      );
    } catch (error) {
      return makeJAdapterFailureResult(error);
    }
    if (planned.kind === 'skip') return { success: true };
    if (planned.kind === 'reject') {
      return { success: false, error: planned.error };
    }
    const {
      batch,
      expectedExternalSignerId,
      normalizedEntityId,
      preflightIssues,
      requiresExternalSubmitter,
    } = planned.plan;
    if (preflightIssues.length > 0) {
      rpcLog.warn('process_batch.preflight_issues', {
        entityId: normalizedEntityId,
        issues: preflightIssues,
      });
    }
    return transactionSequencer.run(async () => {
      const { signerPrivateKey } = options;
      if (watchOnly && !signerPrivateKey) {
        throw new Error(
          `JADAPTER_WATCH_ONLY_SIGNER_REQUIRED:batch:${normalizedEntityId}`,
        );
      }
      const submitter =
        signerPrivateKey && (watchOnly || requiresExternalSubmitter)
          ? await signerForPrivateKey(ethers.hexlify(signerPrivateKey))
          : null;
      if (requiresExternalSubmitter) {
        if (!submitter) {
          throw new Error(
            `EXTERNAL_BATCH_SIGNER_KEY_MISSING:${normalizedEntityId}`,
          );
        }
        const walletAddress = await submitter.getAddress();
        if (
          walletAddress.toLowerCase() !==
          expectedExternalSignerId.toLowerCase()
        ) {
          throw new Error(
            `EXTERNAL_BATCH_EOA_MISMATCH:${normalizedEntityId}:` +
              `expected=${expectedExternalSignerId}:wallet=${walletAddress}`,
          );
        }
      }
      const submittingDepository = submitter
        ? depository.connect(
            submitter as unknown as Parameters<typeof depository.connect>[0],
          )
        : depository;
      const batchData = planned.plan.jTx.data;
      const encodedBatch = batchData.encodedBatch;
      const hankoData = batchData.hankoSignature;
      const entityNonce = BigInt(batchData.entityNonce);
      const disputeDebug = await buildDisputeStartDebug(
        batch,
        normalizedEntityId,
        {
          chainId: config.chainId,
          depositoryAddress: await getLiveDepositoryAddress(),
        },
      );
      try {
        const gasEstimate = await estimateProcessBatchGas(() =>
          submittingDepository.processBatch.estimateGas(
            encodedBatch,
            hankoData,
            entityNonce,
          ),
        );
        const gasLimit = resolveProcessBatchGasLimit(
          gasEstimate.gasLimit,
          batch.disputeFinalizations.length > 0,
        );
        const preflightFailure = await preflightProcessBatch({
          depository: submittingDepository,
          encodedBatch,
          hankoData,
          entityNonce,
          gasLimit,
          gasEstimateUsedFallback: gasEstimate.usedFallback,
          disputeStartDebug: disputeDebug,
          isLocalSnapshotRace: isLocalLatestStateStaticCallRace,
        });
        if (preflightFailure) return preflightFailure;

        const receipt = await transactionSequencer.send(
          submitter ?? signer,
          'submitTx:processBatch',
          (nonce, feeOverrides) =>
            submittingDepository.processBatch(
              encodedBatch,
              hankoData,
              entityNonce,
              {
                gasLimit,
                nonce,
                ...applyBatchFeeOverrides(
                  feeOverrides,
                  batchData.feeOverrides,
                ),
              },
            ),
        );
        return {
          success: true,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber ?? 0,
          events: parseReceiptLogsToJEvents(
            receipt,
            eventCarriers(depository, entityProvider),
          ),
        };
      } catch (error) {
        rpcLog.error('process_batch.failed', {
          entityId: normalizedEntityId,
          error: error instanceof Error ? error.message : String(error),
        });
        return makeJAdapterFailureResult(error);
      }
    });
  };

  const deployBootstrapTokens = async (): Promise<string[]> => {
    const factory = new ERC20Mock__factory(signer);
    const tokens = defaultTokensForJurisdiction({ chainId: config.chainId });
    for (const token of tokens) {
      const supply = getDefaultTokenSupply(token.decimals);
      const contract = await factory.deploy(token.name, token.symbol, token.decimals, supply);
      await contract.waitForDeployment();
      const tokenAddress = await contract.getAddress();

      // Internal reserve accounting is not custody: pre-fund withdrawals.
      const prefund = await contract.mint(
        addresses.depository,
        supply,
        await buildFeeOverrides(),
      );
      await waitForReceipt(prefund, `erc20.mint-to-depository.${token.symbol}`);
      const approval = await contract.approve(
        addresses.depository,
        TOKEN_REGISTRATION_AMOUNT,
        await buildFeeOverrides(),
      );
      await waitForReceipt(approval, `erc20.approve.${token.symbol}`);
      const registration = await depository.adminRegisterExternalToken(
        {
          entity: ethers.ZeroHash,
          contractAddress: tokenAddress,
          externalTokenId: 0,
          tokenType: 0,
          internalTokenId: 0,
          amount: TOKEN_REGISTRATION_AMOUNT,
        },
        await buildFeeOverrides(),
      );
      await waitForReceipt(registration, `depository.externalTokenToReserve.${token.symbol}`);
      const tokenId = await depository.tokenToId(packTokenReference(0, tokenAddress, 0n));
      if (tokenId === 0n) {
        throw new Error(
          `JADAPTER_BOOTSTRAP_TOKEN_REGISTRATION_FAILED:${token.symbol}`,
        );
      }
      rpcLog.debug('contracts.deploy.token_registered', {
        chainId: config.chainId,
        symbol: token.symbol,
        tokenId: tokenId.toString(),
        address: tokenAddress,
        supply: ethers.formatUnits(supply, token.decimals),
      });
    }
    return tokens.map(token => token.symbol);
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

      // Deploy Account library.
      const accountFactory = new Account__factory(signer);
      const accountContract = await accountFactory.deploy();
      await accountContract.waitForDeployment();
      addresses.account = await accountContract.getAddress();
      account = accountContract;
      rpcLog.debug('contracts.deploy.account', { chainId: config.chainId, account: addresses.account });

      // Deploy and link the bounded Hanko verifier before EntityProvider.
      const hankoVerifierFactory = new HankoVerifier__factory(signer);
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
      depository = Depository__factory.connect(addresses.depository, signer);
      await verifyStackBinding('rpc_deploy');
      rpcLog.debug('contracts.deploy.depository', { chainId: config.chainId, depository: addresses.depository });

      // Deploy DeltaTransformer
      const deltaTransformerFactory = new DeltaTransformer__factory(signer);
      const deltaTransformerContract = await deltaTransformerFactory.deploy();
      await deltaTransformerContract.waitForDeployment();
      addresses.deltaTransformer = await deltaTransformerContract.getAddress();
      deltaTransformer = deltaTransformerContract;
      rpcLog.debug('contracts.deploy.delta_transformer', {
        chainId: config.chainId,
        deltaTransformer: addresses.deltaTransformer,
      });

      const bootstrapTokenSymbols = await deployBootstrapTokens();

      deployed = true;

      rpcLog.info('contracts.deploy.ready', {
        chainId: config.chainId,
        tokens: bootstrapTokenSymbols,
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
      return transactionSequencer.run(async () => {
        try {
          const batch = decodeJBatch(encodedBatch);
          const receipt = await sendTypedTx('processBatch', depository.processBatch, [encodedBatch, hankoData, nonce], {
            gasFallback: PROCESS_BATCH_GAS_FLOOR,
            ...(config.mode === 'tron' || batch.disputeFinalizations.length === 0
              ? {}
              : { minimumGasLimit: PROCESS_BATCH_GAS_FLOOR }),
            txNonce: await transactionSequencer.allocate(),
            resetSignerNonce: true,
          });
          const events = parseReceiptLogsToJEvents(receipt, eventCarriers(depository, entityProvider));

          return {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            events,
          };
        } catch (error) {
          await transactionSequencer.reset();
          throw error;
        }
      });
    },

    async enforceDebts(entityId: string, tokenId: number, maxIterations: number | bigint = 100n): Promise<void> {
      await transactionSequencer.run(async () => {
        try {
          const iterationCap = BigInt(maxIterations);
          await sendTypedTx('enforceDebts', depository.enforceDebts, [entityId, BigInt(tokenId), iterationCap], {
            gasFallback: 500_000n,
            txNonce: await transactionSequencer.allocate(),
            resetSignerNonce: false,
          });
        } catch (error) {
          await transactionSequencer.reset();
          throw error;
        }
      });
    },

    async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<JEvent[]> {
      // For dev chains (anvil), allow debug funding for testnet
      if (DEV_CHAIN_IDS.has(config.chainId)) {
        return transactionSequencer.run(async () => {
          try {
            const receipt = await sendTypedTx('mintToReserve', depository.mintToReserve, [entityId, tokenId, amount], {
              gasFallback: 1_000_000n,
              txNonce: await transactionSequencer.allocate(),
              resetSignerNonce: false,
            });
            return parseReceiptLogsToJEvents(receipt, eventCarriers(depository));
          } catch (error) {
            await transactionSequencer.reset();
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
      return transactionSequencer.run(async () => {
        try {
          const events: JEvent[] = [];
          for (const mint of mints) {
            const receipt = await sendTypedTx(
              'mintToReserve',
              depository.mintToReserve,
              [mint.entityId, BigInt(mint.tokenId), mint.amount],
              {
                gasFallback: 1_000_000n,
                txNonce: await transactionSequencer.allocate(),
                resetSignerNonce: false,
              },
            );
            events.push(...parseReceiptLogsToJEvents(receipt, eventCarriers(depository)));
          }
          return events;
        } catch (error) {
          await transactionSequencer.reset();
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
        await transactionSequencer.runFor(signerWallet, async () => {
          if (allowance > 0n) {
            await transactionSequencer.send(signerWallet, 'erc20ApproveReset', (nonce, feeOverrides) =>
              approveFn(liveDepositoryAddress, 0n, {
                ...feeOverrides,
                nonce,
              }),
            );
          }
          await transactionSequencer.send(signerWallet, 'erc20ApproveMax', (nonce, feeOverrides) =>
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
      runSerializedBatchFor: transactionSequencer.runFor,
      sendSignerTxWithExplicitNonce: transactionSequencer.send,
    }),

    // === High-level J-tx submission ===
    async submitTx(
      jTx: JTx,
      options: { env: RuntimeState; signerId?: string; signerPrivateKey?: Uint8Array; timestamp?: number },
    ): Promise<JSubmitResult> {
      const { signerPrivateKey } = options;

      console.log(`📤 [JAdapter:rpc] submitTx type=${jTx.type} entity=${jTx.entityId.slice(-4)}`);

      if (jTx.type === 'debtEnforcement') {
        return submitDebtEnforcement(jTx, (entityId, tokenId, maxIterations) =>
          adapter.enforceDebts(entityId, tokenId, maxIterations),
        );
      }

      if (
        jTx.type === 'entityProviderTransfer' ||
        jTx.type === 'entityProviderReleaseControlShares' ||
        jTx.type === 'entityProviderCancelAction'
      ) {
        return submitEntityProviderAction(
          {
            chainId: config.chainId,
            watchOnly,
            signer,
            entityProvider,
            depository,
            getDepositoryAddress: getLiveDepositoryAddress,
            getEntityProviderAddress: getLiveEntityProviderAddress,
            signerForPrivateKey,
            readActionReceipt: readEntityProviderActionReceipt,
            runSerialized: transactionSequencer.run,
            estimateGas: estimateGasWithHeadroom,
            send: transactionSequencer.send,
          },
          jTx,
          signerPrivateKey,
        );
      }

      if (jTx.type === 'batch') {
        return submitRpcBatch(jTx, options);
      }

      if (jTx.type === 'mint') {
        return submitMint(jTx, DEV_CHAIN_IDS.has(config.chainId), (entityId, tokenId, amount) =>
          adapter.debugFundReserves(entityId, tokenId, amount),
        );
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
      const readWatchedErc20Tokens = createWatchedErc20TokenReader(depository, emitWatcherDebug);
      const readTxFinalizationEvidence = createTxFinalizationEvidenceReader(provider);
      const findDisputeFinalizationEvidence = async (
        txHash: string,
        args: Record<string, unknown>,
      ): Promise<DisputeFinalizationEvidence | undefined> =>
        resolveDisputeFinalizationEvidence(await readTxFinalizationEvidence(txHash), txHash, args);
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
        const audit = collectWatcherCanonicalAudit(
          activeEnv,
          watcherReplica,
          lastSyncedBlock,
        );
        const { relevantReplicaEntries, relevantReplicas } = audit;
        if (relevantReplicas.length === 0) return false;
        const canonicalHeaders = new Map<number, string>();
        for (const header of await readBlockHeadersAtHeights(
          audit.auditHeights,
        )) {
          canonicalHeaders.set(header.jHeight, header.jBlockHash);
        }
        assertFinalizedWatcherAnchors(audit, canonicalHeaders, config.chainId);
        const targetedRewinds = collectTargetedWatcherRewinds(
          audit,
          canonicalHeaders,
          config.chainId,
        );
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
          const decoded = await decodeAuthenticatedWatcherEvents({
            env: activeEnv,
            watcherReplica,
            logs: authenticatedLogs,
            depositoryAddress: liveDepositoryAddress,
            entityProviderAddress: liveEntityProviderAddress,
            tokenByAddress,
            trackedOwners: buildTrackedExternalOwners(activeEnv),
            observedThroughHeight: toBlock,
            observedTipBlockHash: rangeTipHash,
            observedHeadHeight: currentBlock,
            confirmationDepth,
            findDisputeFinalizationEvidence,
          });
          const rawEvents = decoded.events;
          const authorityTxsByBlock = decoded.authorityTxsByBlock;

          if (authenticatedLogs.length > 0) {
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
                const blockHash = requireWatcherBlockHash(events, blockNum);
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
