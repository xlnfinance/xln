import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  generateLazyEntityId,
  importEntity,
  getP2PState,
  loadEnvFromDB,
  processRuntime,
  readPersistedStorageFrameRecord,
  registerSignerKey,
  startP2P,
  startRuntimeLoop,
  waitForRuntimeWorkDrained,
  waitForRuntimeInputCommitted,
} from '../../runtime/runtime.ts';
import type { RuntimeInput, RuntimeReplica } from './runtime-types';
import {
  fetchJurisdictions,
  listUsableJurisdictions,
  requestErc20Faucet,
  resolveJurisdictionRpc,
  type ApiJurisdictionConfig,
} from './api';
import { unlockWallet, updateWalletEntityId, type UnlockedIdentity } from './identity';
import type { CliSettings } from './settings';

export type CliSession = {
  settings: CliSettings;
  identity: UnlockedIdentity;
  env: RuntimeReplica;
  entityId: string;
  signerId: string;
  jurisdictionName: string;
};

export const resolveCliRelayUrl = (apiBase: string): string => {
  const relay = new URL('/relay', apiBase);
  if (relay.protocol === 'http:') relay.protocol = 'ws:';
  else if (relay.protocol === 'https:') relay.protocol = 'wss:';
  else throw new Error(`CLI_API_PROTOCOL_INVALID:${relay.protocol}`);
  relay.username = '';
  relay.password = '';
  relay.search = '';
  relay.hash = '';
  return relay.toString();
};

export const closeSession = async (session: CliSession): Promise<void> => {
  const errors: Error[] = [];
  try {
    await closeRuntimeDb(session.env);
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
  try {
    await closeInfraDb(session.env);
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'CLI_SESSION_CLOSE_FAILED');
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const waitUntil = async (
  ready: () => boolean,
  label: string,
  timeoutMs = 45_000,
  intervalMs = 50,
): Promise<void> => {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
};

/** Bootstrap path: enqueue + processRuntime (no loop exit-on-fatal). */
export const submitAndProcess = async (
  env: RuntimeReplica,
  input: RuntimeInput,
  ready: () => boolean,
  label: string,
  maxTicks = 40,
): Promise<void> => {
  enqueueRuntimeInput(env, input);
  for (let i = 0; i < maxTicks; i++) {
    await processRuntime(env);
    if (ready()) return;
  }
  if (!ready()) throw new Error(`Timeout waiting for ${label} after ${maxTicks} processRuntime ticks`);
};

/** Live path: enqueue into a running loop and wait for readiness. */
export const submitAndWait = async (
  env: RuntimeReplica,
  input: RuntimeInput,
  ready: () => boolean,
  label: string,
  timeoutMs = 45_000,
): Promise<number> => {
  const afterHeight = env.state.height;
  enqueueRuntimeInput(env, input);
  const committedHeight = await waitForRuntimeInputCommitted({
    env,
    submitted: input,
    afterHeight,
    readPersistedFrame: height => readPersistedStorageFrameRecord(env, height),
    timeoutMs,
  });
  await waitUntil(
    () => {
      if (env.infrastructure?.loopActive === false) {
        throw new Error(`${label}: runtime loop halted`);
      }
      return ready();
    },
    label,
    timeoutMs,
  );
  const drained = await waitForRuntimeWorkDrained(env, Math.min(timeoutMs, 15_000));
  if (!drained) throw new Error(`${label}: runtime work drain timed out after commit ${committedHeight}`);
  return committedHeight;
};

/** Commit an asynchronous command. The exact persisted input is the receipt. */
export const submitQueued = async (
  env: RuntimeReplica,
  input: RuntimeInput,
  label: string,
  timeoutMs = 45_000,
): Promise<number> => {
  const afterHeight = env.state.height;
  enqueueRuntimeInput(env, input);
  const committedHeight = await waitForRuntimeInputCommitted({
    env,
    submitted: input,
    afterHeight,
    readPersistedFrame: height => readPersistedStorageFrameRecord(env, height),
    timeoutMs,
  });
  return committedHeight;
};

const hasJAddresses = (env: RuntimeReplica, name: string): boolean => {
  const replica = env.state.jReplicas?.get(name);
  const contracts = replica?.contracts as { depository?: string; entityProvider?: string } | undefined;
  return Boolean(contracts?.depository && contracts?.entityProvider);
};

const findEntityId = (env: RuntimeReplica, preferred?: string | null): string | null => {
  if (preferred) {
    const needle = preferred.toLowerCase();
    for (const key of env.state.eReplicas.keys()) {
      const [entityId] = String(key).split(':');
      if (String(entityId || '').toLowerCase() === needle) return String(entityId);
    }
  }
  const first = env.state.eReplicas.keys().next();
  if (first.done) return null;
  return String(first.value).split(':')[0] || null;
};

const buildEntityConfig = (
  signerAddress: string,
  jName: string,
  config: ApiJurisdictionConfig,
  rpcUrl: string,
) => {
  const chainId = Math.floor(Number(config.chainId));
  const blockTimeMs = Math.floor(Number(config.blockTimeMs));
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error(`Invalid chainId for ${jName}`);
  if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0) {
    throw new Error(`Invalid blockTimeMs for ${jName}`);
  }
  const depositoryAddress = String(config.contracts?.depository || '');
  const entityProviderAddress = String(config.contracts?.entityProvider || '');
  if (!depositoryAddress || !entityProviderAddress) {
    throw new Error(`Missing contracts for ${jName}`);
  }
  return {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [signerAddress],
    shares: { [signerAddress]: 1n },
    jurisdiction: {
      address: rpcUrl,
      name: jName,
      chainId,
      blockTimeMs,
      entityProviderAddress,
      depositoryAddress,
    },
  };
};

const applyDbPath = (settings: CliSettings): void => {
  process.env['XLN_DB_PATH'] = settings.dbPath;
};

const bootstrapFresh = async (
  env: RuntimeReplica,
  identity: UnlockedIdentity,
  settings: CliSettings,
): Promise<{ entityId: string; jurisdictionName: string }> => {
  const jurisdictions = await fetchJurisdictions(settings);
  const imports = listUsableJurisdictions(jurisdictions);
  const primary = imports[0]!;
  const rpcUrl = resolveJurisdictionRpc(primary.config, settings.apiBase);
  const block = Number(primary.config.entityProviderDeploymentBlock);
  if (!Number.isSafeInteger(block) || block < 1) {
    throw new Error(`ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID for ${primary.name}`);
  }

  try {
    await submitAndProcess(
      env,
      {
        runtimeTxs: [
          {
            type: 'importJ',
            data: {
              name: primary.name,
              chainId: Math.floor(Number(primary.config.chainId)),
              ticker: String(primary.config.currency || 'USDC'),
              rpcs: [rpcUrl],
              entityProviderDeploymentBlock: block,
              blockTimeMs: Math.floor(Number(primary.config.blockTimeMs)),
              contracts: primary.config.contracts,
              startAtCurrentBlock: false,
            },
          },
        ],
        entityInputs: [],
      },
      () => hasJAddresses(env, primary.name),
      `importJ(${primary.name})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      [
        `Failed to import jurisdiction ${primary.name} via ${rpcUrl}`,
        message,
        'Hint: point XLN_API_BASE at a live mesh with archive RPC (local: http://127.0.0.1:8080),',
        'or ensure the public /rpc endpoint can serve entityProviderDeploymentBlock history.',
      ].join('\n'),
    );
  }

  for (const secondary of imports.slice(1)) {
    const secondaryRpc = resolveJurisdictionRpc(secondary.config, settings.apiBase);
    const secondaryBlock = Number(secondary.config.entityProviderDeploymentBlock);
    if (!Number.isSafeInteger(secondaryBlock) || secondaryBlock < 1) continue;
    await submitAndProcess(
      env,
      {
        runtimeTxs: [
          {
            type: 'importJ',
            data: {
              name: secondary.name,
              chainId: Math.floor(Number(secondary.config.chainId)),
              ticker: String(secondary.config.currency || 'USDC'),
              rpcs: [secondaryRpc],
              entityProviderDeploymentBlock: secondaryBlock,
              blockTimeMs: Math.floor(Number(secondary.config.blockTimeMs)),
              contracts: secondary.config.contracts,
              startAtCurrentBlock: false,
            },
          },
        ],
        entityInputs: [],
      },
      () => hasJAddresses(env, secondary.name),
      `importJ(${secondary.name})`,
    );
  }

  registerSignerKey(env, identity.signerAddress, identity.privateKeyBytes);
  const entityId = generateLazyEntityId([identity.signerAddress], 1n).toLowerCase();
  const entityConfig = buildEntityConfig(identity.signerAddress, primary.name, primary.config, rpcUrl);

  await submitAndProcess(
    env,
    {
      runtimeTxs: [
        importEntity({
          entityId,
          signerId: identity.signerAddress,
          entitySeed: identity.mnemonic,
          data: {
            isProposer: true,
            config: entityConfig,
            profileName: identity.label || settings.profileName,
          },
        }),
      ],
      entityInputs: [],
    },
    () => Boolean(findEntityId(env, entityId)),
    `importReplica(${entityId.slice(0, 12)})`,
  );

  await updateWalletEntityId(settings, entityId);
  const faucet = await requestErc20Faucet(settings, identity.signerAddress);
  if (!faucet.ok) {
    console.error(`[xln] faucet skipped/failed: ${faucet.detail}`);
  }
  return { entityId, jurisdictionName: primary.name };
};

export const openSession = async (
  settings: CliSettings,
  passphrase: string,
  options: { startLoop?: boolean; startNetwork?: boolean } = {},
): Promise<CliSession> => {
  applyDbPath(settings);
  const identity = await unlockWallet(settings, passphrase);
  const runtimeId = identity.runtimeId.toLowerCase();

  let env = await loadEnvFromDB(runtimeId, identity.mnemonic);
  let fresh = false;
  if (!env) {
    env = createEmptyEnv(identity.mnemonic);
    fresh = true;
  }
  env.runtimeId = runtimeId;
  env.dbNamespace = runtimeId;
  env.runtimeSeed = identity.mnemonic;

  registerSignerKey(env, identity.signerAddress, identity.privateKeyBytes);

  // Bootstrap with processRuntime first so import failures surface as thrown
  // errors instead of runtime-loop process.exit(1).
  let entityId = findEntityId(env, identity.entityId);
  let jurisdictionName = 'primary';
  if (fresh || !entityId) {
    const boot = await bootstrapFresh(env, identity, settings);
    entityId = boot.entityId;
    jurisdictionName = boot.jurisdictionName;
  } else {
    const replica = [...env.state.eReplicas.values()].find(
      r => String(r.state?.entityId || '').toLowerCase() === entityId!.toLowerCase(),
    );
    jurisdictionName = String(replica?.state?.config?.jurisdiction?.name || 'primary');
  }

  if (options.startLoop !== false) {
    startRuntimeLoop(env);
  }

  if (options.startNetwork !== false && typeof startP2P === 'function') {
    startP2P(env, {
      relayUrls: [resolveCliRelayUrl(settings.apiBase)],
      signerId: runtimeId,
      gossipPollMs: 5_000,
    });
    await waitUntil(() => getP2PState(env).connected, 'CLI relay connection', 15_000);
  }

  return {
    settings,
    identity: { ...identity, entityId },
    env,
    entityId,
    signerId: identity.signerAddress,
    jurisdictionName,
  };
};

export const logSessionBanner = (session: CliSession): void => {
  console.log(
    `[xln] runtime=${session.identity.runtimeId.slice(0, 10)}… entity=${session.entityId.slice(0, 12)}… j=${session.jurisdictionName} api=${session.settings.apiBase}`,
  );
};
