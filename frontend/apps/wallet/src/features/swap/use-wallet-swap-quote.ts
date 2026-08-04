import { useEffect, useRef, useState } from 'react';

import type { SwapCommandPlan, XLNModule } from '@xln/runtime/api/public/runtime-module';
import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
import type { WalletEntityAccountsView } from '../accounts/account-view-model';
import {
  createSwapDraftIdentity,
  createSwapRequestCoordinator,
  createSwapRequestIdentity,
} from './swap-request-identity';
import type { WalletSwapRouteOption } from './swap-route-options';
import { projectWalletSwapQuote, type WalletSwapQuoteView } from './swap-view-model';

export type WalletSwapQuoteState =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'loading'; draftIdentity: string }>
  | Readonly<{ phase: 'error'; draftIdentity: string | null; error: string }>
  | Readonly<{
      phase: 'ready';
      draftIdentity: string;
      evidenceIdentity: string;
      plan: SwapCommandPlan;
      quote: WalletSwapQuoteView;
      route: WalletSwapRouteOption;
    }>;

const positiveTicks = (value: string): bigint => {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) throw new Error('WALLET_SWAP_PRICE_TICKS_INVALID');
  return BigInt(normalized);
};

export const walletSwapErrorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Swap planning failed');

export const useWalletSwapQuote = (input: Readonly<{
  entity: WalletEntityAccountsView;
  route: WalletSwapRouteOption | null;
  giveTokenId: number;
  wantTokenId: number;
  amountInput: string;
  priceTicksInput: string;
  runtime: XLNModule;
}>): Readonly<{ quoteState: WalletSwapQuoteState; visibleDraftIdentity: string | null; quoteIsStale: boolean }> => {
  const [quoteState, setQuoteState] = useState<WalletSwapQuoteState>(Object.freeze({ phase: 'idle' }));
  const coordinator = useRef(createSwapRequestCoordinator());
  let visibleDraftIdentity: string | null = null;
  try {
    if (input.route && input.amountInput.trim() && input.priceTicksInput.trim() && input.giveTokenId > 0 && input.wantTokenId > 0) {
      visibleDraftIdentity = createSwapDraftIdentity({
        frameHeight: input.entity.height,
        routeValue: input.route.value,
        giveTokenId: input.giveTokenId,
        wantTokenId: input.wantTokenId,
        amountInput: input.amountInput,
        priceTicksInput: input.priceTicksInput,
      });
    }
  } catch {
    visibleDraftIdentity = null;
  }

  useEffect(() => {
    const route = input.route;
    if (!route || !route.enabled || !input.amountInput.trim() || !input.priceTicksInput.trim() || input.giveTokenId < 1 || input.wantTokenId < 1) {
      coordinator.current.invalidate();
      setQuoteState(Object.freeze({ phase: 'idle' }));
      return;
    }
    let draftIdentity: string;
    let giveAmountRaw: bigint;
    let priceTicks: bigint;
    try {
      draftIdentity = createSwapDraftIdentity({
        frameHeight: input.entity.height,
        routeValue: route.value,
        giveTokenId: input.giveTokenId,
        wantTokenId: input.wantTokenId,
        amountInput: input.amountInput,
        priceTicksInput: input.priceTicksInput,
      });
      giveAmountRaw = input.runtime.parseTokenAmount(input.giveTokenId, input.amountInput.trim());
      if (giveAmountRaw <= 0n) throw new Error('WALLET_SWAP_GIVE_AMOUNT_INVALID');
      priceTicks = positiveTicks(input.priceTicksInput);
      if (input.giveTokenId === input.wantTokenId && route.mode === 'same') throw new Error('WALLET_SWAP_TOKEN_PAIR_IDENTICAL');
    } catch (error) {
      coordinator.current.invalidate();
      setQuoteState(Object.freeze({ phase: 'error', draftIdentity: null, error: walletSwapErrorText(error) }));
      return;
    }
    const ticket = coordinator.current.begin(draftIdentity);
    setQuoteState(Object.freeze({ phase: 'loading', draftIdentity }));
    void (async () => {
      try {
        if (!input.entity.signerId) throw new Error('WALLET_SWAP_SOURCE_SIGNER_MISSING');
        if (!route.sourceHubSignerId) throw new Error('WALLET_SWAP_SOURCE_HUB_SIGNER_MISSING');
        if (input.entity.timestamp <= 0 || input.entity.height <= 0) throw new Error('WALLET_SWAP_LOGICAL_CLOCK_UNAVAILABLE');
        const sourceAccountPromise = runtimeQueryClient.readAccount(
          input.entity.entityId,
          route.sourceHubEntityId,
          { atHeight: input.entity.height },
        );
        const targetAccountPromise = route.mode === 'cross'
          ? runtimeQueryClient.readOptionalAccount(route.targetEntityId!, route.targetHubEntityId!, { atHeight: input.entity.height })
          : Promise.resolve(null);
        const [sourceAccount, targetAccount] = await Promise.all([sourceAccountPromise, targetAccountPromise]);
        const evidenceIdentity = createSwapRequestIdentity({
          frameHeight: input.entity.height,
          sourceEntityId: input.entity.entityId,
          sourceAccountHeight: sourceAccount.currentHeight,
          sourceHubEntityId: route.sourceHubEntityId,
          mode: route.mode,
          targetEntityId: route.targetEntityId,
          targetAccountHeight: targetAccount?.currentHeight ?? null,
          targetHubEntityId: route.targetHubEntityId,
          giveTokenId: input.giveTokenId,
          wantTokenId: input.wantTokenId,
          giveAmountRaw,
          priceTicks,
          routeValue: route.value,
        });
        const plan = input.runtime.planSwapCommand({
          mode: route.mode,
          logicalTimestamp: input.entity.timestamp,
          logicalHeight: input.entity.height,
          routeValue: route.value,
          giveTokenId: input.giveTokenId,
          wantTokenId: input.wantTokenId,
          giveAmount: giveAmountRaw,
          priceTicks,
          source: {
            entityId: input.entity.entityId,
            signerId: input.entity.signerId,
            hubEntityId: route.sourceHubEntityId,
            hubSignerId: route.sourceHubSignerId,
            jurisdiction: route.sourceJurisdictionRef,
            account: sourceAccount.state,
          },
          ...(route.mode === 'cross' ? {
            target: {
              entityId: route.targetEntityId!,
              signerId: route.targetSignerId!,
              hubEntityId: route.targetHubEntityId!,
              hubSignerId: route.targetHubSignerId!,
              jurisdiction: route.targetJurisdictionRef!,
              account: targetAccount?.state ?? null,
            },
            allowOpenTargetAccount: targetAccount === null,
          } : {}),
          expiresInMs: 24 * 60 * 60 * 1_000,
        });
        const quote = projectWalletSwapQuote({
          requestIdentity: evidenceIdentity,
          giveTokenId: input.giveTokenId,
          wantTokenId: input.wantTokenId,
          routeLabel: route.label,
          plan,
        });
        if (!coordinator.current.accepts(ticket, draftIdentity)) return;
        setQuoteState(Object.freeze({ phase: 'ready', draftIdentity, evidenceIdentity, plan, quote, route }));
      } catch (error) {
        if (!coordinator.current.accepts(ticket, draftIdentity)) return;
        setQuoteState(Object.freeze({ phase: 'error', draftIdentity, error: walletSwapErrorText(error) }));
      }
    })();
    return () => coordinator.current.invalidate();
  }, [
    input.route, input.amountInput, input.priceTicksInput, input.giveTokenId, input.wantTokenId,
    input.entity.entityId, input.entity.signerId, input.entity.height, input.entity.timestamp, input.runtime,
  ]);

  return Object.freeze({
    quoteState,
    visibleDraftIdentity,
    quoteIsStale: quoteState.phase === 'ready' && quoteState.draftIdentity !== visibleDraftIdentity,
  });
};
