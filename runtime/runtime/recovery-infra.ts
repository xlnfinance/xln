import { ethers } from 'ethers';
import { getLocalSignerPrivateKey } from '../account/crypto';
import { assertBrowserVMJurisdiction } from '../jadapter/browservm-registry';
import { findWatcherJurisdictionReplica } from '../jadapter/watcher-replica';
import { requireDurableJurisdictionStack } from '../jurisdiction/contract-address';
import type { EntityReplica } from '../entity/types';
import type { RuntimeReplica, RuntimeTx } from './types';
import type { JReplica } from '../types/jurisdiction-runtime';
import { createStructuredLogger } from '../infra/logger';
import { ensureLiveJAdapterForReplica } from './infra';
import { getLiveJAdapter } from './live-jadapters';

const runtimeLog = createStructuredLogger('runtime');

export const assertPersistedContractConfigReady = (
  env: RuntimeReplica,
  label: string,
): void => {
  for (const [name, replica] of env.state.jReplicas.entries()) {
    try {
      requireDurableJurisdictionStack(replica);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${reason}:${label}:${name}`, { cause });
    }
  }
};

const findJurisdictionByName = (
  env: RuntimeReplica,
  name: string,
): [string, JReplica] | null => {
  const expected = String(name || '').trim().toLowerCase();
  for (const entry of env.state.jReplicas.entries()) {
    if (String(entry[0] || '').trim().toLowerCase() === expected) {
      return entry;
    }
  }
  return null;
};

const registerSingleSignerWallet = (
  env: RuntimeReplica,
  replica: EntityReplica,
): void => {
  const validators = replica.state.config.validators;
  if (validators.length !== 1 || replica.state.config.threshold !== 1n) return;
  const signerId = String(validators[0] || '').trim().toLowerCase();
  if (!signerId) {
    throw new Error(`ENTITY_SINGLE_SIGNER_MISSING:${replica.entityId}`);
  }
  if (String(replica.signerId || '').trim().toLowerCase() !== signerId) {
    throw new Error(
      `ENTITY_SINGLE_SIGNER_REPLICA_MISMATCH:${replica.entityId}:` +
      `${replica.signerId}:${signerId}`,
    );
  }
  const privateKey = getLocalSignerPrivateKey(env, signerId);
  if (privateKey === null) return;
  const jurisdiction = replica.state.config.jurisdiction;
  if (!jurisdiction?.depositoryAddress || !jurisdiction.chainId) {
    throw new Error(
      `ENTITY_JURISDICTION_BINDING_INCOMPLETE:${replica.entityId}`,
    );
  }
  const jurisdictionReplica = findWatcherJurisdictionReplica(
    env,
    jurisdiction.depositoryAddress,
    jurisdiction.chainId,
  );
  if (!jurisdictionReplica) {
    throw new Error(
      `ENTITY_JURISDICTION_REPLICA_MISSING:${replica.entityId}:` +
      `${jurisdiction.chainId}:${jurisdiction.depositoryAddress}`,
    );
  }
  const hasExternalRpc = (jurisdictionReplica.rpcs ?? []).some(rpc => {
    const value = String(rpc || '').trim().toLowerCase();
    return value.length > 0 && !value.startsWith('browservm:');
  });
  const jurisdictionName = [...env.state.jReplicas]
    .find(([, candidate]) => candidate === jurisdictionReplica)?.[0];
  const adapter = jurisdictionName
    ? getLiveJAdapter(env, jurisdictionName)
    : undefined;
  if (!adapter) {
    // RPC submission carries an assembled Hanko and is signed by the
    // jurisdiction transaction sender. Entity private keys must never leak
    // into an RPC adapter; only the in-process BrowserVM needs this binding.
    if (hasExternalRpc) return;
    runtimeLog.debug('browservm.wallet_bind_deferred', {
      entityId: replica.entityId,
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
    });
    return;
  }
  // BrowserVM is the only adapter that executes entity-authorized calls
  // in-process and therefore the only adapter allowed to receive entity keys.
  // RPC, Anvil and Tron adapters submit already-authorized Hankos; inferring
  // key authority from an empty `rpcs` list or method presence would both
  // crash valid RPC stacks and leak keys to future adapter implementations.
  if (adapter.mode !== 'browservm') return;
  if (!adapter.registerEntityWallet) {
    throw new Error(
      `ENTITY_JURISDICTION_WALLET_BINDER_MISSING:${replica.entityId}`,
    );
  }
  adapter.registerEntityWallet(replica.entityId, ethers.hexlify(privateKey));
};

export const registerCommittedSingleSignerWallets = (
  env: RuntimeReplica,
  entityIds?: ReadonlySet<string>,
): void => {
  for (const replica of env.state.eReplicas.values()) {
    if (entityIds && !entityIds.has(replica.entityId.toLowerCase())) continue;
    registerSingleSignerWallet(env, replica);
  }
};

export const reconcileRecoveryInfraEffects = async (
  env: RuntimeReplica,
  runtimeTxs: readonly RuntimeTx[],
  startJurisdictionWatchers: (env: RuntimeReplica) => void,
): Promise<void> => {
  const jurisdictionNames = new Set<string>();
  const importedEntityIds = new Set<string>();
  for (const tx of runtimeTxs) {
    if (tx.type === 'completeImportJ') jurisdictionNames.add(tx.data.name);
    if (tx.type === 'importJ' && findJurisdictionByName(env, tx.data.name)) {
      jurisdictionNames.add(tx.data.name);
    }
    if (tx.type === 'importReplica') {
      importedEntityIds.add(tx.entityId.toLowerCase());
    }
  }
  for (const name of jurisdictionNames) {
    const entry = findJurisdictionByName(env, name);
    if (!entry) {
      throw new Error(`COMMITTED_JURISDICTION_REPLICA_MISSING:${name}`);
    }
    const adapter = await ensureLiveJAdapterForReplica(env, entry[0], {
      allowBrowserVm: true,
      context: `postcommit:${entry[0]}`,
      attempts: typeof window !== 'undefined' ? 5 : 3,
    });
    if (!adapter) {
      throw new Error(`COMMITTED_JURISDICTION_ADAPTER_MISSING:${entry[0]}`);
    }
    if (adapter.mode === 'browservm') {
      const browserVM = adapter.getBrowserVM();
      if (!browserVM) {
        throw new Error(`COMMITTED_BROWSERVM_MISSING:${entry[0]}`);
      }
      assertBrowserVMJurisdiction(
        adapter.addresses.depository,
        adapter.chainId,
        browserVM,
      );
    }
  }
  if (jurisdictionNames.size > 0) {
    assertPersistedContractConfigReady(
      env,
      'postcommit jurisdiction import',
    );
    registerCommittedSingleSignerWallets(env);
    startJurisdictionWatchers(env);
  } else if (importedEntityIds.size > 0) {
    registerCommittedSingleSignerWallets(env, importedEntityIds);
  }
};
