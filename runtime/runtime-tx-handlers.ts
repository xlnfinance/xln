import type { JAdapterConfig } from './jadapter/types';
import { ensureLocalDisputeDelayConfigured } from './jadapter/local-config';
import { setBrowserVMJurisdiction } from './jadapter';
import { getSignerPrivateKey } from './account-crypto';
import { buildDefaultEntitySwapPairs, getTokenIdsForJurisdiction } from './account-utils';
import { markStorageEntityDirty } from './env-events';
import {
  deriveLocalEntityCryptoKeys,
  hasLocalSignerKey,
  resolveReplicaEntityCryptoKeys,
} from './runtime-entity-crypto';
import { normalizeEntitySwapTradingPairs } from './runtime-swap-pairs';
import {
  backfillEntityJurisdictionBinding,
  requireBoundEntityConfig,
} from './jurisdiction-runtime';
import { announceLocalEntityProfile } from './networking/gossip-helper';
import { normalizeRuntimeId } from './networking/runtime-id';
import type { EntityReplica, Env, JReplica, RuntimeTx } from './types';
import {
  DEBUG,
  formatEntityDisplay,
  formatSignerDisplay,
} from './utils';
import { logError } from './logger';

type ImportJRuntimeTx = Extract<RuntimeTx, { type: 'importJ' }>;
type ImportReplicaRuntimeTx = Extract<RuntimeTx, { type: 'importReplica' }>;

export interface RuntimeTxHandlerDeps {
  onJurisdictionImported?: (env: Env) => void;
}

export const applyRuntimeTx = async (
  env: Env,
  runtimeTx: RuntimeTx,
  deps: RuntimeTxHandlerDeps = {},
): Promise<void> => {
  if (runtimeTx.type === 'importJ') {
    await importJurisdictionRuntimeTx(env, runtimeTx, deps);
    return;
  }
  if (runtimeTx.type === 'importReplica') {
    importReplicaRuntimeTx(env, runtimeTx);
    return;
  }
  const exhaustive: never = runtimeTx;
  throw new Error(`RUNTIME_TX_UNKNOWN: ${(exhaustive as { type?: string }).type ?? 'unknown'}`);
};

const importJurisdictionRuntimeTx = async (
  env: Env,
  runtimeTx: ImportJRuntimeTx,
  deps: RuntimeTxHandlerDeps,
): Promise<void> => {
  console.log(`[Runtime] Importing J-machine "${runtimeTx.data.name}" (chain ${runtimeTx.data.chainId})...`);

  try {
    const { createJAdapter } = await import('./jadapter');
    const isBrowserVM = runtimeTx.data.rpcs.length === 0;
    const fromReplica = runtimeTx.data.contracts
      ? ({
          depositoryAddress: runtimeTx.data.contracts.depository,
          entityProviderAddress: runtimeTx.data.contracts.entityProvider,
          contracts: runtimeTx.data.contracts,
          chainId: runtimeTx.data.chainId,
        } as JReplica)
      : undefined;

    const adapterConfig: JAdapterConfig = {
      mode: isBrowserVM ? 'browservm' : 'rpc',
      chainId: runtimeTx.data.chainId,
    };
    if (!isBrowserVM) {
      const rpcUrl = runtimeTx.data.rpcs[0];
      if (!rpcUrl) throw new Error(`IMPORT_J_RPC_MISSING: name=${runtimeTx.data.name}`);
      adapterConfig.rpcUrl = rpcUrl;
      if (!fromReplica) {
        const deployerPrivateKey =
          globalThis.process?.env?.['JADAPTER_DEPLOYER_PRIVATE_KEY'] ||
          globalThis.process?.env?.['DEPLOYER_PRIVATE_KEY'];
        if (deployerPrivateKey) adapterConfig.privateKey = deployerPrivateKey;
      }
    }
    if (fromReplica) adapterConfig.fromReplica = fromReplica;

    const jadapter = await createJAdapter(adapterConfig);
    if (!fromReplica) {
      await jadapter.deployStack();
    }
    const defaultDisputeDelayBlocks = await ensureLocalDisputeDelayConfigured(jadapter, runtimeTx.data.name);

    if (isBrowserVM) {
      const browserVM = jadapter.getBrowserVM();
      if (browserVM) {
        setBrowserVMJurisdiction(env, jadapter.addresses.depository, browserVM);
      }
    }

    if (!env.jReplicas) {
      env.jReplicas = new Map();
    }

    const resolvedDepositoryAddress = jadapter.addresses.depository || '';
    const resolvedEntityProviderAddress = jadapter.addresses.entityProvider || '';
    const resolvedAccountAddress =
      jadapter.addresses.account || runtimeTx.data.contracts?.account || '';
    const resolvedDeltaTransformerAddress =
      jadapter.addresses.deltaTransformer || runtimeTx.data.contracts?.deltaTransformer || '';
    const resolvedContracts = {
      account: resolvedAccountAddress,
      depository: resolvedDepositoryAddress,
      entityProvider: resolvedEntityProviderAddress,
      deltaTransformer: resolvedDeltaTransformerAddress,
    };

    if (!resolvedDepositoryAddress || !resolvedEntityProviderAddress) {
      throw new Error(
        `IMPORT_J_ADDRESSES_MISSING: name=${runtimeTx.data.name} ` +
          `depository=${resolvedDepositoryAddress || 'none'} ` +
          `entityProvider=${resolvedEntityProviderAddress || 'none'} ` +
          `adapterAddresses=${JSON.stringify(jadapter.addresses || {})} ` +
          `contracts=${JSON.stringify(runtimeTx.data.contracts || {})}`,
      );
    }

    const stateRoot = await (jadapter.captureStateRoot?.() ?? Promise.resolve(null));
    if (isBrowserVM && !(stateRoot instanceof Uint8Array && stateRoot.length === 32)) {
      throw new Error(`IMPORT_J_STATE_ROOT_UNAVAILABLE: name=${runtimeTx.data.name} mode=browservm`);
    }

    const jReplica: JReplica = {
      name: runtimeTx.data.name,
      blockNumber: 0n,
      stateRoot,
      mempool: [],
      blockDelayMs: 300,
      ...(runtimeTx.data.blockTimeMs ? { blockTimeMs: runtimeTx.data.blockTimeMs } : {}),
      lastBlockTimestamp: env.timestamp,
      position: { x: 0, y: 50, z: 0 },
      depositoryAddress: resolvedDepositoryAddress,
      entityProviderAddress: resolvedEntityProviderAddress,
      contracts: resolvedContracts,
      rpcs: runtimeTx.data.rpcs,
      chainId: runtimeTx.data.chainId,
      ...(defaultDisputeDelayBlocks ? { defaultDisputeDelayBlocks } : {}),
      jadapter,
    };
    env.jReplicas.set(runtimeTx.data.name, jReplica);

    if (!env.activeJurisdiction) {
      env.activeJurisdiction = runtimeTx.data.name;
    }

    deps.onJurisdictionImported?.(env);
    console.log(`[Runtime] ✅ JReplica "${runtimeTx.data.name}" ready`);
  } catch (error) {
    console.error(`[Runtime] ❌ Failed to import J-machine:`, error);
    throw error;
  }
};

const importReplicaRuntimeTx = (env: Env, runtimeTx: ImportReplicaRuntimeTx): void => {
  const importedEntityId = String(runtimeTx.entityId || '').toLowerCase();
  const importedSignerId =
    normalizeRuntimeId(String(runtimeTx.signerId || '')) ||
    String(runtimeTx.signerId || '').trim().toLowerCase();
  if (!importedEntityId || !importedSignerId) {
    throw new Error(`IMPORT_REPLICA_INVALID_ID: entity=${runtimeTx.entityId} signer=${runtimeTx.signerId}`);
  }
  if (DEBUG) {
    console.log(
      `Importing replica Entity #${formatEntityDisplay(importedEntityId)}:${formatSignerDisplay(importedSignerId)} (proposer: ${runtimeTx.data.isProposer})`,
    );
  }

  const replicaKey = `${importedEntityId}:${importedSignerId}`;
  const existingMatch = findExistingReplicaCaseInsensitive(env, importedEntityId, importedSignerId);
  const config = requireBoundEntityConfig(env, importedEntityId, runtimeTx.data.config);
  backfillEntityJurisdictionBinding(env, importedEntityId, config.jurisdiction!);

  if (existingMatch) {
    const { key: existingReplicaKey, replica: existingReplica } = existingMatch;
    existingReplica.isProposer = runtimeTx.data.isProposer;
    existingReplica.entityId = importedEntityId;
    existingReplica.signerId = importedSignerId;
    existingReplica.state.entityId = importedEntityId;
    existingReplica.state.config = config;
    if (hasLocalSignerKey(env, importedSignerId)) {
      const expectedKeys = deriveLocalEntityCryptoKeys(env, importedEntityId, importedSignerId);
      if (
        existingReplica.state.entityEncPubKey !== expectedKeys.publicKey ||
        existingReplica.state.entityEncPrivKey !== expectedKeys.privateKey
      ) {
        throw new Error(`ENTITY_CRYPTO_KEY_MISMATCH: entity=${importedEntityId} signer=${importedSignerId}`);
      }
    }
    normalizeEntitySwapTradingPairs(existingReplica.state);
    if (existingReplicaKey !== replicaKey) {
      env.eReplicas.delete(existingReplicaKey);
    }
    env.eReplicas.set(replicaKey, existingReplica);
    markStorageEntityDirty(env, existingReplica.state.entityId);
    if (DEBUG) {
      console.log(
        `Skipping fresh replica init for restored entity #${formatEntityDisplay(importedEntityId)}:${formatSignerDisplay(importedSignerId)}`,
      );
    }
    return;
  }

  const replicaKeys = resolveReplicaEntityCryptoKeys(env, importedEntityId, importedSignerId);
  const replica: EntityReplica = {
    entityId: importedEntityId,
    signerId: importedSignerId,
    mempool: [],
    isProposer: runtimeTx.data.isProposer,
    state: {
      entityId: importedEntityId,
      height: 0,
      timestamp: env.timestamp,
      nonces: new Map(),
      messages: [],
      proposals: new Map(),
      config,
      reserves: new Map(),
      accounts: new Map(),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: 0,
      jBlockObservations: [],
      jBlockChain: [],
      entityEncPubKey: replicaKeys.publicKey,
      entityEncPrivKey: replicaKeys.privateKey,
      profile: {
        name:
          typeof runtimeTx.data.profileName === 'string' && runtimeTx.data.profileName.trim().length > 0
            ? runtimeTx.data.profileName.trim()
            : `Entity ${importedEntityId.slice(-4)}`,
        isHub: false,
        avatar: '',
        bio: '',
        website: '',
      },
      htlcRoutes: new Map(),
      htlcFeesEarned: 0n,
      htlcNotes: new Map(),
      lockBook: new Map(),
      swapTradingPairs: buildDefaultEntitySwapPairs(getTokenIdsForJurisdiction(config.jurisdiction)),
      pendingSwapFillRatios: new Map(),
      pendingCrossJurisdictionFillAcks: new Map(),
      crossJurisdictionBookAdmissions: new Map(),
    },
  };
  normalizeEntitySwapTradingPairs(replica.state);

  if (runtimeTx.data.position) {
    replica.position = {
      ...runtimeTx.data.position,
      jurisdiction:
        runtimeTx.data.position.jurisdiction ||
        runtimeTx.data.position.xlnomy ||
        env.activeJurisdiction ||
        'default',
    };
  }

  env.eReplicas.set(replicaKey, replica);
  markStorageEntityDirty(env, replica.state.entityId);
  registerSingleSignerEntityWallet(env, runtimeTx, importedEntityId, importedSignerId);

  const createdReplica = env.eReplicas.get(replicaKey);
  const actualJBlock = createdReplica?.state.lastFinalizedJHeight;
  if (env.gossip && createdReplica && replicaKeys.isLocal) {
    announceLocalEntityProfile(env, createdReplica.state, env.timestamp);
  }

  if (typeof actualJBlock !== 'number') {
    logError('RUNTIME_TICK', `💥 ENTITY-CREATION-BUG: Just created entity with invalid jBlock!`);
    logError('RUNTIME_TICK', `💥   Expected: 0 (number), Got: ${typeof actualJBlock}, Value: ${actualJBlock}`);
    if (createdReplica) {
      createdReplica.state.lastFinalizedJHeight = 0;
      console.log(`💥   FIXED: Set jBlock to 0 for replica ${replicaKey}`);
    }
  }
};

const registerSingleSignerEntityWallet = (
  env: Env,
  runtimeTx: ImportReplicaRuntimeTx,
  importedEntityId: string,
  importedSignerId: string,
): void => {
  const validators = runtimeTx.data.config.validators;
  const threshold = runtimeTx.data.config.threshold;
  if (validators.length !== 1 || threshold !== 1n) return;

  const signerId = normalizeRuntimeId(String(validators[0] || '')) || importedSignerId;
  if (!signerId) return;
  try {
    const privateKey = getSignerPrivateKey(env, signerId);
    const privateKeyHex = `0x${Array.from(privateKey)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')}`;
    for (const jReplica of env.jReplicas?.values?.() ?? []) {
      jReplica.jadapter?.registerEntityWallet?.(importedEntityId, privateKeyHex);
    }
  } catch (_error) {
    console.warn(
      `⚠️ Cannot derive private key for signer ${signerId} (no env.runtimeSeed), skipping entity wallet registration`,
    );
  }
};

const findExistingReplicaCaseInsensitive = (
  env: Env,
  entityId: string,
  signerId: string,
): { key: string; replica: EntityReplica } | null => {
  const directKey = `${entityId}:${signerId}`;
  const directReplica = env.eReplicas.get(directKey);
  if (directReplica) return { key: directKey, replica: directReplica };

  for (const [key, candidate] of env.eReplicas.entries()) {
    const [candidateEntity, candidateSigner] = String(key).split(':');
    if (String(candidateEntity || '').toLowerCase() !== entityId) continue;
    if (String(candidateSigner || '').toLowerCase() !== signerId) continue;
    return { key: String(key), replica: candidate };
  }
  return null;
};
