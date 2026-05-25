import { Contract, Interface, JsonRpcProvider, Wallet, ethers } from 'ethers';
import { serializeTaggedJson } from '../serialization-utils';
import type {
  TowerCounterDisputeRemedyV1,
  TowerFinalDisputeProofV1,
} from '../recovery/types';
import type { WatchtowerStore, StoredTowerActionReceipt } from './store';

const DEPOSITORY_MINIMAL_ABI = [
  'function accountKey(bytes32 e1, bytes32 e2) view returns (bytes)',
  'function _accounts(bytes acctKey) view returns (uint256 nonce, bytes32 disputeHash, uint256 disputeTimeout, uint256 disputeStartTimestamp)',
  'function watchtowerCounterDispute(bytes32 entityId, (bytes32 counterentity,uint256 initialNonce,uint256 finalNonce,bytes32 initialProofbodyHash,(int256[] offdeltas,uint256[] tokenIds,(address transformerAddress,bytes encodedBatch,(uint256 deltaIndex,uint256 rightAllowance,uint256 leftAllowance)[] allowances)[] transformers) finalProofbody,bytes finalArguments,bytes initialArguments,bytes sig,bool startedByLeft,uint256 disputeUntilBlock,bool cooperative) params, uint256 lastResortWindowBlocks, uint256 appointmentSequence, bytes ownerAuthorizationHanko) returns (bool)',
  'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bytes32 proofbodyHash, bytes initialArguments)',
] as const;

const DEPOSITORY_INTERFACE = new Interface(DEPOSITORY_MINIMAL_ABI);

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

const normalizeFinalDisputeProof = (value: unknown): TowerFinalDisputeProofV1 => {
  const candidate = value as Record<string, unknown>;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('WATCHTOWER_REMEDY_FINALIZATION_INVALID');
  }
  return {
    counterentity: normalizeHex32(candidate['counterentity'], 'COUNTERENTITY'),
    finalNonce: toInt(candidate['finalNonce'], 'FINAL_NONCE'),
    finalProofbody: (() => {
      const proofBody = candidate['finalProofbody'];
      if (!proofBody || typeof proofBody !== 'object') throw new Error('WATCHTOWER_REMEDY_FINAL_PROOFBODY_INVALID');
      return structuredClone(proofBody as Record<string, unknown>);
    })(),
    finalArguments: isHexLike(candidate['finalArguments']) ? String(candidate['finalArguments']) : '0x',
    sig: isHexLike(candidate['sig']) ? String(candidate['sig']) : '0x',
  };
};

export const encodeTowerCounterDisputeRemedy = (remedy: TowerCounterDisputeRemedyV1): string =>
  serializeTaggedJson(remedy);

export const decodeTowerCounterDisputeRemedy = (payload: string): TowerCounterDisputeRemedyV1 => {
  const raw = String(payload || '').trim();
  if (!raw) throw new Error('WATCHTOWER_REMEDY_EMPTY');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
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

type WatchtowerSweepOptions = {
  lookupKey?: string;
  towerPrivateKey?: string;
  now?: () => number;
  providerFactory?: (rpcUrl: string, chainId: number) => {
    getBlockNumber: () => Promise<number>;
    getLogs?: (filter: Record<string, unknown>) => Promise<WatchtowerLog[]>;
  } | JsonRpcProvider;
  contractFactory?: (
    remedy: TowerCounterDisputeRemedyV1,
    towerWallet: Wallet,
    provider: WatchtowerSweepProvider | JsonRpcProvider,
  ) => {
    accountKey: (entityId: string, counterentity: string) => Promise<string>;
    _accounts: (acctKey: string) => Promise<{ nonce: bigint; disputeHash: string; disputeTimeout: bigint }>;
    watchtowerCounterDispute: (
      entityId: string,
      finalization: {
        counterentity: string;
        initialNonce: number;
        finalNonce: number;
        initialProofbodyHash: string;
        finalProofbody: Record<string, unknown>;
        finalArguments: string;
        initialArguments: string;
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

type ActiveDisputeContext = {
  initialNonce: number;
  initialProofbodyHash: string;
  initialArguments: string;
  startedByLeft: boolean;
  disputeUntilBlock: number;
};

const encodeDisputeHash = (
  initialNonce: number,
  startedByLeft: boolean,
  disputeTimeout: bigint,
  initialProofbodyHash: string,
  initialArguments: string,
): string => ethers.keccak256(
  ethers.solidityPacked(
    ['uint256', 'bool', 'uint256', 'bytes32', 'bytes32'],
    [
      BigInt(initialNonce),
      startedByLeft,
      disputeTimeout,
      initialProofbodyHash,
      ethers.keccak256(initialArguments),
    ],
  ),
);

const findActiveDisputeContext = async (
  provider: Pick<WatchtowerSweepProvider, 'getLogs'>,
  remedy: TowerCounterDisputeRemedyV1,
  disputeHash: string,
  disputeTimeout: bigint,
): Promise<ActiveDisputeContext> => {
  if (typeof provider.getLogs !== 'function') {
    throw new Error('WATCHTOWER_PROVIDER_GET_LOGS_UNAVAILABLE');
  }
  const latestBlock = Number(disputeTimeout);
  const fromBlock = Math.max(0, latestBlock - 20_000);
  const topic0 = DEPOSITORY_INTERFACE.getEvent('DisputeStarted')!.topicHash;
  const watchedTopic = ethers.zeroPadValue(remedy.watchedEntityId, 32).toLowerCase();
  const counterpartyTopic = ethers.zeroPadValue(remedy.latestProof.counterentity, 32).toLowerCase();
  const queries = [
    { fromBlock, toBlock: latestBlock, address: remedy.depositoryAddress, topics: [topic0, watchedTopic, counterpartyTopic] },
    { fromBlock, toBlock: latestBlock, address: remedy.depositoryAddress, topics: [topic0, counterpartyTopic, watchedTopic] },
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
        (sender === remedy.watchedEntityId.toLowerCase() && counterentity === remedy.latestProof.counterentity.toLowerCase())
        || (sender === remedy.latestProof.counterentity.toLowerCase() && counterentity === remedy.watchedEntityId.toLowerCase())
      )) {
        continue;
      }
      const initialNonce = Number(parsed.args[2]);
      const initialProofbodyHash = String(parsed.args[3]).toLowerCase();
      const initialArguments = String(parsed.args[4] || '0x');
      const startedByLeft = sender < counterentity;
      if (encodeDisputeHash(initialNonce, startedByLeft, disputeTimeout, initialProofbodyHash, initialArguments) !== disputeHash.toLowerCase()) {
        continue;
      }
      matching.push({
        initialNonce,
        initialProofbodyHash,
        initialArguments,
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
  const activeAppointments = (await store.listLatestActiveAppointments())
    .filter((appointment) => appointment.towerMode === 'delayed_last_resort')
    .filter((appointment) => !options?.lookupKey || appointment.lookupKey === options.lookupKey);

  let submitted = 0;
  let skipped = 0;
  let errors = 0;
  const providerFactory = options?.providerFactory || ((rpcUrl: string, chainId: number) => new JsonRpcProvider(rpcUrl, chainId));
  const contractFactory = options?.contractFactory || ((remedy, wallet, provider) =>
    new Contract(remedy.depositoryAddress, DEPOSITORY_MINIMAL_ABI, wallet.connect(provider as unknown as JsonRpcProvider)));

  for (const appointment of activeAppointments) {
    const createdAt = now();
    try {
      const remedy = decodeTowerCounterDisputeRemedy(appointment.activePayload.encryptedRemedy);
      if (remedy.towerAddress.toLowerCase() !== towerWallet.address.toLowerCase()) {
        await store.appendActionReceipt(
          buildActionReceipt(
            appointment.lookupKey,
            appointment.runtimeId,
            appointment.activePayload.triggerHint,
            appointment.activePayload.appointmentSequence,
            'error',
            createdAt,
            `WATCHTOWER_ADDRESS_MISMATCH:${remedy.towerAddress}:${towerWallet.address.toLowerCase()}`,
          ),
        );
        errors += 1;
        continue;
      }
      const provider = providerFactory(remedy.rpcUrl, remedy.chainId);
      const depository = contractFactory(remedy, towerWallet, provider);
      const acctKey = await depository.accountKey(remedy.watchedEntityId, remedy.latestProof.counterentity) as string;
      const account = await depository._accounts(acctKey) as {
        nonce: bigint;
        disputeHash: string;
        disputeTimeout: bigint;
      };
      const currentBlock = BigInt(await provider.getBlockNumber());
      const disputeTimeout = BigInt(account.disputeTimeout || 0n);
      const activeDispute = String(account.disputeHash || '').toLowerCase() !== '0x0000000000000000000000000000000000000000000000000000000000000000';
      const finalNonce = BigInt(remedy.latestProof.finalNonce);
      const withinLastResort = currentBlock + BigInt(remedy.lastResortWindowBlocks) >= disputeTimeout;
      if (!activeDispute || !withinLastResort || BigInt(account.nonce || 0n) >= finalNonce) {
        await store.appendActionReceipt(
          buildActionReceipt(
            appointment.lookupKey,
            appointment.runtimeId,
            appointment.activePayload.triggerHint,
            appointment.activePayload.appointmentSequence,
            'skipped',
            createdAt,
          ),
        );
        skipped += 1;
        continue;
      }
      const disputeContext = await findActiveDisputeContext(provider, remedy, String(account.disputeHash || '0x'), disputeTimeout);
      const finalization = {
        counterentity: remedy.latestProof.counterentity,
        initialNonce: disputeContext.initialNonce,
        finalNonce: remedy.latestProof.finalNonce,
        initialProofbodyHash: disputeContext.initialProofbodyHash,
        finalProofbody: remedy.latestProof.finalProofbody,
        finalArguments: remedy.latestProof.finalArguments,
        initialArguments: disputeContext.initialArguments,
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
      const receipt = await tx.wait?.();
      await store.appendActionReceipt(
        buildActionReceipt(
          appointment.lookupKey,
          appointment.runtimeId,
          appointment.activePayload.triggerHint,
          appointment.activePayload.appointmentSequence,
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
          appointment.activePayload.triggerHint,
          appointment.activePayload.appointmentSequence,
          'error',
          createdAt,
          error instanceof Error ? error.message : String(error),
        ),
      );
      errors += 1;
    }
  }

  return {
    scanned: activeAppointments.length,
    submitted,
    skipped,
    errors,
  };
};
