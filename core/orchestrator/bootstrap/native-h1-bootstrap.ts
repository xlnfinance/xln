import { scheduler } from 'node:timers/promises';
import { safeStringify } from '../../protocol/serialization';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';
import { createStructuredLogger } from '../../support/logger';
import { getTokenIdsForJurisdiction } from '../../account/utils';
import { DEFAULT_ACCOUNT_TOKEN_IDS } from '../../account/config/defaults';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../../orderbook';
import { parseProfile } from '../../entity/profile';
import { verifyProfileSignature } from '../../entity/profile/profile-signing';
import { storeVerifiedGossipProfile, type RelayStore } from '../../network/relay/store';
import { resolveJurisdictionTransport } from '../../jurisdiction/adapter/kernel/jurisdiction-loader';
import { createJAdapter } from '../../jurisdiction/adapter';
import type { JAdapter, JTokenInfo } from '../../jurisdiction/adapter/types';
import { getBootstrapTokenAmount } from '../../jurisdiction/machine/config/bootstrap-economy';
import { canDeployHubDefaultTokens, requiredHubTokenCount, selectHubTokenCatalog } from '../hub/node/token-catalog';
import type { Args, HubChild, ResetState } from '../orchestrator-types';
import { CHILD_HEALTH_TIMEOUT_MS, HUB_REQUIRED_TOKEN_COUNT } from '../orchestrator-config';
import { fetchLoopback } from '../server/loopback-fetch';
import { requireHubBootstrapOwners } from './bootstrap-health-validation';
import {
  HUB_DEFAULT_MIN_TRADE_SIZE,
  HUB_DEFAULT_SUPPORTED_PAIRS,
  getBootstrapCreditAmount,
} from '../mesh/mesh-common';
import {
  resolveMeshJurisdictionConfig,
  resolveSecondaryJurisdictions,
} from '../mesh/mesh-jurisdictions';
import type { ManagedPeerIdentity } from '../market-maker/identity-resolver';
import { planNativeHubBootstrapPeers, waitForNativeH1DeliveryReady } from '../process/reset-startup';
import type { NativeH1MeshPair, NativeH1ReserveTarget } from '../support/runtime-support';

type NativeH1BootstrapDeps = Readonly<{
  args: Pick<Args, 'host' | 'rpcUrl'>;
  hubChildren: readonly HubChild[];
  relayStore: RelayStore;
  resetState: Pick<ResetState, 'inProgress'>;
  nativeH1MeshPairs: Map<string, NativeH1MeshPair>;
  setNativeH1ReserveTargets(targets: readonly NativeH1ReserveTarget[]): void;
  pollHubHealth(child: HubChild): Promise<void>;
  fetchJson<T>(url: string, timeoutMs?: number): Promise<T | null>;
  getMarketMakerIdentities(): ManagedPeerIdentity[];
  resolveLocalMarketMakerRpcUrl(rpcUrl: string): string;
}>;

const meshLog = createStructuredLogger('mesh.orchestrator');

const publishNativeHubProfile = async (deps: NativeH1BootstrapDeps, child: HubChild): Promise<void> => {
  const { args, relayStore, pollHubHealth, fetchJson } = deps;
  if (child.engine !== 'rust') return;
  await pollHubHealth(child);
  const owners = requireHubBootstrapOwners(child);
  for (const owner of owners) {
  const entityId = String(owner.entityId).trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(entityId)) {
    throw new Error(`RUST_HUB_PROFILE_ENTITY_ID_MISSING:${child.name}`);
  }
  const payload = await fetchJson<Record<string, unknown>>(
    `http://${args.host}:${String(child.apiPort)}/api/gossip/profile?entityId=${encodeURIComponent(entityId)}`,
    CHILD_HEALTH_TIMEOUT_MS,
  );
  if (
    !payload || payload['ok'] !== true || payload['found'] !== true ||
    String(payload['entityId'] || '').toLowerCase() !== entityId ||
    !Array.isArray(payload['peers'])
  ) throw new Error(`RUST_HUB_PROFILE_RESPONSE_INVALID:${child.name}`);
  const profile = parseProfile(payload['profile']);
  const verified = await verifyProfileSignature(profile);
  if (!verified.valid) {
    throw new Error(`RUST_HUB_PROFILE_SIGNATURE_INVALID:${child.name}:${verified.reason || 'unknown'}`);
  }
  if (!storeVerifiedGossipProfile(relayStore, profile) && !relayStore.gossipProfiles.has(entityId)) {
    throw new Error(`RUST_HUB_PROFILE_RELAY_REJECTED:${child.name}`);
  }
  }
};

type NativeAccountStatus = Readonly<{
  hasAccount: boolean;
  ready: boolean;
  currentHeight: number;
  pendingFrameHeight: number | null;
  tokens: readonly Readonly<{
    tokenId: number;
    hubGranted: string;
    peerGranted: string;
    delta: null | Readonly<{ leftCreditLimit: string; rightCreditLimit: string }>;
  }>[];
}>;

const logNativeH1Bootstrap = (
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void => {
  meshLog.warn('native_h1.bootstrap_phase', { event, ...fields });
};

const readNativeAccountStatus = async (
  deps: NativeH1BootstrapDeps,
  child: HubChild,
  hubEntityId: string,
  counterpartyEntityId: string,
  tokenIds: readonly number[],
): Promise<NativeAccountStatus | null> => {
  const { args, fetchJson } = deps;
  const url = new URL(`http://${args.host}:${String(child.apiPort)}/api/account/status`);
  url.searchParams.set('hubEntityId', hubEntityId);
  url.searchParams.set('counterpartyEntityId', counterpartyEntityId);
  url.searchParams.set('tokenIds', tokenIds.join(','));
  const payload = await fetchJson<Record<string, unknown>>(url.toString(), CHILD_HEALTH_TIMEOUT_MS);
  if (!payload) return null;
  if (payload['success'] !== true || !Array.isArray(payload['tokens'])) {
    throw new Error(`RUST_HUB_ACCOUNT_STATUS_INVALID:${counterpartyEntityId}`);
  }
  const tokens = payload['tokens'].map((raw): NativeAccountStatus['tokens'][number] => {
    const row = requireBoundaryRecord(raw, 'RUST_HUB_ACCOUNT_STATUS_TOKEN');
    const tokenId = Number(row['tokenId']);
    const hubGranted = String(row['hubGranted'] || '');
    const peerGranted = String(row['peerGranted'] || '');
    const delta = row['delta'];
    if (!Number.isSafeInteger(tokenId) || tokenId < 1) {
      throw new Error(`RUST_HUB_ACCOUNT_STATUS_TOKEN_ID:${String(row['tokenId'])}`);
    }
    if (!/^-?\d+$/.test(hubGranted) || !/^-?\d+$/.test(peerGranted)) {
      throw new Error(`RUST_HUB_ACCOUNT_STATUS_GRANTED:${tokenId}`);
    }
    if (delta === null) return { tokenId, hubGranted, peerGranted, delta: null };
    const fields = requireBoundaryRecord(delta, 'RUST_HUB_ACCOUNT_STATUS_DELTA');
    const leftCreditLimit = String(fields['leftCreditLimit'] || '');
    const rightCreditLimit = String(fields['rightCreditLimit'] || '');
    if (!/^-?\d+$/.test(leftCreditLimit) || !/^-?\d+$/.test(rightCreditLimit)) {
      throw new Error(`RUST_HUB_ACCOUNT_STATUS_CREDIT:${tokenId}`);
    }
    return { tokenId, hubGranted, peerGranted, delta: { leftCreditLimit, rightCreditLimit } };
  });
  const currentHeight = Number(payload['currentHeight'] || 0);
  const pendingFrameHeight = payload['pendingFrameHeight'] === null
    ? null
    : Number(payload['pendingFrameHeight']);
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 0 ||
      (pendingFrameHeight !== null && (!Number.isSafeInteger(pendingFrameHeight) || pendingFrameHeight < 1))) {
    throw new Error(`RUST_HUB_ACCOUNT_STATUS_HEIGHT:${currentHeight}:${String(pendingFrameHeight)}`);
  }
  return {
    hasAccount: payload['hasAccount'] === true,
    ready: payload['ready'] === true,
    currentHeight,
    pendingFrameHeight,
    tokens,
  };
};

const submitNativeBootstrapCredit = async (
  deps: NativeH1BootstrapDeps,
  child: HubChild,
  entityId: string,
  signerId: string,
  counterpartyEntityId: string,
  tokenIds: readonly number[],
): Promise<void> => {
  const { args } = deps;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchLoopback(
      `http://${args.host}:${String(child.apiPort)}/api/control/runtime/entity-inputs`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: safeStringify({
          commandId: `bootstrap-credit:${counterpartyEntityId}:${tokenIds.join(',')}`,
          entityInputs: [{
            entityId,
            signerId,
            entityTxs: tokenIds.map(tokenId => ({
              type: 'extendCredit',
              data: {
                counterpartyEntityId,
                tokenId,
                amount: getBootstrapCreditAmount(tokenId),
              },
            })),
          }],
        }),
      },
    );
    const payload = requireBoundaryRecord(await response.json(), 'RUST_HUB_BOOTSTRAP_CREDIT_RESPONSE');
    if (!response.ok || payload['ok'] !== true || !Number.isSafeInteger(payload['height'])) {
      throw new Error(
        `RUST_HUB_BOOTSTRAP_CREDIT_FAILED:${counterpartyEntityId}:${response.status}:${safeStringify(payload)}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
};

const configureNativeH1Entity = async (
  deps: NativeH1BootstrapDeps,
  child: HubChild,
  entityId: string,
  signerId: string,
  jurisdictionName: string,
): Promise<void> => {
  const { args, getMarketMakerIdentities } = deps;
  const quoteAuthority = getMarketMakerIdentities().find(peer => peer.jurisdictionName === jurisdictionName);
  if (!quoteAuthority) throw new Error('RUST_HUB_QUOTE_AUTHORITY_MISSING:H1');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchLoopback(
      `http://${args.host}:${String(child.apiPort)}/api/control/runtime/entity-inputs`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: safeStringify({
          commandId: `bootstrap-hub-policy:${entityId}`,
          entityInputs: [{
            entityId,
            signerId,
            entityTxs: [
              {
                type: 'setHubConfig',
                data: {
                  matchingStrategy: 'amount',
                  policyVersion: 1,
                  routingFeePPM: 1,
                  baseFee: 0n,
                  swapTakerFeeBps: 1,
                  rebalanceLiquidityFeeBps: 1n,
                  rebalanceTimeoutMs: 10 * 60 * 1_000,
                },
              },
              {
                type: 'initOrderbookExt',
                data: {
                  name: child.name,
                  spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
                  referenceTokenId: 1,
                  usdQuoteAuthorityEntityId: quoteAuthority.entityId,
                  minTradeSize: HUB_DEFAULT_MIN_TRADE_SIZE,
                  supportedPairs: [...HUB_DEFAULT_SUPPORTED_PAIRS],
                },
              },
            ],
          }],
        }),
      },
    );
    const payload = requireBoundaryRecord(await response.json(), 'RUST_HUB_BOOTSTRAP_POLICY_RESPONSE');
    if (!response.ok || payload['ok'] !== true || !Number.isSafeInteger(payload['height'])) {
      throw new Error(`RUST_HUB_BOOTSTRAP_POLICY_FAILED:${response.status}:${safeStringify(payload)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};

const creditGrantedByNativeHub = (
  status: NativeAccountStatus,
  tokenId: number,
): bigint => {
  const row = status.tokens.find(token => token.tokenId === tokenId);
  return row ? BigInt(row.hubGranted) : 0n;
};

const fundLocalJOperator = async (
  rpcUrl: string,
  chainId: number,
  signerId: string,
): Promise<void> => {
  if (chainId !== 31_337 && chainId !== 31_338) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: safeStringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'anvil_setBalance',
        params: [signerId, '0x8ac7230489e80000'],
      }),
      signal: controller.signal,
    });
    const payload = requireBoundaryRecord(
      await response.json(),
      'RUST_HUB_J_OPERATOR_FUND_RESPONSE',
    );
    if (!response.ok || payload['error'] !== undefined || payload['result'] !== null) {
      throw new Error(`RUST_HUB_J_OPERATOR_FUND_FAILED:${safeStringify(payload)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};

const fundH1OwnedBootstrapReserves = async (
  deps: NativeH1BootstrapDeps,
  entityId: string,
  signerId: string,
): Promise<void> => {
  const { args, hubChildren, resolveLocalMarketMakerRpcUrl, setNativeH1ReserveTargets } = deps;
  const startedAt = Date.now();
  const primary = resolveMeshJurisdictionConfig(args.rpcUrl);
  const jurisdictions = [primary, ...resolveSecondaryJurisdictions(primary.rpc)];
  // Native H1 becomes ready before the TS hubs have necessarily published
  // their complete multi-jurisdiction Entity inventory. Funding from that
  // partial snapshot silently leaves H2/H3 reserves at zero. Wait for the
  // authoritative child /api/info rows; the reset stall detector owns the
  // deadline and any exited child fails the reset through the normal path.
  while (hubChildren.slice(1).some(child => (child.lastInfo?.hubEntities?.length ?? 0) === 0)) {
    await scheduler.wait(25);
  }
  const hubEntities = hubChildren.flatMap(child => child.lastInfo?.hubEntities ?? []);
  logNativeH1Bootstrap('bootstrap_funding_inventory_ready', {
    elapsedMs: Date.now() - startedAt,
    entities: new Set([entityId, ...hubEntities.map(entry => entry.entityId)]).size,
    jurisdictions: jurisdictions.length,
  });
  const targets = jurisdictions.map(jurisdiction => ({
    jurisdiction,
    entityIds: Array.from(new Set([
      ...(jurisdiction.name === primary.name ? [entityId] : []),
      ...hubEntities
        .filter(entry => String(entry.jurisdictionName || '').trim() === jurisdiction.name)
        .map(entry => String(entry.entityId || '').trim().toLowerCase())
        .filter(candidate => /^0x[0-9a-f]{64}$/.test(candidate)),
    ])),
  }));
  for (const { jurisdiction, entityIds } of targets) {
    if (entityIds.length === 0) continue;
    const rpcUrl = resolveLocalMarketMakerRpcUrl(jurisdiction.rpc);
    await fundLocalJOperator(rpcUrl, jurisdiction.chainId, signerId);
    const transport = await resolveJurisdictionTransport(jurisdiction.chainId, jurisdiction.contracts.depository);
    if (!transport) throw new Error(`H1_BOOTSTRAP_TRANSPORT_MISSING:${jurisdiction.chainId}`);
    const adapter: JAdapter = await createJAdapter({
      ...transport, mode: transport.mode ?? 'rpc', watchOnly: !canDeployHubDefaultTokens(jurisdiction.chainId),
      chainId: jurisdiction.chainId,
      rpcUrl,
      fromReplica: {
        chainId: jurisdiction.chainId,
        name: jurisdiction.name,
        entityProviderDeploymentBlock: jurisdiction.entityProviderDeploymentBlock,
        contracts: { ...jurisdiction.contracts },
      },
    });
    logNativeH1Bootstrap('bootstrap_funding_adapter_ready', {
      elapsedMs: Date.now() - startedAt,
      jurisdiction: jurisdiction.name,
      entities: entityIds.length,
    });
    try {
    const catalog = await adapter.getTokenRegistry();
    logNativeH1Bootstrap('bootstrap_funding_catalog_ready', {
      elapsedMs: Date.now() - startedAt,
      jurisdiction: jurisdiction.name,
      tokens: catalog.length,
    });
    const configured = getTokenIdsForJurisdiction({
      name: jurisdiction.name,
      chainId: jurisdiction.chainId,
    });
    const bootstrapCatalog = selectHubTokenCatalog(catalog, jurisdiction.chainId,
      configured.length >= HUB_REQUIRED_TOKEN_COUNT ? configured : DEFAULT_ACCOUNT_TOKEN_IDS);
    const required = requiredHubTokenCount(jurisdiction.chainId);
    if (bootstrapCatalog.length < required) throw new Error(`H1_BOOTSTRAP_TOKEN_CATALOG_INCOMPLETE:required=${required}:actual=${bootstrapCatalog.length}`);
    if (jurisdiction.name === primary.name) {
      setNativeH1ReserveTargets(bootstrapCatalog.map((token: JTokenInfo) => ({
        tokenId: Number(token.tokenId),
        symbol: String(token.symbol || `token-${String(token.tokenId)}`),
        decimals: Number(token.decimals),
        expectedMin: getBootstrapTokenAmount(Number(token.tokenId), Number(token.decimals)),
      })));
    }
    const mints: Array<{ entityId: string; tokenId: number; amount: bigint }> = [];
    for (const targetEntityId of entityIds) {
      for (const token of bootstrapCatalog) {
        const tokenId = Number(token.tokenId);
        const expectedMin = getBootstrapTokenAmount(tokenId, Number(token.decimals));
        const current = await adapter.getReserves(targetEntityId, tokenId);
        if (current < expectedMin) {
          mints.push({
            entityId: targetEntityId,
            tokenId,
            amount: expectedMin - current,
          });
        }
      }
    }
    if (mints.length > 0) {
      if (!canDeployHubDefaultTokens(jurisdiction.chainId)) throw new Error(`H1_BOOTSTRAP_RESERVES_REQUIRED:${safeStringify(mints)}`);
      await adapter.debugFundReservesBatch(mints);
    }
    logNativeH1Bootstrap('bootstrap_funding_mints_ready', {
      elapsedMs: Date.now() - startedAt,
      jurisdiction: jurisdiction.name,
      mints: mints.length,
    });
    } finally {
      await adapter.close();
    }
  }
};

const waitForTsH1LocalReserves = async (deps: NativeH1BootstrapDeps, h1: HubChild): Promise<void> => {
  const { resetState } = deps;
  while (resetState.inProgress && h1.proc && h1.exitCode === null && h1.exitSignal === null) {
    if (h1.lastHealth?.bootstrapReserves?.targetMet === true) return;
    await scheduler.wait(25);
  }
  throw new Error('TS_H1_LOCAL_RESERVE_BOOTSTRAP_STOPPED');
};

const driveH1Bootstrap = async (
  deps: NativeH1BootstrapDeps,
  h1: HubChild,
  includeMarketMaker: boolean,
): Promise<void> => {
  const { hubChildren, resetState, nativeH1MeshPairs, pollHubHealth, getMarketMakerIdentities } = deps;
  const entityId = String(h1.lastInfo?.entityId || h1.lastInfo?.hubEntities?.[0]?.entityId || '').trim().toLowerCase();
  const signerId = String(h1.lastInfo?.hubEntities?.find(owner => owner.entityId === entityId)?.signerId || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(entityId) || !/^0x[0-9a-f]{40}$/.test(signerId)) {
    throw new Error('H1_BOOTSTRAP_IDENTITY_MISSING');
  }
  const bootstrapStartedAt = Date.now();
  if (h1.engine === 'rust') {
    await waitForNativeH1DeliveryReady(h1, resetState, pollHubHealth);
    const owners = requireHubBootstrapOwners(h1);
    for (const owner of owners) {
      await configureNativeH1Entity(deps, h1, owner.entityId, owner.signerId, owner.jurisdictionName);
    }
    await publishNativeHubProfile(deps, h1);
    logNativeH1Bootstrap('bootstrap_policy_committed', { elapsedMs: Date.now() - bootstrapStartedAt, entityId });
  } else {
    await waitForTsH1LocalReserves(deps, h1);
  }
  await fundH1OwnedBootstrapReserves(deps, entityId, signerId);
  logNativeH1Bootstrap('bootstrap_reserves_funded', { elapsedMs: Date.now() - bootstrapStartedAt, entityId });
  if (h1.engine !== 'rust') return;
  const owners = requireHubBootstrapOwners(h1);
  const peers = planNativeHubBootstrapPeers(
    entityId,
    owners,
    hubChildren.slice(1).map(peer => ({ name: peer.name, owners: requireHubBootstrapOwners(peer) })),
    includeMarketMaker ? getMarketMakerIdentities() : [],
  );
  let lastProgress = {
    complete: 0,
    observed: 0,
    ready: 0,
    awaitingHubCredit: 0,
  };
  let lastProgressLogAt = 0;
  while (resetState.inProgress && h1.proc && h1.exitCode === null && h1.exitSignal === null) {
    let complete = 0;
    let observed = 0;
    let ready = 0;
    let awaitingHubCredit = 0;
    for (const peer of peers) {
      const status = await readNativeAccountStatus(deps, h1, peer.ownerEntityId, peer.entityId, peer.tokenIds);
      if (!status) continue;
      observed += 1;
      const referenceToken = peer.tokenIds[0];
      const reference = referenceToken === undefined
        ? undefined
        : status.tokens.find(token => token.tokenId === referenceToken);
      const bilateralReady = status.hasAccount && status.ready && peer.tokenIds.every(tokenId => {
        const row = status.tokens.find(token => token.tokenId === tokenId);
        const target = getBootstrapCreditAmount(tokenId);
        return row !== undefined && BigInt(row.hubGranted) >= target && BigInt(row.peerGranted) >= target;
      });
      if (peer.isHub) {
        nativeH1MeshPairs.set(peer.entityId, {
          counterpartyId: peer.entityId,
          counterpartyName: peer.name,
          hasAccount: status.hasAccount,
          currentHeight: status.currentHeight,
          pendingFrameHeight: status.pendingFrameHeight,
          pendingFrameHash: null,
          grantedByMe: reference?.hubGranted ?? '0',
          grantedByPeer: reference?.peerGranted ?? '0',
          ready: bilateralReady,
        });
      }
      if (!status.hasAccount || !status.ready) continue;
      ready += 1;
      const missing = peer.tokenIds.filter(tokenId =>
        creditGrantedByNativeHub(status, tokenId) <
        getBootstrapCreditAmount(tokenId));
      if (missing.length > 0) {
        awaitingHubCredit += 1;
        logNativeH1Bootstrap('bootstrap_credit_submit', {
          counterpartyEntityId: peer.entityId,
          peer: peer.name,
          tokenIds: missing,
        });
        await submitNativeBootstrapCredit(deps, h1, peer.ownerEntityId, peer.ownerSignerId, peer.entityId, missing);
        logNativeH1Bootstrap('bootstrap_credit_committed', {
          counterpartyEntityId: peer.entityId,
          peer: peer.name,
          tokenIds: missing,
        });
        continue;
      }
      if (bilateralReady) complete += 1;
    }
    lastProgress = { complete, observed, ready, awaitingHubCredit };
    if (Date.now() - lastProgressLogAt >= 1_000) {
      lastProgressLogAt = Date.now();
      logNativeH1Bootstrap('bootstrap_progress', {
        ...lastProgress,
        elapsedMs: Date.now() - bootstrapStartedAt,
        peers: peers.length,
      });
    }
    const reservesReady = h1.lastHealth?.bootstrapReserves?.targetMet === true;
    if (complete === peers.length && reservesReady) return;
    await scheduler.wait(50);
  }
  throw new Error(
    `RUST_HUB_BOOTSTRAP_STOPPED:complete=${lastProgress.complete}/${peers.length}` +
    `:observed=${lastProgress.observed}:ready=${lastProgress.ready}` +
    `:awaitingHubCredit=${lastProgress.awaitingHubCredit}`,
  );
};

export const createNativeH1Bootstrap = (deps: NativeH1BootstrapDeps) => ({
  publishNativeHubProfile: (child: HubChild): Promise<void> => publishNativeHubProfile(deps, child),
  driveH1Bootstrap: (h1: HubChild, includeMarketMaker: boolean): Promise<void> =>
    driveH1Bootstrap(deps, h1, includeMarketMaker),
});
