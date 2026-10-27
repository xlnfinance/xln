import { assertDemoNetwork } from '@xln/frontend/lib/config/demo-accounts';
import {
  assertSessionOwned,
  CHAIN_CATCHUP_POLL_MS,
  createChainCatchupProbe,
  isChainCatchupCancelled,
  openAfterChainCatchup,
} from './chain-catchup';
import {
  getOpenAccountRebalancePolicyData,
  hydrateJurisdictionPolicyDefaults,
} from '@xln/frontend/lib/utils/onboarding/onboardingPreferences';
import { sendRuntimeInput } from './commands';
import { getXLN } from './xln-loader';
import type { RuntimeRecoveryCandidate } from './restore';
import { connectEmbedded, getEmbeddedEnv, lockEmbeddedRuntime, requireAdapter } from './adapter';
import { readJson } from './http';
import { waitFor } from './tx';
import { accountDisputeConfig } from './financial/roles';
import { entityTxOpensAccount } from './financial/open-account-match';
import type { EntityTx, RuntimeAdapterEntitySummary, RuntimeReplica } from '@xln/core/api/public/runtime-module';
import type { AccountDisputeConfig } from '@xln/core/account/config/dispute-config';
import { deriveJurisdictionSignerIndex } from '@xln/core/jurisdiction/machine/config/signer-derivation';
import { useApp, type VaultKind } from './store';

/**
 * The stack this page is served from. Identical resolution to the SvelteKit
 * wallet (`vault-bootstrap.ts` + `vaultStore.restore`): `/api/jurisdictions`
 * names the chains and their contracts, `/api/hubs` names the hubs, `/relay`
 * is the socket. Locally that is the `bun run dev` orchestrator, in production
 * xln.finance; a static host without an API leaves only the offline sandbox.
 */
export type StackJurisdiction = {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  blockTimeMs: number;
  entityProviderDeploymentBlock: number;
  contracts: { account: string; depository: string; entityProvider: string; deltaTransformer: string };
};
export type StackHub = { entityId: string; name: string; online: boolean };
/** `jurisdiction` is the primary (the entity's home chain); `jurisdictions` lists every active chain, primary first. */
export type Stack = {
  apiBase: string;
  relayUrl: string;
  jurisdiction: StackJurisdiction;
  jurisdictions: StackJurisdiction[];
  hubs: StackHub[];
};

const USDC = 1;

async function relayConnected(
  xln: Awaited<ReturnType<typeof getXLN>>,
  env: RuntimeReplica,
  owns: () => boolean,
): Promise<boolean> {
  try {
    await waitFor(() => {
      assertSessionOwned(owns);
      return Boolean(xln.getP2P(env)?.isConnected?.());
    }, 'relay connection', 20_000);
    return true;
  } catch (error) {
    if (isChainCatchupCancelled(error) || !owns()) throw error;
    useApp
      .getState()
      .toast('The network relay is not reachable. Reconnect before opening your hub account from Home.', 'danger');
    return false;
  }
}

export function findReplicaState(env: RuntimeReplica, entityId: string) {
  for (const [key, replica] of env.state.eReplicas?.entries?.() ?? []) {
    const keyEntityId = String(key).split(':')[0] ?? '';
    if (keyEntityId.toLowerCase() === entityId.toLowerCase()) return replica;
  }
  return undefined;
}

/** An openAccount for this pair is queued, in the Entity mempool, or in an open frame. */
const openAccountPending = (env: RuntimeReplica, entityId: string, counterpartyId: string): boolean => {
  const opensPair = (tx: EntityTx): boolean => entityTxOpensAccount(tx, counterpartyId);
  const replica = findReplicaState(env, entityId);
  return (env.runtimeMempool?.entityInputs ?? []).some(input =>
    input.entityId.toLowerCase() === entityId.toLowerCase() && (input.entityTxs ?? []).some(opensPair))
    || Boolean(replica?.mempool.some(opensPair))
    || Boolean(replica?.proposal?.txs.some(opensPair))
    || Boolean(replica?.lockedFrame?.txs.some(opensPair));
};

/** One open per pair: a user's open and the automatic first-hub open never both send. */
export const accountOpenedOrPending = (env: RuntimeReplica, entityId: string, counterpartyId: string): boolean =>
  accountReady(env, entityId, counterpartyId) || openAccountPending(env, entityId, counterpartyId);

export function accountReady(env: RuntimeReplica, entityId: string, counterpartyId: string): boolean {
  return Boolean(findReplicaState(env, entityId)?.state?.accounts?.get?.(counterpartyId));
}

export async function sendEntity(entityId: string, signerId: string, entityTxs: EntityTx[]): Promise<void> {
  await sendRuntimeInput({ runtimeTxs: [], entityInputs: [{ entityId, signerId, entityTxs }] });
}

declare const __XLN_STACK_ORIGIN__: string;
/** Same origin as the API (proxied in dev), except a TLS stack the dev server cannot WebSocket-proxy. */
const socketOrigin = (apiBase: string): string =>
  typeof __XLN_STACK_ORIGIN__ === 'string' && __XLN_STACK_ORIGIN__.startsWith('https:')
    ? __XLN_STACK_ORIGIN__
    : apiBase;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** `/rpc` on the API host, or an absolute RPC URL as published. */
export const resolveRpcUrl = (rpc: string, apiBase: string): string =>
  rpc.startsWith('/') ? new URL(rpc, apiBase).toString() : rpc;

export const relayUrlFor = (apiBase: string): string => {
  const url = new URL(apiBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/relay';
  url.search = '';
  return url.toString();
};

function pickJurisdictions(payload: Record<string, unknown>, apiBase: string): StackJurisdiction[] {
  const entries = Object.entries(asRecord(payload['jurisdictions']));
  const usable = entries.flatMap(([key, raw]) => {
    const config = asRecord(raw);
    const contracts = asRecord(config['contracts']);
    const rpc = String(config['rpc'] || (Array.isArray(config['rpcs']) ? config['rpcs'][0] : '') || '');
    const status = String(config['status'] || 'active').toLowerCase();
    const deploymentBlock = Number(config['entityProviderDeploymentBlock']);
    if (status !== 'active' || !contracts['depository'] || !contracts['entityProvider'] || !rpc) return [];
    if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 1) return [];
    return [
      {
        key,
        primary: config['primary'] === true,
        jurisdiction: {
          key,
          name: String(config['name'] || key),
          chainId: Math.floor(Number(config['chainId'] || 31337)),
          rpcUrl: resolveRpcUrl(rpc, apiBase),
          blockTimeMs: Math.floor(Number(config['blockTimeMs'] || 10_000)),
          entityProviderDeploymentBlock: deploymentBlock,
          contracts: {
            account: String(contracts['account'] || ''),
            depository: String(contracts['depository']),
            entityProvider: String(contracts['entityProvider']),
            deltaTransformer: String(contracts['deltaTransformer'] || ''),
          },
        } satisfies StackJurisdiction,
      },
    ];
  });
  const primary = usable.find(entry => entry.primary) ?? usable[0];
  return primary
    ? [primary.jurisdiction, ...usable.filter(entry => entry !== primary).map(entry => entry.jurisdiction)]
    : [];
}

async function fetchApi(apiBase: string, path: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(new URL(`${path}?ts=${Date.now()}`, apiBase), {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await readJson(response);
  } finally {
    clearTimeout(timer);
  }
}

/** The hosted wallet and invoice reader share the same network catalog. */
export async function loadStackJurisdictions(apiBase: string): Promise<StackJurisdiction[]> {
  return pickJurisdictions(await fetchApi(apiBase, '/api/jurisdictions'), apiBase);
}

/** Null when this origin serves no xln API: the wallet then offers only the offline sandbox. */
export async function detectStack(apiBase: string = window.location.origin): Promise<Stack | null> {
  let jurisdictions: StackJurisdiction[];
  try {
    jurisdictions = await loadStackJurisdictions(apiBase);
  } catch {
    return null;
  }
  const jurisdiction = jurisdictions[0];
  if (!jurisdiction) return null;
  let hubs: StackHub[] = [];
  try {
    const payload = await fetchApi(apiBase, '/api/hubs');
    hubs = (Array.isArray(payload['hubs']) ? payload['hubs'] : [])
      .map(raw => asRecord(raw))
      .filter(hub => typeof hub['entityId'] === 'string')
      .map(hub => ({
        entityId: String(hub['entityId']).toLowerCase(),
        name: String(hub['name'] || 'Hub'),
        online: hub['online'] !== false,
      }))
      .sort((left, right) => Number(right.online) - Number(left.online));
  } catch {
    hubs = [];
  }
  return { apiBase, relayUrl: relayUrlFor(socketOrigin(apiBase)), jurisdiction, jurisdictions, hubs };
}

export type HostedVaultOptions = {
  vaultId: string;
  vaultName: string;
  kind: VaultKind;
  selfLabel: string;
  stack: Stack;
  recovery?: RuntimeRecoveryCandidate;
  /** Runtime id the stored vault records; a seed deriving another fails closed. */
  runtimeId?: string;
  onStep?: (step: string) => void;
};

/**
 * The first hub Account is J-dependent admission: it runs after catch-up.
 * Commands go to the current adapter, so every await rechecks that this
 * session still owns the wallet; a replaced session sends and shows nothing.
 */
export async function openFirstHubAccount(
  xln: Awaited<ReturnType<typeof getXLN>>,
  env: RuntimeReplica,
  stack: Stack,
  entityId: string,
  signerId: string,
  owns: () => boolean,
): Promise<void> {
  // importEntity initializes a new profile. Unlock/recovery must preserve the
  // committed profile, including an explicitly published name, bio and website.
  const hub = stack.hubs.find(entry => entry.online) ?? stack.hubs[0];
  if (hub && !accountReady(env, entityId, hub.entityId) && (await relayConnected(xln, env, owns))) {
    await xln.ensureGossipProfiles(env, [hub.entityId]);
    assertSessionOwned(owns);
    // The response clocks are signed into the Account for its whole life, so
    // they are derived from the two parties' roles, never assumed. A hub whose
    // role we cannot establish gets no account rather than a user's window.
    let disputeConfig: AccountDisputeConfig | null = null;
    try {
      const summaries = await requireAdapter().read<RuntimeAdapterEntitySummary[]>('entities');
      assertSessionOwned(owns);
      disputeConfig = accountDisputeConfig({ entityId, counterpartyId: hub.entityId, summaries });
    } catch (error) {
      if (isChainCatchupCancelled(error) || !owns()) throw error;
      useApp
        .getState()
        .toast(
          `${hub.name} has not published its role yet, so the dispute window cannot be set. Open the account from Home once it is online. (${error instanceof Error ? error.message : String(error)})`,
          'danger',
        );
    }
    if (disputeConfig) {
      await hydrateJurisdictionPolicyDefaults(stack.jurisdiction.name, () => assertSessionOwned(owns));
      assertSessionOwned(owns);
      const decimals = xln.getTokenInfo(USDC).decimals;
      const rebalancePolicy = getOpenAccountRebalancePolicyData(decimals);
      // The user (or another tab) may have opened this Account while the
      // automatic open awaited the network; decide in the same turn as sending.
      if (accountOpenedOrPending(env, entityId, hub.entityId)) return;
      await sendEntity(entityId, signerId, [
        {
          type: 'openAccount',
          // Automatic discovery opens the Account, not an unsecured exposure.
          // Only the user's receive/credit controls may authorize that risk.
          data: {
            targetEntityId: hub.entityId,
            creditAmount: 0n,
            ...(rebalancePolicy ? { rebalancePolicy } : {}),
            tokenId: USDC,
            disputeConfig,
          },
        },
      ]);
      try {
        await waitFor(() => {
          assertSessionOwned(owns);
          return accountReady(env, entityId, hub.entityId);
        }, `account with ${hub.name}`, 60_000);
      } catch (error) {
        if (isChainCatchupCancelled(error) || !owns()) throw error;
        useApp.getState().toast(`${hub.name} has not answered yet; the account opens when it does.`);
      }
    }
  }
}

/**
 * The existing drain criterion for every attached jurisdiction: each watcher
 * authenticates through one captured finalized target before the fence opens.
 * A failure keeps the fence closed and is shown, never retried silently.
 */
async function openAfterJCatchup(
  xln: Awaited<ReturnType<typeof getXLN>>,
  env: RuntimeReplica,
  stack: Stack,
  entityId: string,
  signerId: string,
  owners: ReadonlyArray<{ entityId: string; signerId: string }>,
): Promise<void> {
  try {
    const targets = await Promise.all(owners.map(async owner => {
      const adapter = xln.getEntityJAdapter(env, owner.entityId, owner.signerId);
      if (!adapter?.getCurrentBlockNumber || !adapter.getFinalityDepth)
        throw new Error(`J_WATCHER_DRAIN_API_MISSING:${owner.entityId}`);
      const head = Number(await adapter.getCurrentBlockNumber());
      const depth = Number(adapter.getFinalityDepth());
      if (!Number.isSafeInteger(head) || head < 0 || !Number.isSafeInteger(depth) || depth < 0)
        throw new Error(`J_WATCHER_TARGET_INVALID:${head}:${depth}`);
      return { adapter, targetBlock: Math.max(0, head - depth) };
    }));
    const nameOf = (chainId: number): string =>
      stack.jurisdictions.find(chain => chain.chainId === chainId)?.name ?? `Chain ${chainId}`;
    // A lock or a replacement session detaches this env; its catch-up then ends silently.
    const owns = (): boolean => getEmbeddedEnv() === env;
    const probe = createChainCatchupProbe(xln, env, targets, nameOf, useApp.getState().setChainSync, owns);
    await openAfterChainCatchup(
      xln,
      env,
      probe,
      owns,
      poll => waitFor(poll, 'chain catch-up', Number.POSITIVE_INFINITY, CHAIN_CATCHUP_POLL_MS),
      () => {
        if (!xln.getP2P(env)) {
          xln.startP2P(env, { signerId: String(env.runtimeId), relayUrls: [stack.relayUrl], gossipPollMs: 2_000 });
        }
      },
    );
    if (!owns()) return;
    await openFirstHubAccount(xln, env, stack, entityId, signerId, owns);
  } catch (error) {
    if (isChainCatchupCancelled(error) || getEmbeddedEnv() !== env) return;
    console.error('[hosted] chain catch-up failed; new commands stay paused', error);
    useApp.getState().setChainSync(null);
    useApp
      .getState()
      .toast(`Chain sync stopped, so new payments stay paused. Reopen the wallet to retry. (${error instanceof Error ? error.message : String(error)})`, 'danger');
  }
}

/**
 * Boot a personal runtime against the stack: import its jurisdiction over RPC,
 * create the entity, join the relay, publish a profile and open an account with
 * the first hub. Idempotent on a restored runtime. The hub answers over the
 * network, so the account may still be pending when Home opens.
 */
export async function bootHostedVault(seed: string, options: HostedVaultOptions): Promise<void> {
  const { stack } = options;
  if (options.kind === 'test') assertDemoNetwork(stack.jurisdictions.map(chain => chain.chainId));
  const step = (text: string): void => options.onStep?.(text);
  useApp.getState().setBooting(true);
  try {
    // The caller has saved the encrypted key before starting the Runtime.
    // Keep the wallet discoverable even if chain sync or this tab stops here.
    const app = useApp.getState();
    if (!app.vaults.some(v => v.id === options.vaultId)) {
      app.addVault({ id: options.vaultId, name: options.vaultName, kind: options.kind, createdAt: Date.now() });
    }
    step('Starting your runtime');
    const xln = await getXLN();
    // Replay can sign for any local jurisdiction before main() returns. Warm
    // every seed-derived EOA used at creation from one BIP-39 root before the
    // WAL opens; numeric signer 1 is also the Runtime id main() reuses.
    const signerIndex = (chain: Stack['jurisdictions'][number]): number =>
      chain.key === stack.jurisdiction.key ? 0 : deriveJurisdictionSignerIndex(chain.name);
    const addresses = xln.prewarmNumericSigners(seed, stack.jurisdictions.map(chain => String(signerIndex(chain) + 1)));
    const signerIds = new Map(stack.jurisdictions.map((chain, index) => {
      const address = addresses[index];
      if (!address) throw new Error(`STACK_SIGNER_PREWARM_MISSING:${chain.key}`);
      return [chain.key, address.toLowerCase()] as const;
    }));
    const runtimeId = signerIds.get(stack.jurisdiction.key);
    if (!runtimeId) throw new Error(`STACK_PRIMARY_SIGNER_MISSING:${stack.jurisdiction.key}`);
    if (options.runtimeId && options.runtimeId.toLowerCase() !== runtimeId) throw new Error('Wallet identity mismatch.');
    await connectEmbedded(seed, runtimeId, options.recovery);
    const env = getEmbeddedEnv();
    if (!env) throw new Error('EMBEDDED_ENV_MISSING');
    const signerId = runtimeId;
    const entityId = String(xln.generateLazyEntityId([signerId], 1n)).toLowerCase();
    const j = stack.jurisdiction;

    // Every chain the stack runs: the entity lives on the primary, swaps may cross into the others.
    const chainOwners = new Map<string, { entityId: string; signerId: string }>();
    // Stable secondary HD paths keep primary identity independent of order.
    const chainOwner = (chain: (typeof stack.jurisdictions)[number]) => {
      const chainSignerId = signerIds.get(chain.key);
      if (!chainSignerId) throw new Error(`STACK_JURISDICTION_SIGNER_MISSING:${chain.key}`);
      const chainEntityId = chain.key === j.key ? entityId : String(xln.generateLazyEntityId([chainSignerId], 1n)).toLowerCase();
      return { entityId: chainEntityId, signerId: chainSignerId };
    };
    const joinChain = async (chain: (typeof stack.jurisdictions)[number]): Promise<void> => {
      step(`Joining ${chain.name}`);
      const ready = (): boolean => Boolean(env.state.jReplicas?.get?.(chain.name)?.contracts?.depository);
      // Install the history consumer before importing another chain. Otherwise
      // its watcher can finish empty pages before this Entity exists and must
      // correctly re-read them when the new signer joins from deployment.
      if (!ready()) {
        await sendRuntimeInput({
          runtimeTxs: [
            {
              type: 'importJ',
              data: {
                name: chain.name,
                chainId: chain.chainId,
                ticker: 'USDC',
                rpcs: [chain.rpcUrl],
                entityProviderDeploymentBlock: chain.entityProviderDeploymentBlock,
                blockTimeMs: chain.blockTimeMs,
                contracts: chain.contracts,
              },
            },
          ],
          entityInputs: [],
        });
        await waitFor(ready, `importJ ${chain.name}`, 45_000);
      }

      const primary = chain.key === j.key;
      const { entityId: chainEntityId, signerId: chainSignerId } = chainOwner(chain);
      chainOwners.set(chain.key, { entityId: chainEntityId, signerId: chainSignerId });
      if (findReplicaState(env, chainEntityId)) return;
      step(`Creating your ${chain.name} entity`);
      await sendRuntimeInput({
        runtimeTxs: [
          xln.importEntity({
            entityId: chainEntityId,
            signerId: chainSignerId,
            entitySeed: seed,
            data: {
              isProposer: true,
              profileName: primary ? options.selfLabel : `${options.selfLabel} ${chain.name}`,
              config: {
                mode: 'proposer-based',
                threshold: 1n,
                validators: [chainSignerId],
                shares: { [chainSignerId]: 1n },
                jurisdiction: {
                  address: `jreplica://${chain.name}`,
                  name: chain.name,
                  chainId: chain.chainId,
                  blockTimeMs: chain.blockTimeMs,
                  entityProviderAddress: chain.contracts.entityProvider,
                  depositoryAddress: chain.contracts.depository,
                },
              },
            },
          }),
        ],
        entityInputs: [],
      });
      await waitFor(() => Boolean(findReplicaState(env, chainEntityId)), `importReplica ${chain.name}`, 45_000);
    };
    // The wallet screen opens on committed state. Until every jurisdiction's
    // watcher finishes its first authenticated pass, the Runtime's j-catchup
    // fence admits only chain joins, holds peer input, due hooks and J
    // submission, and no P2P transport exists: stale J height would admit HTLC
    // reveals past revealBeforeHeight and sign over unseen disputes. A restored
    // Runtime is already behind it; every chain is joined, then all drain once.
    xln.setRuntimeDeliveryReady(env, false);
    for (const chain of stack.jurisdictions) await joinChain(chain);
    void openAfterJCatchup(xln, env, stack, entityId, signerId, [...chainOwners.values()]);

    step('Ready');
    app.setActiveEntityId(entityId);
    app.setActiveVault(options.vaultId);
    app.unlockSeed(options.vaultId, seed);
  } catch (error) {
    // No failed boot keeps a Runtime or this seed's keys in memory.
    await lockEmbeddedRuntime();
    (await getXLN()).clearSignerKeys(seed);
    throw error;
  } finally {
    useApp.getState().setBooting(false);
  }
}
