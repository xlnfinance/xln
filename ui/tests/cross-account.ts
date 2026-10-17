import { expect, type Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { withHubAdapter } from './cross-market';

type Account = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number];
type Leg = { entityId: string; hubId: string; tokenId: number };

/** Both actual participants must commit the same financial state, with no pending ACK work. */
export async function expectBilateralCommit(page: Page, hubLabel: string, leg: Leg) {
  return withHubAdapter(hubLabel, async hub => {
    const read = async () => {
      const account = await hub.read<Account>(`entity/${leg.hubId}/account/${leg.entityId}`);
      const delta = account.state.deltas.get(leg.tokenId);
      if (!delta) throw new Error(`HUB_ACCOUNT_DELTA_MISSING:${leg.hubId}:${leg.tokenId}`);
      const hubState = {
        height: account.currentHeight,
        root: account.currentFrame.accountStateRoot,
        delta: Object.fromEntries(Object.entries(delta).map(([key, value]) => [key, String(value)])),
        pending: Boolean(account.pendingFrame),
        mempool: account.mempoolCount,
      };
      const clientState = await page.evaluate(async ids => {
        const debug = (window as Window & { __xln?: { adapter(): RuntimeAdapter | null } }).__xln;
        const adapter = debug?.adapter();
        if (!adapter) throw new Error('WALLET_ADAPTER_UNAVAILABLE');
        const account = await adapter.read<Account>(`entity/${ids.entityId}/account/${ids.hubId}`);
        const delta = account.state.deltas.get(ids.tokenId);
        if (!delta) throw new Error(`CLIENT_ACCOUNT_DELTA_MISSING:${ids.entityId}:${ids.tokenId}`);
        return {
          height: account.currentHeight,
          root: account.currentFrame.accountStateRoot,
          delta: Object.fromEntries(Object.entries(delta).map(([key, value]) => [key, String(value)])),
          pending: Boolean(account.pendingFrame),
          mempool: account.mempoolCount,
        };
      }, leg);
      return { hubState, clientState };
    };
    let evidence: Awaited<ReturnType<typeof read>> | undefined;
    await expect(async () => {
      const current = await read();
      const { hubState, clientState } = current;
      expect(hubState).toEqual(clientState);
      expect(hubState.pending).toBe(false);
      expect(hubState.mempool).toBe(0);
      evidence = current;
    }).toPass({ timeout: 10_000, intervals: [100, 250, 500] });
    if (!evidence) throw new Error('BILATERAL_COMMIT_EVIDENCE_MISSING');
    return { ...leg, ...evidence };
  });
}
