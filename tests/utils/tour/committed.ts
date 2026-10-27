import { expect, type Page } from '@playwright/test';
import { HDNodeWallet } from 'ethers';
import { gotoApp } from '../e2e-demo-users';
import { importStackPhraseUi, readWalletIdentity } from '../../../ui/tests/wallet-ui';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../../core/api/runtime-adapter/types';
import type { RuntimeAdapterFrameSummary } from '../../../core/api/runtime-adapter/resolve';

type DebugWindow = Window & {
  __xln?: {
    adapter(): RuntimeAdapter | null;
    xln(): Promise<XLNModule>;
    store: { getState(): { activeEntityId: string | null } };
  };
};

export async function enterStack(page: Page) {
  const phrase = HDNodeWallet.createRandom().mnemonic?.phrase;
  if (!phrase) throw new Error('TUTORIAL_PHRASE_UNAVAILABLE');
  await gotoApp(page, { settleMs: 0 });
  await importStackPhraseUi(page, phrase);
  const identity = await readWalletIdentity(page);
  await expect(page.getByTestId('account-row').first()).toBeVisible({ timeout: 30_000 });
  return { ...identity, phrase };
}

/** Observe the wallet's canonical committed frame. No test helper submits runtime inputs. */
export const readTourState = (page: Page, hubId: string, entityId?: string) =>
  page.evaluate(
    async ({ peer, selectedOwner }) => {
      const debug = (window as DebugWindow).__xln;
      const adapter = debug?.adapter();
      const owner = selectedOwner || debug?.store.getState().activeEntityId;
      if (!debug || !adapter || !owner) throw new Error('TUTORIAL_RUNTIME_UNAVAILABLE');
      const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: owner });
      if (!frame.activeEntity || frame.activeEntityId !== owner) throw new Error('TUTORIAL_OWNER_MISMATCH');
      const account = frame.activeEntity.accounts.items.find(row => row.state.leftEntity === peer || row.state.rightEntity === peer);
      if (!account) throw new Error('TUTORIAL_ACCOUNT_UNAVAILABLE');
      const xln = await debug.xln();
      const tokens = [1, 2].map(tokenId => {
        const delta = account.state.deltas.get(tokenId);
        const derived = delta ? xln.deriveDelta(delta, account.state.leftEntity === owner) : null;
        return [
          tokenId,
          {
            reserve: frame.activeEntity!.core.reserves.get(tokenId) ?? 0n,
            collateral: delta?.collateral ?? 0n,
            ownValue: derived ? derived.outCollateral + derived.outPeerCredit - derived.inOwnCredit : 0n,
            peerCreditLimit: derived?.peerCreditLimit ?? 0n,
          },
        ] as const;
      });
      return {
        pending: Boolean(account.pendingFrame),
        mempool: account.mempoolCount,
        locks: account.state.locks.size,
        pulls: account.state.pulls?.size ?? 0,
        tokens: new Map(tokens),
        claims: [...(account.state.subcontracts ?? [])].flatMap(([id, claim]) =>
          'creditorIsLeft' in claim ? [{ id, kind: claim.kind, principal: claim.principal }] : [],
        ),
      };
    },
    { peer: hubId, selectedOwner: entityId ?? '' },
  );

export async function settledTourState(page: Page, hubId: string, label: string) {
  await expect
    .poll(
      async () => {
        const state = await readTourState(page, hubId);
        return { pending: state.pending, mempool: state.mempool };
      },
      { message: label, timeout: 30_000 },
    )
    .toEqual({ pending: false, mempool: 0 });
  return readTourState(page, hubId);
}

export function tourToken(state: Awaited<ReturnType<typeof readTourState>>, tokenId: number) {
  const token = state.tokens.get(tokenId);
  if (!token) throw new Error(`TUTORIAL_TOKEN_UNAVAILABLE:${tokenId}`);
  return token;
}

export const readWalletCheckpoint = (page: Page, atHeight?: number) =>
  page.evaluate(async height => {
    const debug = (window as DebugWindow).__xln;
    const adapter = debug?.adapter();
    const entityId = debug?.store.getState().activeEntityId;
    if (!adapter || !entityId) throw new Error('TUTORIAL_RUNTIME_UNAVAILABLE');
    const current = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
    const frame = await adapter.read<RuntimeAdapterFrameSummary>(`frame/${height ?? current.height}`);
    return { frame };
  }, atHeight);
