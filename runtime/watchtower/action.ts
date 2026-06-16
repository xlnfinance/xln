import { Contract, Interface, JsonRpcProvider, Wallet, ethers } from 'ethers';
import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';
import { createXlnJsonRpcProvider } from '../jadapter';
import type {
  TowerCounterDisputeRemedy,
  TowerFinalDisputeProof,
  TowerLastResortWatchV1,
} from '../recovery/types';
import { decryptTowerPayloadWithWatchSeed } from '../recovery/crypto';
import type { LastResortTowerAppointment, WatchtowerStore, StoredTowerActionReceipt } from './store';

const DEPOSITORY_MINIMAL_ABI = [
  'function accountKey(bytes32 e1, bytes32 e2) view returns (bytes)',
  'function defaultDisputeDelay() view returns (uint256)',
  'function _accounts(bytes acctKey) view returns (uint256 nonce, bytes32 disputeHash, uint256 disputeTimeout, uint256 disputeStartTimestamp)',
  'function watchtowerCounterDispute(bytes32 entityId, (bytes32 counterentity,uint256 initialNonce,uint256 finalNonce,bytes32 initialProofbodyHash,(bytes32 watchSeed,int256[] offdeltas,uint256[] tokenIds,(address transformerAddress,bytes encodedBatch,(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers) finalProofbody,bytes leftArguments,bytes rightArguments,bytes starterInitialArguments,bytes starterIncrementedArguments,bytes sig,bool startedByLeft,uint256 disputeUntilBlock,bool cooperative) params, uint256 lastResortWindowBlocks, uint256 appointmentSequence, bytes ownerAuthorizationHanko) returns (bool)',
  'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes32 watchSeed, bytes starterInitialArguments, bytes starterIncrementedArguments)',
] as const;

const DEPOSITORY_INTERFACE = new Interface(DEPOSITORY_MINIMAL_ABI);
const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();
const PROOF_BODY_PARAM = ethers.ParamType.from(
  'tuple(bytes32 watchSeed,int256[] offdeltas,uint256[] tokenIds,tuple(address transformerAddress,bytes encodedBatch,tuple(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers)',
);
const ZERO_HASH = ethers.ZeroHash.toLowerCase();

type WatchtowerLog = { topics: readonly string[]; data: string };
type WatchtowerSweepProvider = {
  getBlockNumber: () => Promise<number>;
  getLogs?: (filter: Record<string, unknown>) => Promise<WatchtowerLog[]>;
};

const isHexLike = (value: unknown, length?: number): value is string => {
  if (typeof value !== 'string' || !value.startsWith('0x')) return false;
  if (length !== undefined && value.length !== length) return false;
  return true;
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
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`WATCHTOWER_REMEDY_${label}_INVALID`);
  return Math.floor(number);
};

const normalizeFinalDisputeProof = (value: unknown): TowerFinalDisputeProof => {
  const candidate = value as Record<string, unknown>;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('WATCHTOWER_REMEDY_FINALIZATION_INVALID');
  }
  const proofBody = candidate['finalProofbody'];
  if (!proofBody || typeof proofBody !== 'object') throw new Error('WATCHTOWER_REMEDY_FINAL_PROOFBODY_INVALID');
  const normalizedProofBody = structuredClone(proofBody as Record<string, unknown>);
  normalizedProofBody['watchSeed'] = normalizeHex32(normalizedProofBody['watchSeed'], 'FINAL_PROOFBODY_WATCH_SEED');
  return {
    counterentity: normalizeHex32(candidate['counterentity'], 'COUNTERENTITY'),
    finalNonce: toInt(candidate['finalNonce'], 'FINAL_NONCE'),
    finalProofbody: normalizedProofBody,
    leftArguments: isHexLike(candidate['leftArguments']) ? String(candidate['leftArguments']) : '0x',
    rightArguments: isHexLike(candidate['rightArguments']) ? String(candidate['rightArguments']) : '0x',
    starterIncrementedArguments: isHexLike(candidate['starterIncrementedArguments']) ? String(candidate['starterIncrementedArguments']) : '0x',
    sig: isHexLike(candidate['sig']) ? String(candidate['sig']) : '0x',
  };
};

const computeProofBodyHash = (proofBody: Record<string, unknown>): string =>
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
    lastResortWindowBlocks: toInt(parsed['lastResortWindowBlocks'], 'LAST_RESORT_WINDOW_BLOCKS'),
    appointmentSequence: toInt(parsed['appointmentSequence'], 'APPOINTMENT_SEQUENCE'),
    ownerAuthorizationHanko: isHexLike(parsed['ownerAuthorizationHanko']) ? String(parsed['ownerAuthorizationHanko']) : '0x',
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
  if (Math.max(0, Math.floor(Number(payload.appointmentSequence || 0))) <= 0) {
    throw new Error('WATCHTOWER_APPOINTMENT_SEQUENCE_INVALID');
  }
  if (Math.max(0, Math.floor(Number(payload.proofNonce || 0))) <= 0) {
    throw new Error('WATCHTOWER_PROOF_NONCE_INVALID');
  }
  normalizeHex32(payload.proofBodyHash, 'PROOF_BODY_HASH');
  if (Math.max(0, Math.floor(Number(payload.lastResortWindowBlocks || 0))) <= 0) {
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
      disputeStartTimestamp?: bigint;
    }>;
    defaultDisputeDelay?: () => Promise<bigint>;
    watchtowerCounterDispute: (
      entityId: string,
      finalization: {
        counterentity: string;
        initialNonce: number;
        finalNonce: number;
        initialProofbodyHash: string;
        finalProofbody: Record<string, unknown>;
        leftArguments: string;
        rightArguments: string;
        starterInitialArguments: string;
        starterIncrementedArguments: string;
        sig: string;
        startedByLeft: boolean;
        disputeUntilBlock: number;
        cooperative: boolean;
      },
      lastResortWindowBlocks: number,
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
  starterIncrementedArguments: string;
  startedByLeft: boolean;
  disputeUntilBlock: number;
};

const encodeDisputeHash = (
  initialNonce: number,
  startedByLeft: boolean,
  disputeTimeout: bigint,
  initialProofbodyHash: string,
  starterInitialArguments: string,
  starterIncrementedArguments: string,
): string => ethers.keccak256(
  ethers.solidityPacked(
    ['uint256', 'bool', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
    [
      BigInt(initialNonce),
      startedByLeft,
      disputeTimeout,
      initialProofbodyHash,
      ethers.keccak256(starterInitialArguments),
      ethers.keccak256(starterIncrementedArguments),
    ],
  ),
);

const findActiveDisputeContext = async (
  provider: Pick<WatchtowerSweepProvider, 'getLogs'>,
  watch: TowerLastResortWatchV1,
  disputeHash: string,
  currentBlock: bigint,
  disputeTimeout: bigint,
  fromBlockHint?: bigint,
): Promise<ActiveDisputeContext> => {
  if (typeof provider.getLogs !== 'function') {
    throw new Error('WATCHTOWER_PROVIDER_GET_LOGS_UNAVAILABLE');
  }
  const latestBlock = Math.max(0, Math.min(Number(currentBlock), Number(disputeTimeout)));
  const hintedFromBlock = Number(fromBlockHint || 0n);
  const fromBlock = Number.isFinite(hintedFromBlock) && hintedFromBlock > 0
    ? Math.max(0, Math.floor(hintedFromBlock))
    : Math.max(0, latestBlock - 20_000);
  const topic0 = DEPOSITORY_INTERFACE.getEvent('DisputeStarted')!.topicHash;
  const watchedTopic = ethers.zeroPadValue(watch.watchedEntityId, 32).toLowerCase();
  const counterpartyTopic = ethers.zeroPadValue(watch.counterentity, 32).toLowerCase();
  const queries = [
    { fromBlock, toBlock: latestBlock, address: watch.depositoryAddress, topics: [topic0, watchedTopic, counterpartyTopic] },
    { fromBlock, toBlock: latestBlock, address: watch.depositoryAddress, topics: [topic0, counterpartyTopic, watchedTopic] },
  ];
  const matching: ActiveDisputeContext[] = [];
  for (const query of queries) {
    const logs = await provider.getLogs(query);
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
      const initialNonce = Number(parsed.args[2]);
      const initialProofbodyHash = String(parsed.args[3]).toLowerCase();
      const watchSeed = normalizeHex32(parsed.args[4], 'EVENT_WATCH_SEED');
      const starterInitialArguments = String(parsed.args[5] || '0x');
      const starterIncrementedArguments = String(parsed.args[6] || '0x');
      const startedByLeft = sender < counterentity;
      if (encodeDisputeHash(
        initialNonce,
        startedByLeft,
        disputeTimeout,
        initialProofbodyHash,
        starterInitialArguments,
        starterIncrementedArguments,
      ) !== disputeHash.toLowerCase()) {
        continue;
      }
      matching.push({
        initialNonce,
        initialProofbodyHash,
        watchSeed,
        starterInitialArguments,
        starterIncrementedArguments,
        startedByLeft,
        disputeUntilBlock: Number(disputeTimeout),
      });
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
  if (appointment.lastResortPayload.lastResortWindowBlocks !== remedy.lastResortWindowBlocks) {
    throw new Error(
      `WATCHTOWER_LAST_RESORT_WINDOW_MISMATCH:${appointment.lastResortPayload.lastResortWindowBlocks}:${remedy.lastResortWindowBlocks}`,
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
  const providerFactory = customProviderFactory || ((rpcUrl: string, chainId: number) => createXlnJsonRpcProvider(rpcUrl, chainId));
  const contractFactory = options?.contractFactory || ((target, wallet, provider) =>
    new Contract(target.depositoryAddress, DEPOSITORY_MINIMAL_ABI, wallet.connect(provider as unknown as JsonRpcProvider)));

  for (const appointment of lastResortAppointments) {
    const createdAt = now();
    try {
      assertLastResortPayloadBasics(appointment);
      const watch = normalizeWatch(appointment.lastResortPayload.watch);
      const rpcUrl = customProviderFactory
        ? watch.rpcUrl
        : assertWatchtowerRpcUrlAllowed(watch.rpcUrl, options?.allowedRpcUrls);
      const provider = providerFactory(rpcUrl, watch.chainId);
      const depository = contractFactory(watch, towerWallet, provider);
      const acctKey = await depository.accountKey(watch.watchedEntityId, watch.counterentity) as string;
      const account = await depository._accounts(acctKey) as {
        nonce: bigint;
        disputeHash: string;
        disputeTimeout: bigint;
        disputeStartTimestamp?: bigint;
      };
      const currentBlock = BigInt(await provider.getBlockNumber());
      const disputeTimeout = BigInt(account.disputeTimeout || 0n);
      const activeDispute = String(account.disputeHash || '').toLowerCase() !== ZERO_HASH;
      const finalNonce = BigInt(appointment.lastResortPayload.proofNonce);
      const withinLastResort = currentBlock + BigInt(appointment.lastResortPayload.lastResortWindowBlocks) >= disputeTimeout;
      if (!activeDispute || !withinLastResort || BigInt(account.nonce || 0n) >= finalNonce) {
        await store.appendActionReceipt(
          buildActionReceipt(
            appointment.lookupKey,
            appointment.runtimeId,
            appointment.lastResortPayload.triggerHint,
            appointment.lastResortPayload.appointmentSequence,
            'skipped',
            createdAt,
          ),
        );
        skipped += 1;
        continue;
      }
      let disputeStartBlock: bigint | undefined;
      if (typeof depository.defaultDisputeDelay === 'function') {
        try {
          const disputeDelay = BigInt(await depository.defaultDisputeDelay());
          if (disputeDelay > 0n && disputeTimeout >= disputeDelay) {
            disputeStartBlock = disputeTimeout - disputeDelay;
          }
        } catch {
          disputeStartBlock = undefined;
        }
      }
      const disputeContext = await findActiveDisputeContext(
        provider,
        watch,
        String(account.disputeHash || '0x'),
        currentBlock,
        disputeTimeout,
        disputeStartBlock,
      );
      const remedy = await decodeTowerCounterDisputeRemedy(
        appointment.lastResortPayload.encryptedRemedy,
        disputeContext.watchSeed,
      );
      assertAppointmentMatchesRemedy(appointment, watch, remedy);
      assertDisputeContextMatchesRemedy(disputeContext, remedy);
      if (remedy.towerAddress.toLowerCase() !== towerWallet.address.toLowerCase()) {
        await store.appendActionReceipt(
          buildActionReceipt(
            appointment.lookupKey,
            appointment.runtimeId,
            appointment.lastResortPayload.triggerHint,
            appointment.lastResortPayload.appointmentSequence,
            'error',
            createdAt,
            `WATCHTOWER_ADDRESS_MISMATCH:${remedy.towerAddress}:${towerWallet.address.toLowerCase()}`,
          ),
        );
        errors += 1;
        continue;
      }
      // In counter-dispute mode Solidity requires the starter side to equal the
      // blob committed in DisputeStarted. The tower remedy intentionally stores
      // only the watched/finalizer side because the tower learns the actual
      // starter side from the event. Reusing remedy.left/right blindly can make a
      // valid transformer counter-dispute fail Account.requireStarterArguments.
      const leftArguments = disputeContext.startedByLeft
        ? disputeContext.starterIncrementedArguments
        : remedy.latestProof.leftArguments;
      const rightArguments = disputeContext.startedByLeft
        ? remedy.latestProof.rightArguments
        : disputeContext.starterIncrementedArguments;
      const finalization = {
        counterentity: remedy.latestProof.counterentity,
        initialNonce: disputeContext.initialNonce,
        finalNonce: remedy.latestProof.finalNonce,
        initialProofbodyHash: disputeContext.initialProofbodyHash,
        finalProofbody: remedy.latestProof.finalProofbody,
        leftArguments,
        rightArguments,
        starterInitialArguments: disputeContext.starterInitialArguments,
        starterIncrementedArguments: disputeContext.starterIncrementedArguments,
        sig: remedy.latestProof.sig,
        startedByLeft: disputeContext.startedByLeft,
        disputeUntilBlock: disputeContext.disputeUntilBlock,
        cooperative: false,
      };

      const tx = await depository.watchtowerCounterDispute(
        remedy.watchedEntityId,
        finalization,
        remedy.lastResortWindowBlocks,
        remedy.appointmentSequence,
        remedy.ownerAuthorizationHanko,
      );
      const receipt = await waitForReceiptWithTimeout(tx, txWaitTimeoutMs);
      await store.appendActionReceipt(
        buildActionReceipt(
          appointment.lookupKey,
          appointment.runtimeId,
          appointment.lastResortPayload.triggerHint,
          appointment.lastResortPayload.appointmentSequence,
          'submitted',
          createdAt,
          undefined,
          String(tx.hash || ''),
          Number(receipt?.blockNumber || 0),
        ),
      );
      submitted += 1;
    } catch (error) {
      await store.appendActionReceipt(
        buildActionReceipt(
          appointment.lookupKey,
          appointment.runtimeId,
          appointment.lastResortPayload.triggerHint,
          appointment.lastResortPayload.appointmentSequence,
          'error',
          createdAt,
          error instanceof Error ? error.message : String(error),
        ),
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
