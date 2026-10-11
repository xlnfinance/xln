import { expect, type Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../../core/api/runtime-adapter/types';
import { safeStringify } from '../../../core/protocol/serialization';

type DebugWindow = Window & {
  __xln?: { adapter: () => RuntimeAdapter | null; xln: () => Promise<XLNModule>; env: () => RuntimeReplica | null };
};
export type Parties = { ownerId: string; hubId: string; tokenId: number };

/** Public route advertisements only: no Runtime secrets or input payloads. */
export const readRoutingEvidence = (page: Page) => page.evaluate(() => {
  const env = (window as DebugWindow).__xln?.env();
  if (!env) throw new Error('Lending routing diagnostics unavailable');
  return env.gossip.getProfiles().map(profile => ({
    entityId: profile.entityId, lastUpdated: profile.lastUpdated,
    publicAccounts: profile.publicAccounts,
    accounts: profile.accounts.map(account => ({
      counterpartyId: account.counterpartyId,
      capacities: Object.fromEntries(Object.entries(account.tokenCapacities).map(([id, capacity]) => [id, {
        incoming: capacity.inCapacity.toString(), outgoing: capacity.outCapacity.toString(),
      }])),
    })),
  }));
});

/** Exercise a signed early withdrawal through production admission despite the UI guard. */
export const requestEarlyClose = (page: Page, parties: Parties, positionId: string) => page.evaluate(async input => {
  const adapter = (window as DebugWindow).__xln?.adapter();
  if (!adapter) throw new Error('Lending adapter unavailable');
  const view = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: input.ownerId });
  const signerId = view.activeEntity?.core.signerId;
  if (!signerId) throw new Error('Lending signer unavailable');
  await adapter.send({ runtimeTxs: [], entityInputs: [{
    entityId: input.ownerId, signerId,
    entityTxs: [{ type: 'lendingClosePosition', data: { hubEntityId: input.hubId, positionId: input.positionId } }],
  }] });
}, { ...parties, positionId });

/** Read current committed money; never edit Runtime or Account state. */
export const readAccount = (page: Page, parties: Parties) =>
  page.evaluate(async ids => {
    const debug = (window as DebugWindow).__xln;
    const adapter = debug?.adapter();
    if (!debug || !adapter) throw new Error('Lending Account diagnostics unavailable');
    const account = await adapter.read<
      NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number]
    >(`entity/${ids.ownerId}/account/${ids.hubId}`);
    const xln = await debug.xln();
    const delta = account.state.deltas.get(ids.tokenId);
    if (!delta) throw new Error('Lending token lane unavailable');
    const isLeft = xln.isLeftEntity(ids.ownerId, ids.hubId);
    const derived = xln.deriveDelta(delta, isLeft);
    const policy = account.state.rebalanceFeePolicies?.get(ids.tokenId)?.[isLeft ? 'right' : 'left'];
    return {
      root: account.currentFrame.accountStateRoot,
      height: account.currentHeight,
      timestamp: account.currentFrame.timestamp,
      balance: (derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit).toString(),
      borrowingLimit: derived.ownCreditLimit.toString(),
      debt: derived.inOwnCredit.toString(),
      credit: derived.peerCreditLimit.toString(),
      incoming: derived.inCapacity.toString(),
      collateral: delta.collateral.toString(),
      ondelta: delta.ondelta.toString(),
      offdelta: delta.offdelta.toString(),
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
      closeRequests: [...account.state.lendingIntents ?? []].filter(([, kind]) => kind === 'close-request').map(([id]) => id),
      feePolicy: policy
        ? {
            version: policy.policyVersion,
            base: policy.baseFee.toString(),
            gas: policy.gasFee.toString(),
            bps: policy.liquidityFeeBps.toString(),
          }
        : null,
    };
  }, parties);

export async function readPools(page: Page, ids: Parties) {
  const response = await page.request.get('/api/lending/state', {
    params: { hubEntityId: ids.hubId, userEntityId: ids.ownerId, tokenId: String(ids.tokenId) },
  });
  expect(response.ok()).toBe(true);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    !('success' in body) ||
    body.success !== true ||
    !('hubEntityId' in body) ||
    body.hubEntityId !== ids.hubId ||
    !('savings' in body) ||
    !Array.isArray(body.savings)
  )
    throw new Error(`Invalid lending state response: ${safeStringify(body)}`);
  return body.savings.map((pool: unknown) => {
    if (
      !pool ||
      typeof pool !== 'object' ||
      !('positionId' in pool) ||
      typeof pool.positionId !== 'string' ||
      !('status' in pool) ||
      typeof pool.status !== 'string' ||
      !('hubEntityId' in pool) ||
      pool.hubEntityId !== ids.hubId ||
      !('lenderEntityId' in pool) ||
      pool.lenderEntityId !== ids.ownerId ||
      !('tokenId' in pool) ||
      pool.tokenId !== ids.tokenId ||
      !('principalAmount' in pool) ||
      typeof pool.principalAmount !== 'string'
    )
      throw new Error(`Invalid lending position: ${safeStringify(pool)}`);
    return {
      positionId: pool.positionId,
      status: pool.status,
      principal: pool.principalAmount,
    };
  });
}
