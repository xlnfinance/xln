import type { Page, expect as PlaywrightExpect } from '@playwright/test';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter, RuntimeAdapterSwapHistoryPage } from '../../core/api/runtime-adapter/types';

export type DebugWindow = Window & {
  __xln?: {
    adapter: () => RuntimeAdapter | null;
    xln: () => Promise<XLNModule>;
    store: { getState: () => { activeEntityId: string | null } };
  };
};

/** Read the same committed Account as the wallet; all financial actions still use real UI controls. */
export const readAccount = (page: Page, hubId: string) =>
  page.evaluate(async counterpartyId => {
    const debug = (window as DebugWindow).__xln;
    if (!debug) throw new Error('Wallet diagnostics unavailable');
    const adapter = debug.adapter();
    const entityId = debug.store.getState().activeEntityId;
    if (!adapter || !entityId) throw new Error('Wallet Account owner unavailable');
    const account = await adapter.read<
      NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number]
    >(`entity/${entityId}/account/${counterpartyId}`);
    const xln = await debug.xln();
    const isLeft = xln.isLeftEntity(entityId, counterpartyId);
    const usdcDelta = account.state.deltas.get(1);
    if (!usdcDelta) throw new Error('Swap USDC delta unavailable');
    const signed = (tokenId: number) => {
      const delta = account.state.deltas.get(tokenId);
      if (!delta) return '0';
      const derived = xln.deriveDelta(delta, isLeft);
      return (derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit).toString();
    };
    const incoming = xln.readAccountCapacity({
      account: account.state,
      ownerEntityId: entityId,
      counterpartyEntityId: counterpartyId,
      tokenId: 2,
    });
    return {
      height: account.currentHeight,
      root: account.currentFrame.accountStateRoot,
      pending: Boolean(account.pendingFrame),
      mempool: account.mempoolCount,
      offers: account.state.swapOffers.size,
      usdc: signed(1),
      weth: signed(2),
      wethCredit: incoming.peerCreditLimit.toString(),
      wethCapacity: incoming.inCapacity.toString(),
      usdcSpendable: xln.deriveDelta(usdcDelta, isLeft).outCapacity.toString(),
      holds: [...account.state.deltas].map(([tokenId, delta]) => {
        const derived = xln.deriveDelta(delta, isLeft);
        return { tokenId, outgoing: String(derived.outTotalHold), incoming: String(derived.inTotalHold) };
      }),
    };
  }, hubId);

export const readOrders = (page: Page, hubId: string) =>
  page.evaluate(async hub => {
    const debug = (window as DebugWindow).__xln;
    const adapter = debug?.adapter();
    const entityId = debug?.store.getState().activeEntityId;
    if (!adapter || !entityId) throw new Error('Wallet history unavailable');
    return adapter.read<RuntimeAdapterSwapHistoryPage>(`entity/${entityId}/account/${hub}/swap-history`, { limit: 25 });
  }, hubId);

export const expectDeliveryDrained = async (page: Page, expect: typeof PlaywrightExpect): Promise<void> => {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const debug = (
            window as Window & {
              __xln?: { env(): import('../../core/api/public/runtime-module').RuntimeReplica | null };
            }
          ).__xln;
          const env = debug?.env();
          if (!env) throw new Error('SWAP_RUNTIME_UNAVAILABLE');
          const entities = [...env.state.eReplicas.values()];
          const accounts = entities.flatMap(entity => [...entity.state.accounts.values()]);
          return {
            network: env.pendingNetworkOutputs?.length ?? 0,
            outputs: env.pendingOutputs?.length ?? 0,
            inbox: env.networkInbox?.length ?? 0,
            entityInputs: env.runtimeMempool.entityInputs.length,
            pendingAccounts: accounts.filter(account => account.pendingFrame || account.pendingAccountInput).length,
            accountMempool: accounts.reduce((count, account) => count + account.mempool.length, 0),
          };
        }),
      { timeout: 15_000 },
    )
    .toEqual({ network: 0, outputs: 0, inbox: 0, entityInputs: 0, pendingAccounts: 0, accountMempool: 0 });
};
