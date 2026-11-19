import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteRuntimeAdapter } from '../../../../core/api/runtime-adapter/remote';
import { deriveRuntimeAdapterCapabilityToken } from '../../../../core/api/runtime-adapter/security/auth';
import { decodeCommittedCrossRoutes } from '../../../../core/scripts/operations/hlt/cross/cross-boundary';
import { requireBoundaryRecord } from '../../../../core/protocol/boundary-validation';
import { userReplica, waitFor, type PocUser } from '../../../../core/scenarios/usdc-poc/user';
import { decodeHubCoreRecord } from '../../../../core/scripts/operations/hlt/boundary/worker-boundary';
import { getCrossJurisdictionRouteRemainingAmounts } from '../../../../core/extensions/cross-j/orderbook';

export const inspectHub = async (directory: string, signerId: string) => {
  const seed = readFileSync(join(directory, 'hub', 'vault.seed'), 'utf8');
  const adapter = new RemoteRuntimeAdapter();
  await adapter.connect({
    mode: 'remote',
    wsUrl: 'ws://127.0.0.1:18081/rpc',
    runtimeId: signerId,
    authKey: deriveRuntimeAdapterCapabilityToken(seed, 'inspect', Date.now() + 120_000, { audience: 'poc-usdc' }),
  });
  if (adapter.runtimeId !== signerId) throw new Error('USDC_PREFLIGHT_HUB_RUNTIME_ID_MISMATCH');
  return adapter;
};

export const inspectBilateral = async (adapter: RemoteRuntimeAdapter, user: PocUser, hub: string) => {
  let proof: unknown;
  await waitFor('public-bilateral-account-match', async () => {
    const remote = requireBoundaryRecord(
      await adapter.read(`entity/${hub}/account/${user.entityId}`),
      'USDC_PREFLIGHT_REMOTE_ACCOUNT_INVALID',
    );
    const frame = requireBoundaryRecord(remote['currentFrame'], 'USDC_PREFLIGHT_REMOTE_FRAME_INVALID');
    const local = userReplica(user).state.accounts.get(hub);
    if (!local || local.pendingFrame || local.mempool.length || remote['pendingFrame'] || remote['mempoolCount'] !== 0)
      return false;
    if (
      remote['currentHeight'] !== local.currentHeight ||
      frame['stateHash'] !== local.currentFrame.stateHash ||
      remote['currentFrameHanko'] !== local.counterpartyFrameHanko ||
      remote['counterpartyFrameHanko'] !== local.currentFrameHanko
    )
      return false;
    proof = {
      height: local.currentHeight,
      stateHash: local.currentFrame.stateHash,
      localHanko: local.currentFrameHanko,
      peerHanko: local.counterpartyFrameHanko,
    };
    return true;
  });
  return proof;
};

export const inspectMakerDepth = async (adapter: RemoteRuntimeAdapter, sourceHub: string) => {
  const state = await adapter.read(`entity/${sourceHub}`);
  const core = decodeHubCoreRecord(state);
  if (core['crossJurisdictionSwaps'] === undefined)
    return { status: 'unavailable', reason: 'CROSS_ORDER_STATE_ABSENT', entityHeight: core['height'] };
  return {
    status: 'observed',
    routes: decodeCommittedCrossRoutes(state)
      .filter(route => route.orderId.startsWith('mmx-') && route.source.tokenId === 1 && route.target.tokenId === 1)
      .map(route => ({
        orderId: route.orderId,
        routeHash: route.routeHash,
        status: route.status,
        priceTicks: route.priceTicks,
        sourceEntityId: route.source.entityId,
        sourceHubId: route.source.counterpartyEntityId,
        targetHubId: route.target.entityId,
        targetEntityId: route.target.counterpartyEntityId,
        amounts: getCrossJurisdictionRouteRemainingAmounts(route),
        expiresAt: route.expiresAt,
      })),
  };
};
