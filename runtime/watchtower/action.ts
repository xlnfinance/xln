import { Interface, JsonRpcProvider, Wallet, ethers } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types/index.ts';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../protocol/boundary-validation';
import { deserializeTaggedJson, serializeTaggedJson } from '../protocol/serialization';
import { createXlnJsonRpcProvider } from '../jurisdiction/adapter';
import type {
  TowerCounterDisputeRemedy,
  TowerFinalDisputeProof,
  TowerLastResortWatchV1,
} from '../storage/recovery/types';
import { decryptTowerPayloadWithWatchSeed } from '../storage/recovery/crypto';
import type { LastResortTowerAppointment, WatchtowerStore, StoredTowerActionReceipt } from './store';

const DEPOSITORY_MINIMAL_ABI = [
  'function accountKey(bytes32 e1, bytes32 e2) view returns (bytes)',
  'function _accounts(bytes acctKey) view returns (uint256 nonce, bytes32 disputeHash, uint256 disputeTimeout, uint256 disputeStartTimestamp, uint32 leftResponseSeconds, uint32 rightResponseSeconds, bytes32 disputeInitialProofbodyHash, bool disputeInitialProposerIsLeft, uint256 disputeCounterNonce, bytes32 disputeCounterProofbodyHash, bool disputeCounterProposerIsLeft, bytes32 starterInitialArgumentsCommitment, bytes32 starterCounterArgumentsCommitment, bytes32 starterCounterProofCommitment, bool disputeStartedByLeft)',
  'function watchtowerCounterDispute(bytes32 entityId, (bytes32 counterentity,uint256 initialNonce,uint256 finalNonce,bool proposerIsLeft,bytes32 initialProofbodyHash,(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,int256[] offdeltas,uint256[] tokenIds,(address transformerAddress,bytes encodedBatch,(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers) finalProofbody,bytes starterArguments,bytes otherArguments,bytes sig,bool startedByLeft,bool cooperative) params, uint256 lastResortWindowSeconds, uint256 appointmentSequence, bytes ownerAuthorizationHanko) returns (bool)',
  'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bool proposerIsLeft, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterCounterArguments, bytes32 starterCounterProofCommitment, uint256 disputeTimeout, uint256 disputeStartTimestamp, uint32 leftResponseSeconds, uint32 rightResponseSeconds)',
] as const;

const DEPOSITORY_INTERFACE = new Interface(DEPOSITORY_MINIMAL_ABI);
const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();
const PROOF_BODY_PARAM = ethers.ParamType.from(
  'tuple(bytes32 watchSeed,uint32 leftResponseSeconds,uint32 rightResponseSeconds,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)',
);
const ZERO_HASH = ethers.ZeroHash.toLowerCase();

type WatchtowerLog = { topics: readonly string[]; data: string };
type WatchtowerSweepProvider = {
  getBlockNumber: () => Promise<number>;
  getBlock?: (blockTag: string | number) => Promise<{ timestamp: number | bigint } | null>;
  getLogs?: (filter: Record<string, unknown>) => Promise<WatchtowerLog[]>;
};

const WATCHTOWER_RPC_READ_TIMEOUT_MS = 10_000;

const withWatchtowerRpcTimeout = async <T>(
  promise: Promise<T>,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}_TIMEOUT:${WATCHTOWER_RPC_READ_TIMEOUT_MS}`)),
          WATCHTOWER_RPC_READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const isRpcLogRangeLimitError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /block range|range.{0,32}(too large|limit|exceed)|query returned more than|too many results|response size|please limit|-32005/i.test(message);
};

const readAdaptiveWatchtowerLogs = async (
  provider: Pick<WatchtowerSweepProvider, 'getLogs'>,
  filter: Record<string, unknown> & { fromBlock: number; toBlock: number },
): Promise<WatchtowerLog[]> => {
  if (typeof provider.getLogs !== 'function') {
    throw new Error('WATCHTOWER_PROVIDER_GET_LOGS_UNAVAILABLE');
  }
  try {
    return await withWatchtowerRpcTimeout(
      provider.getLogs(filter),
      `WATCHTOWER_ACTIVE_DISPUTE_LOGS:${filter.fromBlock}:${filter.toBlock}`,
    );
  } catch (error) {
    if (!isRpcLogRangeLimitError(error) || filter.fromBlock >= filter.toBlock) throw error;
    const middle = filter.fromBlock + Math.floor((filter.toBlock - filter.fromBlock) / 2);
    const [left, right] = await Promise.all([
      readAdaptiveWatchtowerLogs(provider, { ...filter, toBlock: middle }),
      readAdaptiveWatchtowerLogs(provider, { ...filter, fromBlock: middle + 1 }),
    ]);
    return [...left, ...right];
  }
};

const isHexLike = (value: unknown, length?: number): value is string => {
  if (typeof value !== 'string' || !ethers.isHexString(value)) return false;
  return length === undefined || value.length === length;
};

const normalizeHex32 = (value: unknown, label: string): string => {
  if (!isHexLike(value, 66)) throw new Error(`WATCHTOWER_REMEDY_${label}_INVALID`);
  return value.toLowerCase();
};

const normalizeAddress = (value: unknown, label: string): string => {
  if (!isHexLike(value, 42)) throw new Error(`WATCHTOWER_REMEDY_${label}_INVALID`);
  return value.toLowerCase();
};

const toInt = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`WATCHTOWER_REMEDY_${label}_INVALID`);
  }
  return Number(value);
};

const requireBool = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`WATCHTOWER_REMEDY_${label}_INVALID`);
  return value;
};

const uint256ToSafeNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`WATCHTOWER_REMEDY_${label}_INVALID`);
  }
  return Number(value);
};

const requireHex = (value: unknown, label: string): string => {
  if (!isHexLike(value)) throw new Error(`WATCHTOWER_REMEDY_${label}_INVALID`);
  return value;
};

const normalizeFinalProofbody = (
  value: unknown,
): TowerFinalDisputeProof['finalProofbody'] => {
  const proof = requireBoundaryRecord(value, 'WATCHTOWER_REMEDY_FINAL_PROOFBODY_INVALID');
  requireExactBoundaryKeys(
    proof,
    ['watchSeed', 'leftResponseSeconds', 'rightResponseSeconds', 'offdeltas', 'tokenIds', 'transformers'],
    [],
    'WATCHTOWER_REMEDY_FINAL_PROOFBODY_FIELDS_INVALID',
  );
  const offdeltas = proof['offdeltas'];
  const tokenIds = proof['tokenIds'];
  const transformers = proof['transformers'];
  const leftResponseSeconds = proof['leftResponseSeconds'];
  const rightResponseSeconds = proof['rightResponseSeconds'];
  if (
    typeof leftResponseSeconds !== 'bigint'
    || typeof rightResponseSeconds !== 'bigint'
    || leftResponseSeconds < 0n
    || rightResponseSeconds < 0n
    || leftResponseSeconds > 0xffff_ffffn
    || rightResponseSeconds > 0xffff_ffffn
    || leftResponseSeconds + rightResponseSeconds > 365n * 24n * 60n * 60n
  ) {
    throw new Error('WATCHTOWER_REMEDY_FINAL_PROOFBODY_RESPONSE_SECONDS_INVALID');
  }
  if (!Array.isArray(offdeltas) || offdeltas.some(delta => typeof delta !== 'bigint')) {
    throw new Error('WATCHTOWER_REMEDY_FINAL_PROOFBODY_OFFDELTAS_INVALID');
  }
  if (
    !Array.isArray(tokenIds)
    || tokenIds.some(tokenId => typeof tokenId !== 'bigint' || tokenId < 0n)
  ) {
    throw new Error('WATCHTOWER_REMEDY_FINAL_PROOFBODY_TOKEN_IDS_INVALID');
  }
  if (offdeltas.length !== tokenIds.length || !Array.isArray(transformers)) {
    throw new Error('WATCHTOWER_REMEDY_FINAL_PROOFBODY_SHAPE_INVALID');
  }
  const decodedTransformers = transformers.map((rawTransformer, transformerIndex) => {
    const code = `WATCHTOWER_REMEDY_FINAL_PROOFBODY_TRANSFORMER_${transformerIndex}`;
    const transformer = requireBoundaryRecord(rawTransformer, `${code}_INVALID`);
    requireExactBoundaryKeys(
      transformer,
      ['transformerAddress', 'encodedBatch', 'allowances'],
      [],
      `${code}_FIELDS_INVALID`,
    );
    if (!Array.isArray(transformer['allowances'])) throw new Error(`${code}_ALLOWANCES_INVALID`);
    const allowances = transformer['allowances'].map((rawAllowance, allowanceIndex) => {
      const allowanceCode = `${code}_ALLOWANCE_${allowanceIndex}`;
      const allowance = requireBoundaryRecord(rawAllowance, `${allowanceCode}_INVALID`);
      requireExactBoundaryKeys(
        allowance,
        ['deltaIndex', 'rightAllowance', 'leftAllowance'],
        [],
        `${allowanceCode}_FIELDS_INVALID`,
      );
      const deltaIndex = allowance['deltaIndex'];
      const rightAllowance = allowance['rightAllowance'];
      const leftAllowance = allowance['leftAllowance'];
      if (typeof deltaIndex !== 'bigint' || deltaIndex < 0n) {
        throw new Error(`${allowanceCode}_DELTA_INDEX_INVALID`);
      }
      if (typeof rightAllowance !== 'bigint' || rightAllowance < 0n) {
        throw new Error(`${allowanceCode}_RIGHT_ALLOWANCE_INVALID`);
      }
      if (typeof leftAllowance !== 'bigint' || leftAllowance < 0n) {
        throw new Error(`${allowanceCode}_LEFT_ALLOWANCE_INVALID`);
      }
      return { deltaIndex, rightAllowance, leftAllowance };
    });
    return {
      transformerAddress: normalizeAddress(transformer['transformerAddress'], 'TRANSFORMER'),
      encodedBatch: requireHex(transformer['encodedBatch'], 'TRANSFORMER_BATCH'),
      allowances,
    };
  });
  return {
    watchSeed: normalizeHex32(proof['watchSeed'], 'FINAL_PROOFBODY_WATCH_SEED'),
    leftResponseSeconds,
    rightResponseSeconds,
    offdeltas: [...offdeltas],
    tokenIds: [...tokenIds],
    transformers: decodedTransformers,
  };
};

const normalizeFinalDisputeProof = (value: unknown): TowerFinalDisputeProof => {
  const candidate = requireBoundaryRecord(value, 'WATCHTOWER_REMEDY_FINALIZATION_INVALID');
  requireExactBoundaryKeys(
    candidate,
    ['counterentity', 'finalNonce', 'proposerIsLeft', 'finalProofbody', 'leftArguments', 'rightArguments', 'sig'],
    [],
    'WATCHTOWER_REMEDY_FINALIZATION_FIELDS_INVALID',
  );
  return {
    counterentity: normalizeHex32(candidate['counterentity'], 'COUNTERENTITY'),
    finalNonce: toInt(candidate['finalNonce'], 'FINAL_NONCE'),
    proposerIsLeft: requireBool(candidate['proposerIsLeft'], 'PROPOSER_IS_LEFT'),
    finalProofbody: normalizeFinalProofbody(candidate['finalProofbody']),
    // Arguments are optional adversarial evidence and may be empty. The signed
    // proof and Hanko below are authority, so they never receive defaults.
    leftArguments: requireHex(candidate['leftArguments'], 'LEFT_ARGUMENTS'),
    rightArguments: requireHex(candidate['rightArguments'], 'RIGHT_ARGUMENTS'),
    sig: requireHex(candidate['sig'], 'SIGNATURE'),
  };
};

const computeProofBodyHash = (
  proofBody: TowerFinalDisputeProof['finalProofbody'],
): string =>
  ethers.keccak256(ABI_CODER.encode([PROOF_BODY_PARAM], [proofBody])).toLowerCase();

export const encodeTowerCounterDisputeRemedy = (remedy: TowerCounterDisputeRemedy): string =>
  serializeTaggedJson(remedy);

export const decodeTowerCounterDisputeRemedy = async (
  payload: string,
  watchSeed?: string,
): Promise<TowerCounterDisputeRemedy> => {
  const raw = watchSeed
    ? await decryptTowerPayloadWithWatchSeed(payload, watchSeed)
    : String(payload || '').trim();
  if (!raw) throw new Error('WATCHTOWER_REMEDY_EMPTY');
  const parsed = deserializeTaggedJson<Record<string, unknown>>(raw);
  requireExactBoundaryKeys(
    parsed,
    [
      'version', 'type', 'rpcUrl', 'chainId', 'depositoryAddress',
      'watchedEntityId', 'towerAddress', 'lastResortWindowSeconds',
      'appointmentSequence', 'ownerAuthorizationHanko', 'latestProof',
    ],
    [],
    'WATCHTOWER_REMEDY_FIELDS_INVALID',
  );
  if (parsed['type'] !== 'counter_dispute_remedy' || parsed['version'] !== 1) {
    throw new Error('WATCHTOWER_REMEDY_TYPE_INVALID');
  }
  return {
    version: 1,
    type: 'counter_dispute_remedy',
    rpcUrl: String(parsed['rpcUrl'] || '').trim(),
    chainId: toInt(parsed['chainId'], 'CHAIN_ID'),
    depositoryAddress: normalizeAddress(parsed['depositoryAddress'], 'DEPOSITORY'),
    watchedEntityId: normalizeHex32(parsed['watchedEntityId'], 'WATCHED_ENTITY'),
    towerAddress: normalizeAddress(parsed['towerAddress'], 'TOWER'),
    lastResortWindowSeconds: toInt(parsed['lastResortWindowSeconds'], 'LAST_RESORT_WINDOW_SECONDS'),
    appointmentSequence: toInt(parsed['appointmentSequence'], 'APPOINTMENT_SEQUENCE'),
    ownerAuthorizationHanko: requireHex(
      parsed['ownerAuthorizationHanko'],
      'OWNER_AUTHORIZATION_HANKO',
    ),
    latestProof: normalizeFinalDisputeProof(parsed['latestProof']),
  };
};

const normalizeWatch = (watch: unknown): TowerLastResortWatchV1 => {
  const candidate = watch as Record<string, unknown>;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('WATCHTOWER_WATCH_MISSING');
  }
  const chainId = toInt(candidate['chainId'], 'WATCH_CHAIN_ID');
  if (chainId <= 0) throw new Error('WATCHTOWER_REMEDY_WATCH_CHAIN_ID_INVALID');
  return {
    rpcUrl: normalizeRpcUrl(String(candidate['rpcUrl'] || '')),
    chainId,
    depositoryAddress: normalizeAddress(candidate['depositoryAddress'], 'WATCH_DEPOSITORY'),
    watchedEntityId: normalizeHex32(candidate['watchedEntityId'], 'WATCH_ENTITY'),
    counterentity: normalizeHex32(candidate['counterentity'], 'WATCH_COUNTERENTITY'),
  };
};

const assertLastResortPayloadBasics = (appointment: LastResortTowerAppointment): void => {
  const payload = appointment.lastResortPayload;
  if (payload.actionKind !== 'counter_dispute_only') {
    throw new Error('WATCHTOWER_ACTION_KIND_UNSUPPORTED');
  }
  if (payload.responseMode !== 'last_resort') {
    throw new Error('WATCHTOWER_RESPONSE_MODE_UNSUPPORTED');
  }
  if (!Number.isSafeInteger(payload.appointmentSequence) || payload.appointmentSequence <= 0) {
    throw new Error('WATCHTOWER_APPOINTMENT_SEQUENCE_INVALID');
  }
  if (!Number.isSafeInteger(payload.proofNonce) || payload.proofNonce <= 0) {
    throw new Error('WATCHTOWER_PROOF_NONCE_INVALID');
  }
  normalizeHex32(payload.proofBodyHash, 'PROOF_BODY_HASH');
  if (
    !Number.isSafeInteger(payload.lastResortWindowSeconds)
    || payload.lastResortWindowSeconds <= 0
  ) {
    throw new Error('WATCHTOWER_LAST_RESORT_WINDOW_INVALID');
  }
};

type WatchtowerSweepOptions = {
  lookupKey?: string;
  towerPrivateKey?: string;
  allowedRpcUrls?: string[];
  now?: () => number;
  txWaitTimeoutMs?: number;
  providerFactory?: (rpcUrl: string, chainId: number) => {
    getBlockNumber: () => Promise<number>;
    getBlock?: (blockTag: string | number) => Promise<{ timestamp: number | bigint } | null>;
    getLogs?: (filter: Record<string, unknown>) => Promise<WatchtowerLog[]>;
  } | JsonRpcProvider;
  contractFactory?: (
    target: TowerLastResortWatchV1 | TowerCounterDisputeRemedy,
    towerWallet: Wallet,
    provider: WatchtowerSweepProvider | JsonRpcProvider,
  ) => {
    accountKey: (entityId: string, counterentity: string) => Promise<string>;
    _accounts: (acctKey: string) => Promise<{
      nonce: bigint;
      disputeHash: string;
      disputeTimeout: bigint;
      disputeStartTimestamp: bigint;
      leftResponseSeconds: bigint;
      rightResponseSeconds: bigint;
      disputeInitialProofbodyHash: string;
      disputeInitialProposerIsLeft: boolean;
      disputeCounterNonce: bigint;
      disputeCounterProofbodyHash: string;
      disputeCounterProposerIsLeft: boolean;
      starterInitialArgumentsCommitment: string;
      starterCounterArgumentsCommitment: string;
      starterCounterProofCommitment: string;
      disputeStartedByLeft: boolean;
    }>;
    watchtowerCounterDispute: (
      entityId: string,
      finalization: {
        counterentity: string;
        initialNonce: number;
        finalNonce: number;
        proposerIsLeft: boolean;
        initialProofbodyHash: string;
        finalProofbody: TowerFinalDisputeProof['finalProofbody'];
        starterArguments: string;
        otherArguments: string;
        sig: string;
        startedByLeft: boolean;
        cooperative: boolean;
      },
      lastResortWindowSeconds: number,
      appointmentSequence: number,
      ownerAuthorizationHanko: string,
    ) => Promise<{ hash?: string; wait?: () => Promise<{ blockNumber?: number } | null> }>;
  };
};

const DEFAULT_ALLOWED_RPC_URLS = [
  'http://127.0.0.1:8545/',
  'http://127.0.0.1:8546/',
  'http://localhost:8545/',
  'http://localhost:8546/',
  'https://xln.finance/rpc',
  'https://xln.finance/rpc2',
  'https://xln.finance/rpc3',
  'https://xln.finance/rpc4',
  'https://xln.finance/rpc5',
  'https://xln.finance/rpc6',
  'https://xln.finance/rpc7',
  'https://xln.finance/rpc8',
];

const normalizeRpcUrl = (value: string): string => {
  const parsed = new URL(String(value || '').trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`WATCHTOWER_RPC_URL_SCHEME_NOT_ALLOWED:${parsed.protocol}`);
  }
  parsed.hash = '';
  return parsed.toString();
};

const resolveAllowedRpcUrls = (override?: string[]): Set<string> => {
  const configured = override && override.length > 0
    ? override
    : String(process.env['XLN_WATCHTOWER_ALLOWED_RPC_URLS'] || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
  const source = configured.length > 0 ? configured : DEFAULT_ALLOWED_RPC_URLS;
  return new Set(source.map(normalizeRpcUrl));
};

export const assertWatchtowerRpcUrlAllowed = (rpcUrl: string, allowedRpcUrls?: string[]): string => {
  const normalized = normalizeRpcUrl(rpcUrl);
  const allowed = resolveAllowedRpcUrls(allowedRpcUrls);
  if (!allowed.has(normalized)) {
    throw new Error(`WATCHTOWER_RPC_URL_NOT_ALLOWED:${normalized}`);
  }
  return normalized;
};

type WatchtowerRpcSender = {
  send?: (method: string, params: unknown[]) => Promise<unknown>;
};

const readProviderBlockNumber = async (
  provider: WatchtowerSweepProvider | JsonRpcProvider,
): Promise<number> => {
  const sender = provider as WatchtowerRpcSender;
  if (typeof sender.send === 'function') {
    const hex = await sender.send('eth_blockNumber', []);
    if (typeof hex === 'string' && hex.startsWith('0x')) {
      return uint256ToSafeNumber(BigInt(hex), 'CURRENT_BLOCK');
    }
  }
  return uint256ToSafeNumber(BigInt(await provider.getBlockNumber()), 'CURRENT_BLOCK');
};

const readProviderBlockTimestamp = async (
  provider: WatchtowerSweepProvider | JsonRpcProvider,
  blockNumber: number,
): Promise<bigint> => {
  // Prefer raw eth_getBlockByNumber so reused JsonRpcProvider clients cannot
  // serve a cached getBlock('latest') after anvil time jumps / mines.
  const sender = provider as WatchtowerRpcSender;
  if (typeof sender.send === 'function') {
    const raw = await sender.send('eth_getBlockByNumber', [
      `0x${BigInt(blockNumber).toString(16)}`,
      false,
    ]) as { timestamp?: string } | null;
    const hex = raw?.timestamp;
    if (typeof hex === 'string' && hex.startsWith('0x')) {
      return BigInt(hex);
    }
  }
  if (typeof provider.getBlock === 'function') {
    const block = await provider.getBlock(blockNumber);
    const rawTimestamp = block?.timestamp;
    if (typeof rawTimestamp === 'bigint' && rawTimestamp >= 0n) return rawTimestamp;
    if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp) && rawTimestamp >= 0) {
      return BigInt(Math.trunc(rawTimestamp));
    }
  }
  throw new Error('WATCHTOWER_PROVIDER_BLOCK_TIMESTAMP_INVALID');
};

const waitForReceiptWithTimeout = async (
  tx: { wait?: () => Promise<{ blockNumber?: number } | null> },
  timeoutMs: number,
): Promise<{ blockNumber?: number } | null> => {
  if (typeof tx.wait !== 'function') return null;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    return await tx.wait();
  }
  return await Promise.race([
    tx.wait(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
};

type ActiveDisputeContext = {
  initialNonce: number;
  initialProofbodyHash: string;
  watchSeed: string;
  starterInitialArguments: string;
  starterCounterArguments: string;
  starterCounterProofCommitment: string;
  startedByLeft: boolean;
  initialProposerIsLeft: boolean;
};

type OnchainDisputeAccount = {
  nonce: bigint;
  disputeHash: string;
  disputeTimeout: bigint;
  disputeStartTimestamp: bigint;
  leftResponseSeconds: bigint;
  rightResponseSeconds: bigint;
  disputeInitialProofbodyHash: string;
  disputeInitialProposerIsLeft: boolean;
  disputeCounterNonce: bigint;
  disputeCounterProofbodyHash: string;
  disputeCounterProposerIsLeft: boolean;
  starterInitialArgumentsCommitment: string;
  starterCounterArgumentsCommitment: string;
  starterCounterProofCommitment: string;
  disputeStartedByLeft: boolean;
};

const disputeArgumentCommitment = (
  value: string,
  startedByLeft: boolean,
  disputeStartTimestamp: bigint,
): string => ethers.keccak256(ABI_CODER.encode(
  ['bytes', 'bool', 'uint256'],
  [value, startedByLeft, disputeStartTimestamp],
));

const encodeDisputeHash = (
  initialNonce: number,
  startedByLeft: boolean,
  initialProposerIsLeft: boolean,
  disputeTimeout: bigint,
  leftResponseSeconds: bigint,
  rightResponseSeconds: bigint,
  initialProofbodyHash: string,
  disputeStartTimestamp: bigint,
  starterInitialArgumentsCommitment: string,
  starterCounterArgumentsCommitment: string,
  starterCounterProofCommitment: string,
  counterNonce: bigint,
  counterProofbodyHash: string,
  counterProposerIsLeft: boolean,
): string => ethers.keccak256(
  ethers.solidityPacked(
    ['uint256', 'bool', 'bool', 'uint256', 'uint32', 'uint32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bool'],
    [
      BigInt(initialNonce),
      startedByLeft,
      initialProposerIsLeft,
      disputeTimeout,
      leftResponseSeconds,
      rightResponseSeconds,
      initialProofbodyHash,
      disputeStartTimestamp,
      starterInitialArgumentsCommitment,
      starterCounterArgumentsCommitment,
      starterCounterProofCommitment,
      counterNonce,
      counterProofbodyHash,
      counterProposerIsLeft,
    ],
  ),
);

const findFirstBlockAtOrAfterTimestamp = async (
  provider: Pick<WatchtowerSweepProvider, 'getBlock'>,
  latestBlock: number,
  timestamp: bigint,
): Promise<number> => {
  if (typeof provider.getBlock !== 'function') {
    throw new Error('WATCHTOWER_PROVIDER_GET_BLOCK_UNAVAILABLE');
  }
  let low = 0;
  let high = latestBlock;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const block = await provider.getBlock(middle);
    if (!block) throw new Error(`WATCHTOWER_BLOCK_NOT_FOUND:${middle}`);
    if (BigInt(block.timestamp) < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
};

const findActiveDisputeContext = async (
  provider: Pick<WatchtowerSweepProvider, 'getBlock' | 'getLogs'>,
  watch: TowerLastResortWatchV1,
  account: OnchainDisputeAccount,
  currentBlock: bigint,
): Promise<ActiveDisputeContext> => {
  if (typeof provider.getLogs !== 'function') {
    throw new Error('WATCHTOWER_PROVIDER_GET_LOGS_UNAVAILABLE');
  }
  // disputeTimeout / disputeStartTimestamp are absolute unix seconds, not block
  // numbers. Log scans stay block-ranged; AccountInfo already carries the start
  // timestamp used for argument commitments and disputeHash checks below.
  if (account.disputeStartTimestamp <= 0n) {
    throw new Error('WATCHTOWER_DISPUTE_START_TIMESTAMP_MISSING');
  }
  const latestBlock = uint256ToSafeNumber(currentBlock, 'CURRENT_BLOCK');
  // A bilateral response clock may be as long as 365 days. A fixed recent-log
  // window therefore loses the only authenticated argument bytes while the
  // dispute is still live. Locate the first possible block by the signed
  // start timestamp, then query bounded chunks so public RPC range limits and
  // old-but-valid disputes are both handled deterministically.
  const firstPossibleBlock = await findFirstBlockAtOrAfterTimestamp(
    provider,
    latestBlock,
    account.disputeStartTimestamp,
  );
  const topic0 = DEPOSITORY_INTERFACE.getEvent('DisputeStarted')!.topicHash;
  const watchedTopic = ethers.zeroPadValue(watch.watchedEntityId, 32).toLowerCase();
  const counterpartyTopic = ethers.zeroPadValue(watch.counterentity, 32).toLowerCase();
  const matching: ActiveDisputeContext[] = [];
  const logChunkBlocks = 20_000;
  for (
    let fromBlock = firstPossibleBlock;
    fromBlock <= latestBlock && matching.length === 0;
    fromBlock += logChunkBlocks
  ) {
    const toBlock = Math.min(latestBlock, fromBlock + logChunkBlocks - 1);
    const topicPairs = [
      [watchedTopic, counterpartyTopic],
      [counterpartyTopic, watchedTopic],
    ] as const;
    for (const [senderTopic, counterentityTopic] of topicPairs) {
      const logs = await readAdaptiveWatchtowerLogs(provider, {
        fromBlock,
        toBlock,
        address: watch.depositoryAddress,
        topics: [topic0, senderTopic, counterentityTopic],
      });
      for (const entry of logs) {
        const parsed = DEPOSITORY_INTERFACE.parseLog({
          topics: (entry['topics'] || []) as string[],
          data: String(entry['data'] || '0x'),
        });
        if (!parsed || parsed.name !== 'DisputeStarted') continue;
        const sender = String(parsed.args[0]).toLowerCase();
        const counterentity = String(parsed.args[1]).toLowerCase();
        if (!(
          (sender === watch.watchedEntityId.toLowerCase() && counterentity === watch.counterentity.toLowerCase())
          || (sender === watch.counterentity.toLowerCase() && counterentity === watch.watchedEntityId.toLowerCase())
        )) {
          continue;
        }
        const initialNonce = uint256ToSafeNumber(parsed.args[2], 'EVENT_NONCE');
        const initialProposerIsLeft = Boolean(parsed.args[3]);
        const initialProofbodyHash = String(parsed.args[4]).toLowerCase();
        const watchSeed = normalizeHex32(parsed.args[5], 'EVENT_WATCH_SEED');
        const starterInitialArguments = String(parsed.args[6] || '0x');
        const starterCounterArguments = String(parsed.args[7] || '0x');
        const starterCounterProofCommitment = String(parsed.args[8]).toLowerCase();
        const eventDisputeTimeout = BigInt(parsed.args[9]);
        const eventDisputeStartTimestamp = BigInt(parsed.args[10]);
        const eventLeftResponseSeconds = BigInt(parsed.args[11]);
        const eventRightResponseSeconds = BigInt(parsed.args[12]);
        const startedByLeft = sender < counterentity;
        const disputeStartTimestamp = account.disputeStartTimestamp;
        if (
          initialNonce !== uint256ToSafeNumber(account.nonce, 'ACCOUNT_NONCE') ||
          initialProofbodyHash !== account.disputeInitialProofbodyHash.toLowerCase() ||
          initialProposerIsLeft !== account.disputeInitialProposerIsLeft ||
          eventDisputeTimeout !== account.disputeTimeout ||
          eventDisputeStartTimestamp !== disputeStartTimestamp ||
          eventLeftResponseSeconds !== account.leftResponseSeconds ||
          eventRightResponseSeconds !== account.rightResponseSeconds ||
          startedByLeft !== account.disputeStartedByLeft
        ) continue;
        const initialCommitment = disputeArgumentCommitment(
          starterInitialArguments,
          startedByLeft,
          disputeStartTimestamp,
        );
        const counterCommitment = disputeArgumentCommitment(
          starterCounterArguments,
          startedByLeft,
          disputeStartTimestamp,
        );
        if (
          initialCommitment.toLowerCase() !== account.starterInitialArgumentsCommitment.toLowerCase() ||
          counterCommitment.toLowerCase() !== account.starterCounterArgumentsCommitment.toLowerCase()
          || starterCounterProofCommitment !== account.starterCounterProofCommitment.toLowerCase()
        ) continue;
        if (encodeDisputeHash(
          initialNonce,
          startedByLeft,
          initialProposerIsLeft,
          account.disputeTimeout,
          account.leftResponseSeconds,
          account.rightResponseSeconds,
          initialProofbodyHash,
          disputeStartTimestamp,
          initialCommitment,
          counterCommitment,
          account.starterCounterProofCommitment,
          account.disputeCounterNonce,
          account.disputeCounterProofbodyHash,
          account.disputeCounterProposerIsLeft,
        ) !== account.disputeHash.toLowerCase()) {
          continue;
        }
        matching.push({
          initialNonce,
          initialProofbodyHash,
          watchSeed,
          starterInitialArguments,
          starterCounterArguments,
          starterCounterProofCommitment,
          startedByLeft,
          initialProposerIsLeft,
        });
      }
    }
  }
  const latest = matching.sort((left, right) => right.initialNonce - left.initialNonce)[0];
  if (!latest) {
    throw new Error('WATCHTOWER_ACTIVE_DISPUTE_CONTEXT_NOT_FOUND');
  }
  return latest;
};

const assertAppointmentMatchesRemedy = (
  appointment: LastResortTowerAppointment,
  watch: TowerLastResortWatchV1,
  remedy: TowerCounterDisputeRemedy,
): void => {
  assertLastResortPayloadBasics(appointment);
  if (appointment.lastResortPayload.appointmentSequence !== remedy.appointmentSequence) {
    throw new Error(
      `WATCHTOWER_APPOINTMENT_SEQUENCE_MISMATCH:${appointment.lastResortPayload.appointmentSequence}:${remedy.appointmentSequence}`,
    );
  }
  if (appointment.lastResortPayload.proofNonce !== remedy.latestProof.finalNonce) {
    throw new Error(
      `WATCHTOWER_PROOF_NONCE_MISMATCH:${appointment.lastResortPayload.proofNonce}:${remedy.latestProof.finalNonce}`,
    );
  }
  if (appointment.lastResortPayload.lastResortWindowSeconds !== remedy.lastResortWindowSeconds) {
    throw new Error(
      `WATCHTOWER_LAST_RESORT_WINDOW_MISMATCH:${appointment.lastResortPayload.lastResortWindowSeconds}:${remedy.lastResortWindowSeconds}`,
    );
  }
  if (normalizeRpcUrl(remedy.rpcUrl) !== watch.rpcUrl) {
    throw new Error(`WATCHTOWER_REMEDY_RPC_MISMATCH:${remedy.rpcUrl}:${watch.rpcUrl}`);
  }
  if (remedy.chainId !== watch.chainId) {
    throw new Error(`WATCHTOWER_REMEDY_CHAIN_ID_MISMATCH:${remedy.chainId}:${watch.chainId}`);
  }
  if (remedy.depositoryAddress.toLowerCase() !== watch.depositoryAddress) {
    throw new Error(`WATCHTOWER_REMEDY_DEPOSITORY_MISMATCH:${remedy.depositoryAddress}:${watch.depositoryAddress}`);
  }
  if (remedy.watchedEntityId.toLowerCase() !== watch.watchedEntityId) {
    throw new Error(`WATCHTOWER_REMEDY_ENTITY_MISMATCH:${remedy.watchedEntityId}:${watch.watchedEntityId}`);
  }
  if (remedy.latestProof.counterentity.toLowerCase() !== watch.counterentity) {
    throw new Error(`WATCHTOWER_REMEDY_COUNTERENTITY_MISMATCH:${remedy.latestProof.counterentity}:${watch.counterentity}`);
  }
  const finalProofBodyHash = computeProofBodyHash(remedy.latestProof.finalProofbody);
  if (appointment.lastResortPayload.proofBodyHash.toLowerCase() !== finalProofBodyHash) {
    throw new Error(`WATCHTOWER_PROOF_BODY_HASH_MISMATCH:${appointment.lastResortPayload.proofBodyHash}:${finalProofBodyHash}`);
  }
};

const assertDisputeContextMatchesRemedy = (
  disputeContext: ActiveDisputeContext,
  remedy: TowerCounterDisputeRemedy,
): void => {
  const finalWatchSeed = normalizeHex32(remedy.latestProof.finalProofbody['watchSeed'], 'FINAL_PROOFBODY_WATCH_SEED');
  if (finalWatchSeed !== disputeContext.watchSeed) {
    throw new Error(`WATCHTOWER_WATCH_SEED_MISMATCH:${disputeContext.watchSeed}:${finalWatchSeed}`);
  }
};

const buildActionReceipt = (
  lookupKey: string,
  runtimeId: string,
  triggerHint: string,
  appointmentSequence: number,
  status: StoredTowerActionReceipt['status'],
  now: number,
  error?: string,
  txHash?: string,
  blockNumber?: number,
): StoredTowerActionReceipt => ({
  id: `${lookupKey}:${appointmentSequence}:${now}:${status}`,
  lookupKey,
  runtimeId,
  towerMode: 'delayed_last_resort',
  actionKind: 'counter_dispute_only',
  triggerHint,
  appointmentSequence,
  ...(txHash ? { txHash } : {}),
  ...(blockNumber !== undefined ? { blockNumber } : {}),
  ...(error ? { error } : {}),
  status,
  createdAt: now,
});

type SweepProviderFactory = NonNullable<WatchtowerSweepOptions['providerFactory']>;
type SweepContractFactory = NonNullable<WatchtowerSweepOptions['contractFactory']>;

type WatchtowerSweepContext = {
  store: WatchtowerStore;
  towerWallet: Wallet;
  txWaitTimeoutMs: number;
  customProviderFactory: boolean;
  allowedRpcUrls?: string[];
  providerFactory: SweepProviderFactory;
  contractFactory: SweepContractFactory;
};

const appendAppointmentReceipt = (
  context: WatchtowerSweepContext,
  appointment: LastResortTowerAppointment,
  createdAt: number,
  status: StoredTowerActionReceipt['status'],
  error?: string,
  txHash?: string,
  blockNumber?: number,
): Promise<void> => context.store.appendActionReceipt(buildActionReceipt(
  appointment.lookupKey,
  appointment.runtimeId,
  appointment.lastResortPayload.triggerHint,
  appointment.lastResortPayload.appointmentSequence,
  status,
  createdAt,
  error,
  txHash,
  blockNumber,
));

const processLastResortAppointment = async (
  context: WatchtowerSweepContext,
  appointment: LastResortTowerAppointment,
  createdAt: number,
): Promise<'submitted' | 'skipped'> => {
  assertLastResortPayloadBasics(appointment);
  const watch = normalizeWatch(appointment.lastResortPayload.watch);
  const rpcUrl = context.customProviderFactory
    ? watch.rpcUrl
    : assertWatchtowerRpcUrlAllowed(watch.rpcUrl, context.allowedRpcUrls);
  const provider = context.providerFactory(rpcUrl, watch.chainId);
  const depository = context.contractFactory(watch, context.towerWallet, provider);
  const acctKey = await depository.accountKey(watch.watchedEntityId, watch.counterentity);
  const account = await depository._accounts(acctKey);
  const currentBlockNumber = await readProviderBlockNumber(provider);
  const currentBlock = BigInt(currentBlockNumber);
  // Resolve timestamp by concrete block number. JsonRpcProvider can cache
  // getBlock('latest') across mines/time jumps on a reused provider instance.
  const currentTimestamp = await readProviderBlockTimestamp(provider, currentBlockNumber);
  // Matches Depository.watchtowerCounterDispute: lastResortWindowSeconds is seconds
  // on the same clock as absolute unix disputeTimeout.
  const disputeTimeout = BigInt(account.disputeTimeout || 0n);
  const activeDispute = String(account.disputeHash || '').toLowerCase() !== ZERO_HASH;
  const finalNonce = BigInt(appointment.lastResortPayload.proofNonce);
  const withinLastResort =
    currentTimestamp + BigInt(appointment.lastResortPayload.lastResortWindowSeconds) >= disputeTimeout;
  if (!activeDispute || !withinLastResort) {
    await appendAppointmentReceipt(context, appointment, createdAt, 'skipped');
    return 'skipped';
  }

  const disputeContext = await findActiveDisputeContext(
    provider,
    watch,
    account,
    currentBlock,
  );
  const remedy = await decodeTowerCounterDisputeRemedy(
    appointment.lastResortPayload.encryptedRemedy,
    disputeContext.watchSeed,
  );
  assertAppointmentMatchesRemedy(appointment, watch, remedy);
  assertDisputeContextMatchesRemedy(disputeContext, remedy);
  const accountNonce = BigInt(account.nonce || 0n);
  const equalNonceLeftOverride =
    finalNonce === accountNonce
    && remedy.latestProof.proposerIsLeft
    && !Boolean(account.disputeInitialProposerIsLeft);
  // Mirror Account._registerCounterDispute exactly: a higher nonce wins, and
  // at equal nonce the signed LEFT branch beats an active RIGHT branch. The
  // old >= shortcut silently skipped the one equal-nonce remedy that matters.
  if (finalNonce < accountNonce || (finalNonce === accountNonce && !equalNonceLeftOverride)) {
    await appendAppointmentReceipt(context, appointment, createdAt, 'skipped');
    return 'skipped';
  }
  if (remedy.towerAddress.toLowerCase() !== context.towerWallet.address.toLowerCase()) {
    throw new Error(
      `WATCHTOWER_ADDRESS_MISMATCH:${remedy.towerAddress}:${context.towerWallet.address.toLowerCase()}`,
    );
  }

  // Solidity binds the counter-dispute to the side recorded in
  // DisputeStarted. The appointment stores the watched/finalizer side only,
  // so the event—not a locally guessed left/right role—selects peer arguments.
  const otherArguments = disputeContext.startedByLeft
    ? remedy.latestProof.rightArguments
    : remedy.latestProof.leftArguments;
  const remedyProofCommitment = ethers.keccak256(ABI_CODER.encode(
    ['uint256', 'bool', 'bytes32'],
    [
      remedy.latestProof.finalNonce,
      remedy.latestProof.proposerIsLeft,
      computeProofBodyHash(remedy.latestProof.finalProofbody),
    ],
  ));
  const starterArguments = remedyProofCommitment.toLowerCase() ===
    disputeContext.starterCounterProofCommitment.toLowerCase()
    ? disputeContext.starterCounterArguments
    : '0x';
  const tx = await depository.watchtowerCounterDispute(
    remedy.watchedEntityId,
    {
      counterentity: remedy.latestProof.counterentity,
      initialNonce: disputeContext.initialNonce,
      finalNonce: remedy.latestProof.finalNonce,
      proposerIsLeft: remedy.latestProof.proposerIsLeft,
      initialProofbodyHash: disputeContext.initialProofbodyHash,
      finalProofbody: remedy.latestProof.finalProofbody,
      starterArguments,
      otherArguments,
      sig: remedy.latestProof.sig,
      startedByLeft: disputeContext.startedByLeft,
      cooperative: false,
    },
    remedy.lastResortWindowSeconds,
    remedy.appointmentSequence,
    remedy.ownerAuthorizationHanko,
  );
  const receipt = await waitForReceiptWithTimeout(tx, context.txWaitTimeoutMs);
  await appendAppointmentReceipt(
    context,
    appointment,
    createdAt,
    'submitted',
    undefined,
    String(tx.hash || ''),
    Number(receipt?.blockNumber || 0),
  );
  return 'submitted';
};

export const runWatchtowerSweep = async (
  store: WatchtowerStore,
  options?: WatchtowerSweepOptions,
): Promise<{ scanned: number; submitted: number; skipped: number; errors: number }> => {
  const towerPrivateKey = String(
    options?.towerPrivateKey
    || process.env['XLN_WATCHTOWER_PRIVATE_KEY']
    || '',
  ).trim();
  if (!towerPrivateKey) {
    throw new Error('WATCHTOWER_PRIVATE_KEY_REQUIRED');
  }
  const towerWallet = new Wallet(towerPrivateKey);
  const now = options?.now || (() => Date.now());
  const txWaitTimeoutMs = Math.max(0, Math.floor(Number(options?.txWaitTimeoutMs ?? 15_000)));
  const lastResortAppointments = (await store.listLatestLastResortAppointments())
    .filter((appointment) => appointment.towerMode === 'delayed_last_resort')
    .filter((appointment) => !options?.lookupKey || appointment.lookupKey === options.lookupKey);

  let submitted = 0;
  let skipped = 0;
  let errors = 0;
  const customProviderFactory = options?.providerFactory;
  const providerFactory: SweepProviderFactory = customProviderFactory
    || ((rpcUrl: string, chainId: number) => createXlnJsonRpcProvider(rpcUrl, chainId));
  const defaultContractFactory: SweepContractFactory = (target, wallet, provider) => {
    if (!(provider instanceof JsonRpcProvider)) {
      throw new Error('WATCHTOWER_JSON_RPC_PROVIDER_REQUIRED');
    }
    return Depository__factory.connect(
      target.depositoryAddress,
      wallet.connect(provider),
    );
  };
  const contractFactory = options?.contractFactory ?? defaultContractFactory;
  const context: WatchtowerSweepContext = {
    store,
    towerWallet,
    txWaitTimeoutMs,
    customProviderFactory: Boolean(customProviderFactory),
    ...(options?.allowedRpcUrls ? { allowedRpcUrls: options.allowedRpcUrls } : {}),
    providerFactory,
    contractFactory,
  };

  for (const appointment of lastResortAppointments) {
    const createdAt = now();
    try {
      const result = await processLastResortAppointment(context, appointment, createdAt);
      if (result === 'submitted') submitted += 1;
      else skipped += 1;
    } catch (error) {
      await appendAppointmentReceipt(
        context,
        appointment,
        createdAt,
        'error',
        error instanceof Error ? error.message : String(error),
      );
      errors += 1;
    }
  }

  return {
    scanned: lastResortAppointments.length,
    submitted,
    skipped,
    errors,
  };
};
