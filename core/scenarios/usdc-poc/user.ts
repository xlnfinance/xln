import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, isHexString } from 'ethers';
import * as runtime from '../../runtime';
import type { EntityTx } from '../../types/entity-tx';
import type { RuntimeInput, RuntimeReplica } from '../../runtime/types';
import { configureCryptoPoolEntry } from '../../protocol/crypto/crypto-pool';
import { deriveJurisdictionSignerIndex } from '../../jurisdiction/machine/config/signer-derivation';
import {
  resolveMeshJurisdictionConfig,
  resolveSecondaryJurisdictions,
  requireJurisdictionBlockTimeMs,
} from '../../orchestrator/mesh/mesh-jurisdictions';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';
import { requireRunId, runOrderId } from './journey/context';
import { getCreditGrantedByEntity } from '../../orchestrator/mesh/mesh-common';
import type { RuntimeAdapterConfig } from '../../api/runtime-adapter/types';

export const waitFor = async (label: string, ready: () => boolean | Promise<boolean>): Promise<void> => {
  const timeout = Number(process.env['USDC_POC_STAGE_TIMEOUT_MS'] ?? 60_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900_000) throw new Error('USDC_POC_TIMEOUT_INVALID');
  const authorityDeadline = Number(process.env['USDC_POC_STAGE_DEADLINE_MS'] ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(authorityDeadline) || authorityDeadline < 1) throw new Error('USDC_POC_DEADLINE_INVALID');
  const deadline = Math.min(Date.now() + timeout, authorityDeadline);
  while (!(await ready())) {
    if (Date.now() >= authorityDeadline) throw new Error(`USDC_EXECUTION_AUTHORITY_EXPIRED:${label}`);
    if (Date.now() >= deadline) throw new Error(`USDC_POC_TIMEOUT:${label}`);
    await Bun.sleep(50);
  }
  console.log(`USDC_POC_STAGE:${label}`);
};

export const requireHub = async (apiBase: string): Promise<string> => {
  const response = await fetch(`${apiBase}/api/hubs`);
  if (!response.ok) throw new Error(`USDC_POC_HUB_HTTP:${response.status}`);
  const body = requireBoundaryRecord(await response.json(), 'USDC_POC_HUBS_INVALID');
  if (!Array.isArray(body['hubs'])) throw new Error('USDC_POC_HUBS_MISSING');
  for (const raw of body['hubs']) {
    const hub = requireBoundaryRecord(raw, 'USDC_POC_HUB_INVALID');
    if (hub['online'] === true && typeof hub['entityId'] === 'string' && isHexString(hub['entityId'], 32)) {
      return hub['entityId'].toLowerCase();
    }
  }
  throw new Error('USDC_POC_ONLINE_HUB_MISSING');
};

const replica = (env: RuntimeReplica, entityId: string) => {
  for (const value of env.state.eReplicas.values()) {
    if (value.entityId.toLowerCase() === entityId) return value;
  }
  throw new Error(`USDC_POC_ENTITY_MISSING:${entityId}`);
};

export const bootUser = async (
  apiBase: string,
  directory: string,
  restore = false,
  runId = 'initial',
  hubConnection?: RuntimeAdapterConfig,
) => {
  requireRunId(runId);
  const vaultExists = existsSync(join(directory, 'vault.seed'));
  const seed =
    restore || vaultExists
      ? readFileSync(join(directory, 'vault.seed'), 'utf8')
      : Wallet.createRandom().mnemonic?.phrase;
  if (!seed) throw new Error('USDC_POC_MNEMONIC_MISSING');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!restore && !vaultExists) writeFileSync(join(directory, 'vault.seed'), seed, { mode: 0o600, flag: 'wx' });
  configureCryptoPoolEntry(new URL('../../protocol/crypto/crypto-pool.ts', import.meta.url));
  const jurisdiction = resolveMeshJurisdictionConfig(`${apiBase}/rpc`);
  const jurisdictions = [jurisdiction, ...resolveSecondaryJurisdictions(jurisdiction.rpc)];
  const indices = jurisdictions.map((chain, index) => (index === 0 ? 0 : deriveJurisdictionSignerIndex(chain.name)));
  const signers = runtime.prewarmNumericSigners(
    seed,
    indices.map(index => String(index + 1)),
  );
  const identities = jurisdictions.map((chain, index) => {
    const signer = signers[index];
    if (!signer) throw new Error('USDC_POC_JURISDICTION_SIGNER_MISSING');
    return {
      chainId: chain.chainId,
      signerId: signer,
      entityId: String(runtime.generateLazyEntityId([signer], 1n)).toLowerCase(),
    };
  });
  const signerId = signers[0];
  if (!signerId) throw new Error('USDC_POC_SIGNER_MISSING');
  const entityId = String(runtime.generateLazyEntityId([signerId], 1n)).toLowerCase();
  const env = await runtime.main(seed, {
    requireRestore: restore,
    trustedJurisdictionRpcBindings: jurisdictions.map(chain => ({
      jurisdictionRef: `stack:${chain.chainId}:${chain.contracts.depository.toLowerCase()}`,
      rpcUrl: new URL(chain.rpc, apiBase).toString(),
    })),
  });
  if (!restore && env.state.height !== 0) throw new Error('USDC_POC_FRESH_RUNTIME_HAS_COMMITTED_STATE');
  if (restore && env.state.height === 0) throw new Error('USDC_POC_RESTORE_EMPTY_RUNTIME');
  if (!restore)
    runtime.startRuntimeLoop(env, {
      onFatal: ({ message }) => {
        console.error(`USDC_POC_RUNTIME_FATAL:${message}`);
        process.exit(1);
      },
    });
  return {
    env,
    seed,
    signerId,
    entityId,
    jurisdiction,
    jurisdictions,
    identities,
    directory,
    runId,
    orderId: runOrderId(entityId, runId),
    hubConnection,
  };
};

export type PocUser = Awaited<ReturnType<typeof bootUser>>;
export const userReplica = (user: PocUser) => replica(user.env, user.entityId);

export const send = (user: PocUser, entityTxs: EntityTx[]): void => {
  runtime.enqueueRuntimeInput(user.env, {
    runtimeTxs: [],
    entityInputs: [{ entityId: user.entityId, signerId: user.signerId, entityTxs }],
  });
};

const imports = (user: PocUser): RuntimeInput => {
  const { jurisdiction: j, entityId, signerId, seed } = user;
  return {
    runtimeTxs: [
      {
        type: 'importJ',
        data: {
          name: j.name,
          chainId: j.chainId,
          ticker: 'USDC',
          rpcs: [j.rpc],
          entityProviderDeploymentBlock: j.entityProviderDeploymentBlock,
          blockTimeMs: requireJurisdictionBlockTimeMs(j),
          contracts: j.contracts,
        },
      },
      runtime.importEntity({
        entityId,
        signerId,
        entitySeed: seed,
        data: {
          isProposer: true,
          profileName: 'USDC PoC user',
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signerId],
            shares: { [signerId]: 1n },
            jurisdiction: {
              address: `jreplica://${j.name}`,
              name: j.name,
              chainId: j.chainId,
              blockTimeMs: requireJurisdictionBlockTimeMs(j),
              entityProviderAddress: j.contracts.entityProvider,
              depositoryAddress: j.contracts.depository,
            },
          },
        },
      }),
    ],
    entityInputs: [],
  };
};

export const openPocAccount = async (user: PocUser, apiBase: string, hub: string, creditAmount = 0n): Promise<void> => {
  const [joinJurisdiction, importUser] = imports(user).runtimeTxs ?? [];
  if (!joinJurisdiction || !importUser) throw new Error('USDC_POC_IMPORTS_MISSING');
  if (!user.env.state.jReplicas.has(user.jurisdiction.name))
    runtime.enqueueRuntimeInput(user.env, { runtimeTxs: [joinJurisdiction], entityInputs: [] });
  await waitFor('jurisdiction-committed', () => user.env.state.jReplicas.has(user.jurisdiction.name));
  if (![...user.env.state.eReplicas.values()].some(value => value.entityId === user.entityId))
    runtime.enqueueRuntimeInput(user.env, { runtimeTxs: [importUser], entityInputs: [] });
  await waitFor('entity-committed', () =>
    [...user.env.state.eReplicas.values()].some(value => value.entityId.toLowerCase() === user.entityId),
  );
  if (!runtime.getP2P(user.env))
    runtime.startP2P(user.env, { relayUrls: [apiBase.replace('http', 'ws') + '/relay'], gossipSet: 'hubs' });
  await waitFor('relay-connected', () => runtime.getP2P(user.env)?.isConnected() === true);
  await runtime.ensureGossipProfiles(user.env, [hub]);
  const existing = userReplica(user).state.accounts.get(hub);
  if (existing) {
    if (getCreditGrantedByEntity(existing, user.entityId, 1) !== creditAmount)
      send(user, [{ type: 'extendCredit', data: { counterpartyEntityId: hub, tokenId: 1, amount: creditAmount } }]);
    await waitFor('existing-account-credit-committed', () => {
      const current = userReplica(user).state.accounts.get(hub);
      return Boolean(
        current &&
        !current.pendingFrame &&
        !current.mempool.length &&
        getCreditGrantedByEntity(current, user.entityId, 1) === creditAmount,
      );
    });
    return;
  }
  send(user, [
    {
      type: 'openAccount',
      data: {
        targetEntityId: hub,
        tokenId: 1,
        creditAmount,
        disputeConfig: defaultAccountDisputeConfigForParties(user.entityId, false, hub, true),
      },
    },
  ]);
  await waitFor('source-account-committed', () => {
    const account = userReplica(user).state.accounts.get(hub);
    return Boolean(account && account.currentHeight > 0 && !account.pendingFrame && account.mempool.length === 0);
  });
};

export const closeUser = async (user: Pick<PocUser, 'env'>): Promise<void> => {
  await runtime.stopJurisdictionWatchersAndWait(user.env);
  if (!(await runtime.waitForRuntimeWorkDrained(user.env, 10_000)))
    throw new Error('USDC_POC_SHUTDOWN_WORK_NOT_DRAINED');
  await runtime.stopRuntimeLoopAndWait(user.env);
  await runtime.stopP2PAndWait(user.env);
  await runtime.closeRuntimeDb(user.env);
  await runtime.closeInfraDb(user.env);
};
