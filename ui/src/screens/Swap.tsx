import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { explainWalletError } from '@xln/frontend/lib/utils/ui/walletError';
import { HOME, PageHead } from '../components/PageHead';
import type { AccountState, RuntimeAdapterEntitySummary } from '@xln/core/api/public/runtime-module';
import { getJurisdictionStackId } from '@xln/core/api/public/runtime-module';
import { prepareSwapOrderForDimensions, requantizeRemainingSwapAtPriceForDimensions } from '@xln/core/swapbook/types';
import { DeltaBar, DeltaCaption } from '../components/Bars';
import { Orderbook, type BookSide } from '../components/Orderbook';
import {
  quoteAtBestLevel,
  pickBookLevel,
  swapMinimumError,
  swapPriceBandError,
  useOrderbook,
  type BookLevel,
} from '../runtime/financial/orderbook';
import { crossBookMarket } from '../runtime/financial/cross-book';
import { useSwapTokenCatalog } from '../runtime/financial/swap-assets/catalog';
import { gossipProfile } from '../runtime/financial/roles';
import { Icon } from '../components/Icons';
import { TokenPicker } from '../components/TokenPicker';
import { ManualSwapRoutes } from '../components/ManualSwapRoutes';
import { useApp } from '../runtime/store';
import { switchActiveEntity } from '../runtime/entities';
import { peekXLN } from '../runtime/xln-loader';
import { sendEntityTxs } from '../runtime/tx';
import {
  compatibleSwapHubs,
  hubTakerFeeBps,
  jurisdictionRef,
  liveCrossOrders,
  planSwap,
  readAccountState,
  submitSwapPlan,
} from '../runtime/financial/swap';
import { amountInputText, formatAmount, formatMoney, formatLimit, parseAmount, plainAmount } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';
import { openSwapOffers, useWallet } from '../runtime/views';
import { counterpartyFeePolicy } from '../runtime/financial/manage';
import { getAdapter } from '../runtime/adapter';
import { TOUR_STEPS } from '../tour/steps';
import { useTutorialTrade } from '../tour/trade';

type Mode = 'same' | 'cross';

const normalizeId = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase();

export function Swap() {
  const [params] = useSearchParams();
  const entityId = useApp(s => s.activeEntityId);
  const toast = useApp(s => s.toast);
  const commandReady = useApp(s => s.commandReady);
  const wallet = useWallet(entityId);
  const xln = peekXLN();

  const hubs = useMemo(() => wallet.accounts.filter(account => account.isHub && !account.disputed), [wallet.accounts]);
  const [mode, setMode] = useState<Mode>('same');
  const [hubId, setHubId] = useState(params.get('hub')?.toLowerCase() ?? '');
  const hub = hubs.find(account => account.counterpartyId === hubId) ?? hubs[0] ?? null;

  const [giveTokenId, setGiveTokenId] = useState(1);
  const [wantTokenId, setWantTokenId] = useState(2);
  const [giveText, setGiveText] = useState('');
  const [wantText, setWantTextState] = useState('');
  // A picked book level fixes the price, so later pay edits keep receiving at exactly that level.
  const [pickedPriceTicks, setPickedPriceTicks] = useState<bigint | null>(null);
  const setWantText = (text: string): void => {
    setPickedPriceTicks(null);
    setWantTextState(text);
  };
  const [submitting, setSubmitting] = useState(false);
  // The hub's book stays open, as in the SvelteKit panel; a level fills the ticket.
  const [showBook, setShowBook] = useState(true);
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  // Cross-network: our entity on the other network and a hub that lives there.
  const otherEntities = useMemo(
    () =>
      wallet.summaries.filter(
        summary =>
          summary.signerId &&
          normalizeId(summary.entityId) !== wallet.entityId &&
          (summary.jurisdiction?.name || '') !== wallet.jurisdiction,
      ),
    [wallet.summaries, wallet.entityId, wallet.jurisdiction],
  );
  const [targetEntityId, setTargetEntityId] = useState('');
  const targetEntity =
    otherEntities.find(summary => normalizeId(summary.entityId) === targetEntityId) ?? otherEntities[0] ?? null;
  const targetHubs = useMemo(
    () =>
      wallet.summaries.filter(
        summary =>
          summary.isHub &&
          targetEntity &&
          hub &&
          compatibleSwapHubs(hub.counterpartyId, summary.entityId) &&
          (summary.jurisdiction?.name || '') === (targetEntity.jurisdiction?.name || '') &&
          normalizeId(summary.entityId) !== normalizeId(targetEntity.entityId),
      ),
    [wallet.summaries, targetEntity, hub],
  );
  const [targetHubId, setTargetHubId] = useState('');
  const targetHub = targetHubs.find(summary => normalizeId(summary.entityId) === targetHubId) ?? targetHubs[0] ?? null;
  const [targetAccount, setTargetAccount] = useState<AccountState | null | undefined>(undefined);
  const [targetAccountError, setTargetAccountError] = useState('');
  useEffect(() => {
    setTargetAccount(undefined);
    setTargetAccountError('');
  }, [mode, targetEntity?.entityId, targetHub?.entityId]);

  useEffect(() => {
    if (mode !== 'cross' || !targetEntity || !targetHub) {
      setTargetAccount(undefined);
      return;
    }
    let cancelled = false;
    setTargetAccountError('');
    readAccountState(targetEntity.entityId, targetHub.entityId)
      .then(state => {
        if (!cancelled) setTargetAccount(state);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTargetAccountError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, targetEntity, targetHub, wallet.frameHeight]);

  const sourceStack = jurisdictionRef(wallet.frame);
  const targetStack = targetEntity?.jurisdiction ? getJurisdictionStackId(targetEntity.jurisdiction) : '';
  const sourceTokens = useSwapTokenCatalog(wallet.entityId, wallet.signerId, sourceStack);
  const targetTokens = useSwapTokenCatalog(
    mode === 'cross' ? (targetEntity?.entityId ?? '') : '',
    mode === 'cross' ? (targetEntity?.signerId ?? '') : '',
    targetStack,
  );
  const receiveTokens = mode === 'cross' ? targetTokens : sourceTokens;
  const giveMeta = getTokenMeta(giveTokenId, sourceTokens.catalog);
  const wantMeta = getTokenMeta(wantTokenId, receiveTokens.catalog);
  const assetsReady =
    sourceTokens.ready &&
    receiveTokens.ready &&
    sourceTokens.catalog.some(token => token.tokenId === giveTokenId) &&
    receiveTokens.catalog.some(token => token.tokenId === wantTokenId);
  const crossMarket = useMemo(() => {
    if (mode !== 'cross' || !hub || !targetHub || !sourceStack || !targetStack) return null;
    return crossBookMarket(
      { jurisdiction: sourceStack, tokenId: giveTokenId, hubId: hub.counterpartyId },
      { jurisdiction: targetStack, tokenId: wantTokenId, hubId: targetHub.entityId },
    );
  }, [mode, hub, targetHub, sourceStack, targetStack, giveTokenId, wantTokenId]);
  const bookBaseId =
    crossMarket?.baseTokenId ??
    xln?.getSwapPairOrientation?.(giveTokenId, wantTokenId).baseTokenId ??
    Math.max(giveTokenId, wantTokenId);
  const bookMetadata = crossMarket
    ? { base: crossMarket.sourceIsBase ? giveMeta : wantMeta, quote: crossMarket.sourceIsBase ? wantMeta : giveMeta }
    : {
        base: getTokenMeta(bookBaseId, sourceTokens.catalog),
        quote: getTokenMeta(bookBaseId === giveTokenId ? wantTokenId : giveTokenId, sourceTokens.catalog),
      };
  const bookHubId = crossMarket?.hubId ?? hub?.counterpartyId ?? '';
  const bookRelayUrl = gossipProfile(bookHubId)?.relays[0] ?? '';
  const bookHubLabel = wallet.names.get(bookHubId) || bookHubId.slice(0, 10);
  const crossLabel = crossMarket
    ? crossMarket.sourceIsBase
      ? `${giveMeta.symbol} (${wallet.jurisdiction}) - ${wantMeta.symbol} (${targetEntity?.jurisdiction?.name})`
      : `${wantMeta.symbol} (${targetEntity?.jurisdiction?.name}) - ${giveMeta.symbol} (${wallet.jurisdiction})`
    : undefined;
  const book = useOrderbook({
    hubId: hub?.counterpartyId ?? '',
    tokenA: giveTokenId,
    tokenB: wantTokenId,
    ownEntityId: wallet.entityId,
    summaries: wallet.summaries,
    baseDecimals: bookMetadata.base.decimals,
    relayUrl: bookRelayUrl,
    ...(crossMarket ? { crossMarket } : {}),
  });
  const setGiveAmount = (text: string): void => {
    setGiveText(text);
    if (pickedPriceTicks === null) return;
    let give: bigint;
    try {
      give = parseAmount(text || '0', giveMeta.decimals);
    } catch {
      return;
    }
    const atPrice =
      give > 0n
        ? requantizeRemainingSwapAtPriceForDimensions(giveTokenId, wantTokenId, give, pickedPriceTicks, {
            giveTokenDecimals: giveMeta.decimals,
            wantTokenDecimals: wantMeta.decimals,
          })
        : null;
    setWantTextState(atPrice ? plainAmount(atPrice.effectiveWant, wantMeta.decimals) : '');
  };
  const pickLevel = (side: BookSide, level: Pick<BookLevel, 'priceTicks' | 'size'>): void => {
    if (!assetsReady || (mode === 'cross' && !crossMarket)) return;
    const { base, quote } = bookMetadata;
    const selectedGive = side === 'ask' ? book.quoteTokenId : book.baseTokenId;
    // The target hub can own the book; spendable capacity still belongs to our source Account.
    const picked = pickBookLevel({
      side,
      level,
      baseDecimals: base.decimals,
      quoteDecimals: quote.decimals,
      capacity: hub?.tokens.find(token => token.tokenId === selectedGive)?.derived.outCapacity ?? 0n,
      ...(crossMarket ? { crossSourceIsBase: crossMarket.sourceIsBase } : {}),
    });
    if (!picked) return;
    if (mode === 'same') {
      setGiveTokenId(selectedGive);
      setWantTokenId(side === 'ask' ? book.baseTokenId : book.quoteTokenId);
    }
    const giveDecimals = side === 'ask' ? quote.decimals : base.decimals;
    const wantDecimals = side === 'ask' ? base.decimals : quote.decimals;
    setGiveText(plainAmount(picked.give, giveDecimals));
    setWantTextState(plainAmount(picked.want, wantDecimals));
    setPickedPriceTicks(mode === 'same' ? level.priceTicks : null);
  };

  // A level picked on the Desk arrives as query parameters, because the Desk
  // renders the book of a hub the Swap screen has not chosen yet. It is applied
  // once, so it can never fight what the person types afterwards.
  const deskPick = useRef(false);
  useEffect(() => {
    if (deskPick.current || !hub || !assetsReady) return;
    const side = params.get('side');
    const price = params.get('price');
    const size = params.get('size');
    if (side === null && price === null && size === null) return;
    deskPick.current = true;
    // A shared Desk URL is untrusted input, not an admitted market level.
    // Reject malformed or nonpositive quotes before BigInt can crash the wallet.
    if (
      (side !== 'ask' && side !== 'bid') ||
      !price ||
      !size ||
      !/^[1-9]\d*$/.test(price) ||
      !/^[1-9]\d*$/.test(size)
    ) {
      toast('Invalid swap link. Choose a price from the order book.', 'danger');
      return;
    }
    pickLevel(side, { priceTicks: BigInt(price), size: BigInt(size) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, params, assetsReady]);

  const giveToken = hub?.tokens.find(token => token.tokenId === giveTokenId) ?? null;
  const giveSpendable = giveToken?.derived.outCapacity ?? 0n;

  const parsedGive = useMemo(() => {
    if (!assetsReady) return null;
    try {
      const value = parseAmount(giveText || '0', giveMeta.decimals);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  }, [giveText, giveMeta.decimals, assetsReady]);
  // Cross amounts require an explicit minimum or an explicit pick from their own venue.
  const impliedWantText = useMemo(() => {
    if (!assetsReady || mode === 'cross' || !book || wantText.trim() || !giveText.trim()) return '';
    let give: bigint;
    try {
      give = parseAmount(giveText, giveMeta.decimals);
    } catch {
      return '';
    }
    if (give <= 0n) return '';
    const base = getTokenMeta(book.baseTokenId, sourceTokens.catalog);
    const quote = getTokenMeta(book.quoteTokenId, sourceTokens.catalog);
    const quoteAtLevel = quoteAtBestLevel(book, giveTokenId, wantTokenId, give, base.decimals, quote.decimals);
    return quoteAtLevel ? plainAmount(quoteAtLevel.want, wantMeta.decimals) : '';
  }, [
    mode,
    book,
    wantText,
    giveText,
    giveTokenId,
    wantTokenId,
    giveMeta.decimals,
    wantMeta.decimals,
    assetsReady,
    sourceTokens.catalog,
  ]);
  const parsedWant = useMemo(() => {
    if (!assetsReady) return null;
    try {
      const value = parseAmount(wantText || impliedWantText || '0', wantMeta.decimals);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  }, [wantText, impliedWantText, wantMeta.decimals, assetsReady]);

  // A typed amount the parser refuses must say why, not just disable Swap.
  const inputError = (text: string, decimals: number): string | null => {
    if (!text.trim()) return null;
    try {
      parseAmount(text, decimals);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };
  const amountError = inputError(giveText, giveMeta.decimals) ?? inputError(wantText, wantMeta.decimals);

  // Equal token ids on distinct jurisdictions identify different balances.
  const sameToken = mode === 'same' && giveTokenId === wantTokenId;
  const prepared = useMemo(() => {
    if (!xln || !parsedGive || !parsedWant || sameToken) return null;
    const dimensions = { giveTokenDecimals: giveMeta.decimals, wantTokenDecimals: wantMeta.decimals };
    try {
      // Give dust would shift a price rebuilt from amounts; at a picked level, quantize first.
      const atPrice =
        pickedPriceTicks === null
          ? null
          : requantizeRemainingSwapAtPriceForDimensions(giveTokenId, wantTokenId, parsedGive, pickedPriceTicks, dimensions);
      return atPrice
        ? prepareSwapOrderForDimensions(giveTokenId, wantTokenId, atPrice.effectiveGive, atPrice.effectiveWant, dimensions)
        : prepareSwapOrderForDimensions(giveTokenId, wantTokenId, parsedGive, parsedWant, dimensions);
    } catch {
      return null;
    }
  }, [xln, sameToken, giveTokenId, wantTokenId, parsedGive, parsedWant, giveMeta.decimals, wantMeta.decimals, pickedPriceTicks]);

  const feeBps = useMemo(() => {
    if (!hub || mode !== 'same') return null;
    try {
      return hubTakerFeeBps(hub.counterpartyId);
    } catch {
      return null;
    }
  }, [hub, mode, wallet.frameHeight]);

  const overCapacity = Boolean(prepared && prepared.effectiveGive > giveSpendable);

  // Inbound room on the target account for what we want to receive.
  const targetInbound = useMemo(() => {
    if (!xln || !targetAccount || !targetEntity || !targetHub) return 0n;
    const delta = targetAccount.deltas.get(wantTokenId);
    if (!delta) return 0n;
    const isLeft = xln.isLeftEntity(targetEntity.entityId, targetHub.entityId);
    return xln.deriveDelta(delta, isLeft).inCapacity;
  }, [xln, targetAccount, targetEntity, targetHub, wantTokenId]);

  const receiveRequired = prepared?.effectiveWant ?? parsedWant ?? 0n;
  const receiveCapacity =
    mode === 'cross'
      ? targetInbound
      : (hub?.tokens.find(token => token.tokenId === wantTokenId)?.derived.inCapacity ?? 0n);
  const inboundReady = receiveRequired > 0n && receiveCapacity >= receiveRequired;
  const receivingAccount = mode === 'cross' ? targetAccount : hub?.doc.state;
  const receivingOwnerId = mode === 'cross' ? targetEntity?.entityId : wallet.entityId;
  const receivingHubId = mode === 'cross' ? targetHub?.entityId : hub?.counterpartyId;
  const receivingHubLabel = mode === 'cross' ? targetHub?.label : hub?.label;
  const receivingFeePolicy =
    receivingAccount && receivingOwnerId && receivingHubId && xln
      ? counterpartyFeePolicy(
          { state: receivingAccount },
          xln.isLeftEntity(receivingOwnerId, receivingHubId),
          wantTokenId,
        )
      : null;

  // Asset pickers invalidate an explicit pair-specific limit; Flip intentionally preserves both swapped amounts.
  const flip = (): void => {
    if (!assetsReady) return;
    if (mode === 'cross') {
      if (!targetEntity || !targetHub || !hub) return;
      // A cross asset is (Depository, token id). Reverse both owners and hub
      // accounts, including when the two legs have the same local token id.
      setTargetEntityId(wallet.entityId);
      setTargetHubId(hub.counterpartyId);
      setHubId(normalizeId(targetHub.entityId));
      switchActiveEntity(targetEntity.entityId);
    }
    setGiveTokenId(wantTokenId);
    setWantTokenId(giveTokenId);
    setGiveText(wantText);
    setWantText(giveText);
  };

  const place = async (): Promise<void> => {
    if (!wallet.frame || !hub || !prepared || !wallet.signerId) return;
    if (
      mode === 'same' &&
      (swapMinimumError(book, giveTokenId, prepared, getTokenMeta(book.quoteTokenId, sourceTokens.catalog)) || swapPriceBandError(book, prepared.priceTicks))
    )
      return;
    setSubmitting(true);
    let tutorialOfferId: string | null = null;
    try {
      const source = {
        entityId: wallet.entityId,
        signerId: wallet.signerId,
        hubEntityId: hub.counterpartyId,
        jurisdiction: jurisdictionRef(wallet.frame),
        account:
          (wallet.frame.activeEntity?.accounts.items.find(doc => {
            const left = normalizeId(doc.state.leftEntity);
            const right = normalizeId(doc.state.rightEntity);
            return (left === wallet.entityId ? right : left) === hub.counterpartyId;
          })?.state as AccountState | undefined) ?? null,
      };
      const target =
        mode === 'cross' && targetEntity && targetHub
          ? {
              entityId: normalizeId(targetEntity.entityId),
              signerId: normalizeId(targetEntity.signerId),
              hubEntityId: normalizeId(targetHub.entityId),
              jurisdiction: getJurisdictionStackId(targetEntity.jurisdiction),
              account: targetAccount ?? null,
            }
          : undefined;
      const plan = await planSwap({
        mode,
        frame: wallet.frame,
        source,
        ...(target ? { target } : {}),
        giveTokenId,
        giveTokenDecimals: giveMeta.decimals,
        wantTokenId,
        wantTokenDecimals: wantMeta.decimals,
        giveAmount: prepared.effectiveGive,
        priceTicks: prepared.priceTicks,
        expectedWantAmount: prepared.effectiveWant,
        routeValue: target ? `cross:${hub.counterpartyId}>${target.hubEntityId}` : `same:${hub.counterpartyId}`,
      });
      const app = useApp.getState();
      const runtimeId = getAdapter()?.runtimeId;
      if (plan.mode === 'same' && app.tour.active && TOUR_STEPS[app.tour.index]?.id === 'trade' && runtimeId) {
        tutorialOfferId = plan.offerId;
        useTutorialTrade.getState().setPending({
          runtimeId,
          entityId: wallet.entityId,
          counterpartyId: hub.counterpartyId,
          offerId: plan.offerId,
          fromHeight: app.height + 1,
        });
      }
      await submitSwapPlan(plan);
      toast(
        mode === 'cross'
          ? `Cross-network swap submitted: ${plainAmount(prepared.effectiveGive, giveMeta.decimals)} ${giveMeta.symbol} for ${plainAmount(prepared.effectiveWant, wantMeta.decimals)} ${wantMeta.symbol}`
          : `Order placed: ${plainAmount(prepared.effectiveGive, giveMeta.decimals)} ${giveMeta.symbol} for ${plainAmount(prepared.effectiveWant, wantMeta.decimals)} ${wantMeta.symbol}`,
      );
      setGiveText('');
      setWantText('');
    } catch (error) {
      if (tutorialOfferId && useTutorialTrade.getState().pending?.offerId === tutorialOfferId) {
        useTutorialTrade.getState().setPending(null);
      }
      toast(error instanceof Error ? error.message : String(error), 'danger');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (offerCounterpartyId: string, offerId: string): Promise<void> => {
    if (!wallet.entityId || !wallet.signerId) return;
    setCancelingId(offerId);
    try {
      await sendEntityTxs(wallet.entityId, wallet.signerId, [
        { type: 'proposeCancelSwap', data: { counterpartyEntityId: offerCounterpartyId, offerId } },
      ]);
      toast('Cancellation requested');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'danger');
    } finally {
      setCancelingId(null);
    }
  };

  /**
   * A cross order rests across two chains, so cancelling it bilaterally is not
   * enough: the entity has to ask for the route to be cleared. Without this a
   * position that stopped moving stayed on the books for good.
   */
  const clearCross = async (orderId: string, cancelRemainder: boolean): Promise<void> => {
    if (!wallet.entityId || !wallet.signerId) return;
    setCancelingId(orderId);
    try {
      await sendEntityTxs(wallet.entityId, wallet.signerId, [
        { type: 'requestCrossJurisdictionClear', data: { orderId, cancelRemainder } },
      ]);
      toast(cancelRemainder ? 'Cancel and clear requested' : 'Clear requested');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'danger');
    } finally {
      setCancelingId(null);
    }
  };

  const mine = openSwapOffers(wallet.frame, wallet.entityId).filter(offer => offer.mine);
  const crossOrders = liveCrossOrders(wallet.frame, wallet.entityId);
  const networkLabel = (stack: string): string =>
    wallet.summaries.find(summary => summary.jurisdiction && getJurisdictionStackId(summary.jurisdiction) === stack)
      ?.jurisdiction?.name || stack;
  const marketError =
    mode === 'same' && prepared
      ? (swapMinimumError(book, giveTokenId, prepared, getTokenMeta(book.quoteTokenId, sourceTokens.catalog)) ?? swapPriceBandError(book, prepared.priceTicks))
      : null;
  const disabledReason =
    (sourceTokens.error ||
      receiveTokens.error ||
      (!sourceTokens.ready || !receiveTokens.ready
        ? 'Loading network token catalogs'
        : !assetsReady
          ? 'Choose an available token on each network'
          : null)) ??
    (mode === 'cross'
      ? targetAccountError ||
        (!targetEntity || !targetHub ? 'Choose an available destination on the same hub runtime' : null)
      : null) ??
    amountError ??
    marketError ??
    (!hub
      ? 'No hub account to swap through'
      : sameToken
        ? 'Choose two different tokens'
        : overCapacity
          ? 'Exceeds what you can send'
          : null);

  return (
    <div
      className="screen fade-in"
      data-testid="swap-screen"
      data-route-mode={mode}
      data-source-jurisdiction={wallet.jurisdiction}
      data-target-jurisdiction={mode === 'cross' ? targetEntity?.jurisdiction?.name : wallet.jurisdiction}
    >
      <PageHead
        title="Swap"
        parent={HOME}
        actions={
          <span className="segc">
            <button
              type="button"
              className={mode === 'same' ? 'active' : ''}
              onClick={() => {
                if (mode !== 'same') setWantText('');
                setMode('same');
              }}
            >
              Same network
            </button>
            <button
              type="button"
              className={mode === 'cross' ? 'active' : ''}
              data-testid="swap-cross-mode"
              aria-pressed={mode === 'cross'}
              onClick={() => {
                if (mode !== 'cross') setWantText('');
                setMode('cross');
              }}
              disabled={otherEntities.length === 0}
            >
              Across networks
            </button>
          </span>
        }
      />

      <div className="two-col pay">
        <div className="stack">
          <div className="field">
            <div className="field-head">
              <span>You pay</span>
              <button
                type="button"
                className="btn quiet num"
                style={{ fontSize: 12 }}
                disabled={giveSpendable <= 0n}
                onClick={() => setGiveAmount(amountInputText(giveSpendable, giveMeta.decimals))}
              >
                Up to {formatLimit(giveSpendable, giveMeta.decimals)}
                {hub ? ` with ${hub.label}` : ''}
              </button>
            </div>
            <div className="field-row">
              <input
                className="input big"
                placeholder="0.00"
                inputMode="decimal"
                value={giveText}
                onChange={event => setGiveAmount(event.target.value)}
                data-testid="swap-give"
              />
              <TokenPicker
                tokenId={giveTokenId}
                catalog={sourceTokens.catalog}
                onChange={tokenId => {
                  if (tokenId !== giveTokenId) setWantText('');
                  setGiveTokenId(tokenId);
                }}
                {...(mode === 'same' ? { exclude: wantTokenId } : {})}
                {...(wallet.jurisdiction ? { chip: wallet.jurisdiction } : {})}
              />
            </div>
          </div>
          <div className="flip">
            <button
              type="button"
              onClick={flip}
              aria-label="Flip"
              data-testid="swap-flip"
              disabled={!assetsReady || (mode === 'cross' && !crossMarket)}
            >
              <Icon name="swap" size={16} />
            </button>
          </div>
          <div className="field">
            <div className="field-head">
              <span>{mode === 'cross' ? 'Minimum to receive' : 'You receive'}</span>
              <span>
                {mode === 'cross' && targetEntity
                  ? `into your ${targetEntity.jurisdiction?.name || 'other'} account`
                  : hub
                    ? `from ${hub.label}`
                    : ''}
              </span>
            </div>
            <div className="field-row">
              <input
                className="input big"
                style={{ color: 'var(--accent-2)' }}
                placeholder={
                  impliedWantText
                    ? plainAmount(parseAmount(impliedWantText, wantMeta.decimals), wantMeta.decimals).replace(
                        /(\.\d{6})\d+$/,
                        '$1',
                      )
                    : '0.00'
                }
                inputMode="decimal"
                value={wantText}
                onChange={event => setWantText(event.target.value)}
                data-testid="swap-want"
              />
              <TokenPicker
                tokenId={wantTokenId}
                catalog={receiveTokens.catalog}
                onChange={tokenId => {
                  if (tokenId !== wantTokenId) setWantText('');
                  setWantTokenId(tokenId);
                }}
                {...(mode === 'same' ? { exclude: giveTokenId } : {})}
                {...(mode === 'cross' && targetEntity?.jurisdiction?.name
                  ? { chip: targetEntity.jurisdiction.name }
                  : {})}
              />
            </div>
            {mode === 'cross' || (giveText.trim() && !wantText.trim()) ? (
              <div className="note" style={{ marginTop: 8 }} data-testid="swap-quote-note">
                {mode === 'cross'
                  ? 'Enter the minimum amount you want on the destination network. This is a limit order, not a live cross-network quote. It may remain open until matching liquidity is available.'
                  : impliedWantText
                    ? `Quoted at the best price in the book right now. Type your own amount to set a limit; the order then rests on your account until ${hub?.label ?? 'the hub'} fills it.`
                    : `Set the amount you want. The order rests on your account at that price until ${hub?.label ?? 'the hub'} fills it.`}
              </div>
            ) : null}
          </div>

          {hubs.length > 1 && (
            <div className="chips">
              {hubs.map(account => (
                <button
                  key={account.counterpartyId}
                  type="button"
                  className={hub?.counterpartyId === account.counterpartyId ? 'active' : ''}
                  onClick={() => setHubId(account.counterpartyId)}
                >
                  {account.label}
                </button>
              ))}
            </div>
          )}

          {mode === 'cross' && (
            <div className="card tight">
              <p className="note" data-testid="cross-swap-safety">
                Stay online for this cross-network swap: this device relays the secrets needed to complete it. Use Clear
                to settle filled amounts, or Cancel rest to settle fills and release the unfilled part. Check the
                destination balance and final status; submission alone does not mean delivery.
              </p>
              <div className="kv">
                <span className="k">Your other account</span>
                <span className="v">
                  <select
                    className="input"
                    style={{ width: 'auto', textAlign: 'right' }}
                    value={targetEntity ? normalizeId(targetEntity.entityId) : ''}
                    onChange={event => setTargetEntityId(event.target.value)}
                  >
                    {otherEntities.map(summary => (
                      <option key={summary.entityId} value={normalizeId(summary.entityId)}>
                        {summary.label || summary.entityId.slice(0, 10)} · {summary.jurisdiction?.name || 'unknown'}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
              <div className="kv">
                <span className="k">Hub there</span>
                <span className="v">
                  <select
                    className="input"
                    style={{ width: 'auto', textAlign: 'right' }}
                    value={targetHub ? normalizeId(targetHub.entityId) : ''}
                    onChange={event => setTargetHubId(event.target.value)}
                  >
                    {targetHubs.map(summary => (
                      <option key={summary.entityId} value={normalizeId(summary.entityId)}>
                        {summary.label || summary.entityId.slice(0, 10)}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            </div>
          )}

          {prepared && (
            <div className="card tight">
              <div className="kv">
                <span className="k">Limit price</span>
                <span className="v num" data-testid="swap-limit-price">
                  {formatMoney(prepared.priceTicks, 4, 4)} {prepared.side === 1 ? wantMeta.symbol : giveMeta.symbol} per{' '}
                  {prepared.side === 1 ? giveMeta.symbol : wantMeta.symbol}
                </span>
              </div>
              {mode === 'same' && (
                <div className="kv">
                  <span className="k">Hub fee</span>
                  <span className={`v num ${feeBps === null ? 'st-pending' : ''}`}>
                    {feeBps === null
                      ? 'not published yet'
                      : `${feeBps} bps · up to ${formatAmount((prepared.effectiveWant * BigInt(feeBps) + 9_999n) / 10_000n, wantMeta.decimals, wantMeta.decimals)} ${wantMeta.symbol}`}
                  </span>
                </div>
              )}
              <div className="kv">
                <span className="k">Route</span>
                <span className="hops">
                  <span className="hop">{wallet.jurisdiction || 'here'}</span>
                  <Icon name="arrow" size={12} />
                  <span className="hop me">{hub?.label ?? 'hub'}</span>
                  {mode === 'cross' && targetEntity ? (
                    <>
                      <Icon name="arrow" size={12} />
                      <span className="hop">{targetEntity.jurisdiction?.name || 'there'}</span>
                    </>
                  ) : null}
                </span>
              </div>
              <div className="kv">
                <span className="k">Settlement</span>
                <span className="v" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="link" size={14} />
                  {mode === 'cross' ? 'Atomic · both legs or neither' : 'Bilateral · signed by both sides'}
                </span>
              </div>
              {prepared.unspentGiveAmount > 0n && (
                <div className="kv">
                  <span className="k">Lot rounding</span>
                  <span className="v num muted" style={{ fontWeight: 400 }}>
                    {formatMoney(prepared.unspentGiveAmount, giveMeta.decimals, 6)} {giveMeta.symbol} stays with you
                  </span>
                </div>
              )}
            </div>
          )}

          {targetAccountError && mode === 'cross' ? (
            <p className="note" role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {explainWalletError(targetAccountError)}
            </p>
          ) : null}
          {!inboundReady && receiveRequired > 0n ? (
            <p className="note">
              Placing this order also prepares incoming capacity with {receivingHubLabel}. The hub may owe you the
              received amount until it is collateralized.
            </p>
          ) : null}
          {mode === 'cross' && targetAccount && inboundReady && targetEntity && targetHub && (
            <div className="check">
              <span className="ck">
                <Icon name="check" size={11} />
              </span>
              <span>
                {targetEntity.jurisdiction?.name} account with {targetHub.label} is ready to receive {wantMeta.symbol}
              </span>
            </div>
          )}

          {prepared && receivingHubId && receivingOwnerId ? (
            <section
              className="card tight"
              aria-label="Receiving fees"
              data-testid="swap-receive-fees"
              style={{ overflowWrap: 'anywhere' }}
            >
              <p className="note">
                <b>
                  Gross receive: {amountInputText(prepared.effectiveWant, wantMeta.decimals)} {wantMeta.symbol}
                </b>{' '}
                before fees.
              </p>
              {receivingFeePolicy ? (
                <p
                  className="note"
                  data-testid="swap-rebalance-tariff"
                  data-policy-version={receivingFeePolicy.policyVersion}
                >
                  {receivingHubLabel} collateral tariff:{' '}
                  {amountInputText(receivingFeePolicy.baseFee, wantMeta.decimals)} {wantMeta.symbol} base +{' '}
                  {amountInputText(receivingFeePolicy.gasFee, wantMeta.decimals)} {wantMeta.symbol} gas +{' '}
                  {receivingFeePolicy.liquidityFeeBps.toString()} bps of the collateral requested.
                </p>
              ) : (
                <p className="note">
                  The receiving account has no committed collateral fee policy available. This does not mean zero fees.
                </p>
              )}
              <p className="note">
                If your account automatically requests collateral after receiving, its fee is deducted from your
                balance. The final fee and net amount depend on your account policy and balance at that time.
              </p>
              {receivingAccount ? (
                <Link
                  className="btn quiet"
                  to={`/accounts/${receivingHubId}`}
                  onClick={() => {
                    // The receiving account belongs to our sibling entity on the other chain:
                    // the same switch the entity switcher performs, so nothing per-entity survives it.
                    switchActiveEntity(receivingOwnerId);
                    useApp.getState().setSelectedTokenId(wantTokenId);
                  }}
                >
                  Receiving account · collateral settings
                </Link>
              ) : null}
            </section>
          ) : null}
          {mode === 'cross' &&
          crossMarket &&
          hub &&
          targetHub &&
          targetEntity &&
          book.pairId === crossMarket.pairId &&
          (book.status === 'no-market' ||
            book.status === 'unavailable' ||
            (book.status === 'live' && book.asks.length === 0 && book.bids.length === 0)) ? (
            <ManualSwapRoutes
              sourceHubId={hub.counterpartyId}
              targetHubId={targetHub.entityId}
              sourceStack={sourceStack}
              targetStack={targetStack}
              sourceNetwork={wallet.jurisdiction}
              targetNetwork={targetEntity.jurisdiction?.name ?? ''}
              sourceToken={giveTokenId}
              targetToken={wantTokenId}
            />
          ) : null}
          {disabledReason && (giveText || wantText) ? (
            <p
              style={{
                color: !inboundReady && !overCapacity && !sameToken && hub ? 'var(--ink-2)' : 'var(--dispute)',
                fontSize: 12.5,
              }}
            >
              {disabledReason}
            </p>
          ) : null}

          <button
            type="button"
            className="btn primary"
            data-testid="swap-submit"
            disabled={!commandReady || !prepared || Boolean(disabledReason) || submitting || !wallet.signerId}
            onClick={() => void place()}
          >
            <Icon name="swap" size={15} />
            {submitting ? 'Placing…' : prepared ? `Swap ${giveMeta.symbol} for ${wantMeta.symbol}` : 'Swap'}
          </button>

          {hub && giveToken ? (
            <div className="card">
              <h3 className="caps">Your account with {hub.label}</h3>
              <DeltaBar derived={giveToken.derived} tokenId={giveTokenId} />
              <DeltaCaption derived={giveToken.derived} format={value => formatLimit(value, giveMeta.decimals)} />
              <p className="note" style={{ marginTop: 12 }}>
                The order rests on this account: a fill moves the balance you both sign, nothing moves on-chain.
              </p>
            </div>
          ) : null}

          {hub && (mode === 'same' || crossMarket) ? (
            <div className="mobile-only card">
              <div className="sect" style={{ marginTop: 0 }}>
                <h3 className="caps">Book</h3>
                <button type="button" className="more" onClick={() => setShowBook(value => !value)}>
                  {showBook ? 'Hide' : 'Show'}
                </button>
              </div>
              {showBook ? (
                <Orderbook
                  book={book}
                  metadata={bookMetadata}
                  hubLabel={bookHubLabel}
                  hubId={bookHubId}
                  relayUrl={bookRelayUrl}
                  {...(crossLabel ? { marketLabel: crossLabel } : {})}
                  onPick={pickLevel}
                />
              ) : null}
            </div>
          ) : null}

          {crossOrders.length > 0 && (
            <div data-testid="cross-orders">
              <div className="sect">
                <h3 className="caps">Cross-network orders</h3>
                <span className="more">{crossOrders.length}</span>
              </div>
              {crossOrders.map((order, index) => {
                const sMeta = getTokenMeta(order.sourceTokenId);
                const tMeta = getTokenMeta(order.targetTokenId);
                return (
                  <div
                    key={order.orderId}
                    className={`row${index === 0 ? ' first' : ''}`}
                    data-testid="cross-order-row"
                    data-order-id={order.orderId}
                  >
                    <div className="rt">
                      <span className="ev-ic swap">
                        <Icon name="swap" size={15} />
                      </span>
                      <span className="tx">
                        <span className="t num">
                          {plainAmount(order.sourceAmount, sMeta.decimals)} {sMeta.symbol} on{' '}
                          {networkLabel(order.sourceJurisdiction) || 'source'} for{' '}
                          {plainAmount(order.targetAmount, tMeta.decimals)} {tMeta.symbol} on{' '}
                          {networkLabel(order.targetJurisdiction) || 'target'}
                        </span>
                        <span className="s">
                          {order.filledSourceAmount > 0n
                            ? `filled ${plainAmount(order.filledSourceAmount, sMeta.decimals)} ${sMeta.symbol} so far`
                            : 'nothing filled yet'}
                        </span>
                      </span>
                      <span className="r">
                        <span className="state st-inflight">{order.status.replace(/_/g, ' ')}</span>
                        <div>
                          <button
                            type="button"
                            className="btn quiet"
                            style={{ fontSize: 12 }}
                            disabled={!commandReady || cancelingId === order.orderId || order.clearRequested}
                            onClick={() => void clearCross(order.orderId, false)}
                            data-testid="cross-order-clear"
                          >
                            {order.clearRequested ? 'Clearing…' : 'Clear'}
                          </button>
                          <button
                            type="button"
                            className="btn quiet"
                            style={{ fontSize: 12 }}
                            disabled={!commandReady || cancelingId === order.orderId || order.clearRequested}
                            onClick={() => void clearCross(order.orderId, true)}
                            data-testid="cross-order-cancel-clear"
                          >
                            Cancel rest
                          </button>
                        </div>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {mine.length > 0 && (
            <div>
              <div className="sect">
                <h3 className="caps">Your open orders</h3>
                <span className="more">{mine.length}</span>
              </div>
              {/* An order that fills leaves this list without a word, and the
							    only record of the price it got is the movement it wrote. */}
              <p className="note" style={{ padding: '2px 0 8px' }}>
                A filled order leaves this list. What it traded at is on <Link to="/activity">Activity</Link>.
              </p>
              {mine.map((offer, index) => {
                const gMeta = getTokenMeta(offer.giveTokenId);
                const wMeta = getTokenMeta(offer.wantTokenId);
                return (
                  <div key={`${offer.counterpartyId}-${offer.offerId}`} className={`row${index === 0 ? ' first' : ''}`}>
                    <div className="rt">
                      <span className="ev-ic swap">
                        <Icon name="swap" size={15} />
                      </span>
                      <span className="tx">
                        <span className="t num">
                          {plainAmount(offer.giveAmount, gMeta.decimals)} {gMeta.symbol} for{' '}
                          {plainAmount(offer.wantAmount, wMeta.decimals)} {wMeta.symbol}
                        </span>
                        <span className="s">
                          with {wallet.names.get(offer.counterpartyId) || 'hub'} · height {offer.createdHeight}
                        </span>
                      </span>
                      <span className="r">
                        <span className="state st-inflight">open</span>
                        <div>
                          <button
                            type="button"
                            className="btn quiet"
                            style={{ fontSize: 12 }}
                            disabled={!commandReady || cancelingId === offer.offerId}
                            onClick={() => void cancel(offer.counterpartyId, offer.offerId)}
                            data-testid="swap-offer-cancel"
                          >
                            {cancelingId === offer.offerId ? 'Canceling…' : 'Cancel'}
                          </button>
                        </div>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="aside desktop-only">
          {hub && (mode === 'same' || crossMarket) ? (
            <div className="card">
              <div className="sect" style={{ marginTop: 0 }}>
                <h3 className="caps">Book</h3>
                <button type="button" className="more" onClick={() => setShowBook(value => !value)}>
                  {showBook ? 'Hide' : 'Show'}
                </button>
              </div>
              {showBook ? (
                <Orderbook
                  book={book}
                  metadata={bookMetadata}
                  hubLabel={bookHubLabel}
                  hubId={bookHubId}
                  relayUrl={bookRelayUrl}
                  {...(crossLabel ? { marketLabel: crossLabel } : {})}
                  onPick={pickLevel}
                />
              ) : null}
            </div>
          ) : null}
          {mode === 'cross' ? (
            <div className="card">
              <h3 className="caps">Legs</h3>
              <div className="tl">
                <div className="ev">
                  <div className="t">1 · {wallet.jurisdiction || 'here'}</div>
                  <div className="s">
                    You lock {prepared ? plainAmount(prepared.effectiveGive, giveMeta.decimals) : '…'} {giveMeta.symbol}{' '}
                    with {hub?.label ?? 'the hub'}
                  </div>
                </div>
                <div className="ev">
                  <div className="t">2 · {targetEntity?.jurisdiction?.name || 'there'}</div>
                  <div className="s">
                    {targetHub?.label ?? 'The hub'} pays{' '}
                    {prepared ? plainAmount(prepared.effectiveWant, wantMeta.decimals) : '…'} {wantMeta.symbol} into
                    your account there
                  </div>
                </div>
                <div className="ev">
                  <div className="t">Clear</div>
                  <div className="s">
                    A shared secret links both legs. Stay online and use the order controls to clear fills or cancel the
                    remainder; verify the final balances.
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {hubs.length === 0 && (
            <div className="card">
              <p className="note">Open an account with a hub to swap. Hubs run the order books.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export type { RuntimeAdapterEntitySummary };
