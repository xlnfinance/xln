  <script lang="ts">
    import type { EntityReplica, Tab } from '$lib/types/ui';
    import { getXLN, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
    import { isLive as globalIsLive } from '../../stores/timeStore';
    import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
    import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
    import BigIntInput from '../Common/BigIntInput.svelte';
    import EntitySelect from './EntitySelect.svelte';
    import OrderbookPanel from '../Trading/OrderbookPanel.svelte';

  export let replica: EntityReplica | null;
  export let tab: Tab;

  // Props
  export let counterpartyId: string = '';
  export let prefilledCounterparty = false;
  let orderbookScope: 'all' | 'selected' = 'all';
  type BookSide = 'bid' | 'ask';
  type ClickedOrderLevel = { side: BookSide; price: bigint; sizeBase: bigint; baseTokenId: number; quoteTokenId: number; accountId: string };
  let selectedOrderLevel: ClickedOrderLevel | null = null;
  let orderPercent = 100;
  let submitError = '';
  let giveTokenId = '1';
  let giveAmount: bigint = 0n;
  let wantTokenId = '2';
  let wantAmount: bigint = 0n;
  let minFillPercent = '50'; // Min fill ratio as percentage (0-100)

    const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
    const contextXlnFunctions = entityEnv?.xlnFunctions;
    const contextEnv = entityEnv?.env;
    const contextIsLive = entityEnv?.isLive;
    $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
    $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;
    $: activeIsLive = contextIsLive ? $contextIsLive : $globalIsLive;

    // Get available accounts (counterparties)
  $: accounts = replica?.state?.accounts
    ? Array.from(replica.state.accounts.keys())
    : [];
  $: baseAccountIds = accounts.map((id) => String(id)).sort();
  $: accountIds = (() => {
    const selected = String(counterpartyId || '');
    if (!selected || !baseAccountIds.includes(selected)) return baseAccountIds;
    return [selected, ...baseAccountIds.filter((id) => id !== selected)];
  })();
  $: cappedAccountIds = accountIds.slice(0, 10);
  $: hiddenAccountCount = Math.max(0, accountIds.length - cappedAccountIds.length);
  $: if (orderbookScope === 'selected' && !counterpartyId) {
    orderbookScope = 'all';
  }
  $: orderbookHubIds = orderbookScope === 'selected'
    ? (counterpartyId ? [counterpartyId] : [])
    : cappedAccountIds;

  function resolveCounterpartyId(input: string): string {
    const normalized = String(input || '').trim().toLowerCase();
    if (!normalized) return '';
    const match = accountIds.find((id) => String(id || '').toLowerCase() === normalized);
    return match || String(input || '').trim();
  }
  $: orderbookHint = (() => {
    if (orderbookScope === 'selected') {
      return counterpartyId
        ? 'Showing selected account orderbook.'
        : 'Select account to view selected orderbook.';
    }
    if (orderbookHubIds.length === 0) {
      return 'Select account to trade. No orderbook sources yet.';
    }
    const hidden = hiddenAccountCount > 0 ? ` (+${hiddenAccountCount} hidden)` : '';
    return `Showing aggregate orderbook across ${orderbookHubIds.length} account(s)${hidden}. Select account to place orders.`;
  })();

  const DEFAULT_SWAP_TOKEN_IDS = [1, 2, 3];
  type TokenKeyedMap<V> = Map<number, V> | Map<string, V>;

  function parseTokenId(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'bigint' && value > 0n) return Number(value);
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
    return null;
  }

  function getTokenMapValue<V>(map: TokenKeyedMap<V> | undefined, tokenIdValue: number): V | undefined {
    if (!(map instanceof Map) || !Number.isFinite(tokenIdValue)) return undefined;
    const byNumber = (map as Map<number, V>).get(tokenIdValue);
    if (byNumber !== undefined) return byNumber;
    return (map as Map<string, V>).get(String(tokenIdValue));
  }

  function buildAvailableTokenIds(): number[] {
    const accountTokenIds = new Set<number>();
    const account = counterpartyId ? replica?.state?.accounts?.get?.(counterpartyId) : null;
    const deltas = account?.deltas;
    if (deltas instanceof Map) {
      for (const [id] of deltas.entries()) {
        const parsed = parseTokenId(id);
        if (parsed) accountTokenIds.add(parsed);
      }
    }

    // Use account token universe first (swap is account-scoped). If too small, augment.
    if (accountTokenIds.size >= 2) {
      return Array.from(accountTokenIds.values()).sort((a, b) => a - b);
    }

    const tokenIds = new Set<number>(Array.from(accountTokenIds.values()));
    const reserves = replica?.state?.reserves;
    if (reserves instanceof Map) {
      for (const [id] of reserves.entries()) {
        const parsed = parseTokenId(id);
        if (parsed) tokenIds.add(parsed);
      }
    }
    for (const id of DEFAULT_SWAP_TOKEN_IDS) tokenIds.add(id);
    return Array.from(tokenIds.values()).sort((a, b) => a - b);
  }

  // Get available tokens from canonical entity/account state (no UI cache).
  $: availableTokenIds = buildAvailableTokenIds();
  $: availableTokens = availableTokenIds.map((id) => {
    const reserves = replica?.state?.reserves as TokenKeyedMap<bigint> | undefined;
    const reserve = getTokenMapValue(reserves, id) ?? 0n;
    const tokenInfo = activeXlnFunctions?.getTokenInfo?.(id);
    const symbol = String(tokenInfo?.symbol || '').trim();
    return {
      id: id.toString(),
      name: symbol ? `${symbol} (Token #${id})` : `Token #${id}`,
      amount: typeof reserve === 'bigint' ? reserve : 0n,
    };
  });

  $: {
    const giveToken = Number.parseInt(giveTokenId, 10);
    if (!Number.isFinite(giveToken) || !availableTokenIds.includes(giveToken)) {
      const first = availableTokenIds[0];
      if (first) giveTokenId = String(first);
    }
    const wantToken = Number.parseInt(wantTokenId, 10);
    if (!Number.isFinite(wantToken) || !availableTokenIds.includes(wantToken) || wantTokenId === giveTokenId) {
      const alternative = availableTokenIds.find((id) => String(id) !== giveTokenId) ?? availableTokenIds[0];
      if (alternative) wantTokenId = String(alternative);
    }
  }

  $: giveToken = Number.parseInt(giveTokenId, 10);
  $: wantToken = Number.parseInt(wantTokenId, 10);
  $: orderbookPairId =
    Number.isFinite(giveToken) &&
    Number.isFinite(wantToken) &&
    giveToken > 0 &&
    wantToken > 0 &&
    giveToken !== wantToken
      ? `${Math.min(giveToken, wantToken)}/${Math.max(giveToken, wantToken)}`
      : '1/2';

  function parsePairTokens(pairId: string): { baseTokenId: number; quoteTokenId: number } | null {
    const [baseRaw, quoteRaw] = String(pairId || '').split('/');
    const baseTokenId = Number.parseInt(baseRaw || '', 10);
    const quoteTokenId = Number.parseInt(quoteRaw || '', 10);
    if (!Number.isFinite(baseTokenId) || !Number.isFinite(quoteTokenId) || baseTokenId <= 0 || quoteTokenId <= 0) {
      return null;
    }
    return { baseTokenId, quoteTokenId };
  }

  function tokenSymbol(tokenIdValue: number): string {
    if (!Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return 'Token';
    const info = activeXlnFunctions?.getTokenInfo?.(tokenIdValue);
    return String(info?.symbol || `Token #${tokenIdValue}`).trim();
  }

  function parseDecimalAmountToBigInt(raw: string, decimals: number): bigint {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return 0n;
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0n;
    const [wholeRaw, fracRaw = ''] = trimmed.split('.');
    const whole = BigInt(wholeRaw || '0');
    const scale = 10n ** BigInt(Math.max(0, Math.floor(decimals || 0)));
    const fracPadded = (fracRaw + '0'.repeat(Math.max(0, decimals))).slice(0, Math.max(0, decimals));
    const frac = fracPadded ? BigInt(fracPadded) : 0n;
    return whole * scale + frac;
  }

  function resolveEnteredAmount(boundValue: bigint, placeholder: string, decimals: number): bigint {
    if (boundValue > 0n) return boundValue;
    if (typeof document === 'undefined') return boundValue;
    const input = document.querySelector(`.swap-panel input[placeholder="${placeholder}"]`) as HTMLInputElement | null;
    if (!input) return boundValue;
    return parseDecimalAmountToBigInt(input.value, decimals);
  }

  // Get active swap offers for this entity
  $: activeOffers = replica?.state?.swapBook
    ? Array.from(replica.state.swapBook.values())
    : [];

  function readOutCapacity(counterpartyEntityId: string, tokenIdValue: number): bigint {
    if (!counterpartyEntityId || !Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return 0n;
    const resolvedCounterparty = resolveCounterpartyId(counterpartyEntityId);
    const account = replica?.state?.accounts?.get?.(resolvedCounterparty);
    const deltas = account?.deltas as TokenKeyedMap<unknown> | undefined;
    if (!(deltas instanceof Map) || !activeXlnFunctions?.deriveDelta || !tab.entityId) return 0n;
    const delta = getTokenMapValue(deltas, tokenIdValue);
    if (!delta) return 0n;
    const isLeft = String(tab.entityId).toLowerCase() < String(resolvedCounterparty).toLowerCase();
    try {
      const derived = activeXlnFunctions.deriveDelta(delta, isLeft);
      const outCapacityRaw = (derived as { outCapacity?: unknown })?.outCapacity;
      if (typeof outCapacityRaw === 'bigint') return outCapacityRaw;
      return toBigIntSafe(outCapacityRaw) ?? 0n;
    } catch {
      return 0n;
    }
  }

  $: giveTokenSymbol = tokenSymbol(giveToken);
  $: wantTokenSymbol = tokenSymbol(wantToken);
  $: availableGiveCapacity = readOutCapacity(counterpartyId, giveToken);
  $: formattedAvailableGive = Number.isFinite(giveToken) && giveToken > 0
    ? `${formatAmount(availableGiveCapacity, giveToken)} ${giveTokenSymbol}`
    : availableGiveCapacity.toString();
  $: estimatedPrice = formatPriceRatio(wantAmount, giveAmount);
  $: estimatedReceiveLabel = Number.isFinite(wantToken) && wantToken > 0
    ? `${formatAmount(wantAmount, wantToken)} ${wantTokenSymbol}`
    : wantAmount.toString();
  $: estimatedSpendLabel = Number.isFinite(giveToken) && giveToken > 0
    ? `${formatAmount(giveAmount, giveToken)} ${giveTokenSymbol}`
    : giveAmount.toString();

  function validateSwapForm(): string {
    if (!activeIsLive) return 'Switch to LIVE mode to place swap orders.';
    if (!tab.entityId) return 'Entity is not selected.';
    if (!counterpartyId) return 'Select account (hub) first.';
    const hasCounterparty = accountIds.some((id) => String(id || '').toLowerCase() === String(counterpartyId || '').toLowerCase());
    if (!hasCounterparty) return 'Selected account is not active.';
    if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken) || giveToken <= 0 || wantToken <= 0) {
      return 'Select valid Give and Want tokens.';
    }
    if (giveToken === wantToken) return 'Give token and Want token must be different.';
    const minFillPercentValue = Number.parseFloat(minFillPercent);
    if (!Number.isFinite(minFillPercentValue) || minFillPercentValue < 1 || minFillPercentValue > 100) {
      return 'Min Fill % must be between 1 and 100.';
    }
    return '';
  }

  $: swapDisabledReason = validateSwapForm();
  $: capacityWarning = (() => {
    if (!counterpartyId || !Number.isFinite(giveToken) || giveToken <= 0) return '';
    if (availableGiveCapacity <= 0n) return `Observed available ${giveTokenSymbol}: 0 (may update after next frame).`;
    if (giveAmount > 0n && giveAmount > availableGiveCapacity) {
      return `Give amount is above observed available capacity (${formattedAvailableGive}).`;
    }
    return '';
  })();
  $: if (selectedOrderLevel && selectedOrderLevel.accountId !== counterpartyId) {
    selectedOrderLevel = null;
    orderPercent = 100;
  }

  function applyOrderPercent(percent: number) {
    if (!selectedOrderLevel) return;
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    orderPercent = clamped;

    const availableBase = selectedOrderLevel.side === 'ask'
      ? (selectedOrderLevel.price > 0n ? readOutCapacity(selectedOrderLevel.accountId, selectedOrderLevel.quoteTokenId) / selectedOrderLevel.price : 0n)
      : readOutCapacity(selectedOrderLevel.accountId, selectedOrderLevel.baseTokenId);
    const maxFillBase = availableBase < selectedOrderLevel.sizeBase ? availableBase : selectedOrderLevel.sizeBase;
    const fillBase = (maxFillBase * BigInt(clamped)) / 100n;

    if (selectedOrderLevel.side === 'ask') {
      giveAmount = fillBase * selectedOrderLevel.price;
      wantAmount = fillBase;
    } else {
      giveAmount = fillBase;
      wantAmount = fillBase * selectedOrderLevel.price;
    }
  }

  function handleOrderPercentInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement | null;
    const value = Number.parseInt(String(target?.value || ''), 10);
    applyOrderPercent(Number.isFinite(value) ? value : 0);
  }

  function setMaxOrderPercent() {
    if (selectedOrderLevel) {
      applyOrderPercent(100);
      return;
    }
    if (availableGiveCapacity <= 0n) return;
    const currentGive = giveAmount;
    const currentWant = wantAmount;
    giveAmount = availableGiveCapacity;
    if (currentGive > 0n && currentWant > 0n) {
      wantAmount = (availableGiveCapacity * currentWant) / currentGive;
    }
  }

  function handleOrderbookLevelClick(event: CustomEvent<{ side: BookSide; price: number; size: number }>) {
    submitError = '';
    if (!counterpartyId) {
      submitError = 'Select account first, then click an orderbook level.';
      return;
    }

    const pair = parsePairTokens(orderbookPairId);
    if (!pair) {
      submitError = 'Select valid token pair first.';
      return;
    }

    const side = event.detail?.side;
    const rawPrice = Number(event.detail?.price || 0);
    const rawSize = Number(event.detail?.size || 0);
    if ((side !== 'ask' && side !== 'bid') || !Number.isFinite(rawPrice) || rawPrice <= 0 || !Number.isFinite(rawSize) || rawSize <= 0) {
      return;
    }

    const price = BigInt(Math.max(1, Math.floor(rawPrice)));
    const sizeBase = BigInt(Math.max(0, Math.floor(rawSize)));
    selectedOrderLevel = {
      side,
      price,
      sizeBase,
      baseTokenId: pair.baseTokenId,
      quoteTokenId: pair.quoteTokenId,
      accountId: counterpartyId,
    };

    if (side === 'ask') {
      // Take ask: spend quote to receive base.
      giveTokenId = String(pair.quoteTokenId);
      wantTokenId = String(pair.baseTokenId);
    } else {
      // Take bid: spend base to receive quote.
      giveTokenId = String(pair.baseTokenId);
      wantTokenId = String(pair.quoteTokenId);
    }
    applyOrderPercent(100);
  }

  // Convert percentage to fill ratio (0-65535)
  function percentToFillRatio(percent: number): number {
    return Math.floor((percent / 100) * 65535);
  }

  function resolveSignerId(entityId: string): string {
    return activeXlnFunctions?.resolveEntityProposerId?.(activeEnv as any, entityId, 'swap-panel')
      || requireSignerIdForEntity(activeEnv, entityId, 'swap-panel');
  }

  function getTokenDecimals(tokenIdValue: number): number {
    const info = activeXlnFunctions?.getTokenInfo?.(tokenIdValue);
    const decimals = Number(info?.decimals);
    return Number.isFinite(decimals) && decimals >= 0 ? decimals : 18;
  }

  $: giveTokenDecimals = getTokenDecimals(Number.parseInt(giveTokenId, 10));
  $: wantTokenDecimals = getTokenDecimals(Number.parseInt(wantTokenId, 10));

  function isRuntimeEnv(value: unknown): value is { eReplicas: Map<string, unknown>; jReplicas: Map<string, unknown> } {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  function toBigIntSafe(value: unknown): bigint | null {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
    return null;
  }

  function formatPriceRatio(want: unknown, give: unknown, precision = 6): string {
    const wantBig = toBigIntSafe(want);
    const giveBig = toBigIntSafe(give);
    if (wantBig === null || giveBig === null || giveBig <= 0n) return 'n/a';
    const scale = 10n ** BigInt(precision);
    const scaled = (wantBig * scale) / giveBig;
    const whole = scaled / scale;
    const frac = (scaled % scale).toString().padStart(precision, '0').replace(/0+$/, '');
    return frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
  }

  async function placeSwapOffer() {
    submitError = '';
    if (swapDisabledReason) {
      submitError = swapDisabledReason;
      return;
    }

    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const signerId = resolveSignerId(tab.entityId);
      if (!signerId) throw new Error('No signer available for selected entity');

      const resolvedCounterparty = resolveCounterpartyId(counterpartyId);
      if (!resolvedCounterparty) {
        throw new Error('Select counterparty from your account list');
      }

      const giveToken = Number.parseInt(giveTokenId, 10);
      const wantToken = Number.parseInt(wantTokenId, 10);
      const effectiveGiveAmount = resolveEnteredAmount(giveAmount, 'Amount to sell', giveTokenDecimals);
      const effectiveWantAmount = resolveEnteredAmount(wantAmount, 'Amount to receive', wantTokenDecimals);
      if (effectiveGiveAmount <= 0n || effectiveWantAmount <= 0n) {
        throw new Error('Enter Give and Want amounts');
      }
      const allowedTokenIds = new Set(availableTokens.map((token) => Number.parseInt(String(token.id), 10)));
      if (!Number.isFinite(giveToken) || !allowedTokenIds.has(giveToken)) {
        throw new Error('Invalid give token');
      }
      if (!Number.isFinite(wantToken) || !allowedTokenIds.has(wantToken)) {
        throw new Error('Invalid want token');
      }
      if (giveToken === wantToken) {
        throw new Error('Give token and want token must be different');
      }

      const minFillPercentValue = Number.parseFloat(minFillPercent);
      if (!Number.isFinite(minFillPercentValue) || minFillPercentValue < 1 || minFillPercentValue > 100) {
        throw new Error('Min Fill % must be between 1 and 100');
      }

      const offerId = `swap-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const minFillRatio = percentToFillRatio(minFillPercentValue);

      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId: tab.entityId,
        signerId,
        entityTxs: [{
          type: 'placeSwapOffer',
          data: {
            offerId,
            counterpartyEntityId: resolvedCounterparty,
            giveTokenId: giveToken,
            giveAmount: effectiveGiveAmount,
            wantTokenId: wantToken,
            wantAmount: effectiveWantAmount,
            minFillRatio,
          }
        }]
      }] });

      console.log('📊 Swap offer placed:', offerId);

      // Reset form
      orderPercent = 100;
      selectedOrderLevel = null;
      giveAmount = 0n;
      wantAmount = 0n;
    } catch (error) {
      console.error('Failed to place swap offer:', error);
      submitError = `Failed to place swap: ${(error as Error)?.message || 'Unknown error'}`;
    }
  }

  async function cancelSwapOffer(offerId: string, accountId: string) {
    if (!tab.entityId) return;

    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const signerId = resolveSignerId(tab.entityId);
      if (!signerId) throw new Error('No signer available for selected entity');

      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId: tab.entityId,
        signerId,
        entityTxs: [{
          type: 'proposeCancelSwap',
          data: {
            offerId,
            counterpartyEntityId: accountId, // accountId is the counterparty entity ID
          }
        }]
      }] });

      console.log('📨 Swap cancel requested:', offerId);
    } catch (error) {
      console.error('Failed to cancel swap:', error);
      alert(`Failed to cancel: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  // Format BigInt for display
  function formatAmount(amount: bigint, tokenIdValue: number): string {
    const decimals = BigInt(getTokenDecimals(tokenIdValue));
    const ONE = 10n ** decimals;
    const whole = amount / ONE;
    const frac = amount % ONE;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(Number(decimals), '0').replace(/0+$/, '')}`;
  }
</script>

<div class="swap-panel">
  <h3>Swap Trading</h3>

  <div class="section">
    <div class="orderbook-header">
      <h4>Orderbook</h4>
      <div class="scope-toggle">
        <button
          class="scope-btn"
          class:active={orderbookScope === 'all'}
          on:click={() => (orderbookScope = 'all')}
        >
          All Accounts
        </button>
        <button
          class="scope-btn"
          class:active={orderbookScope === 'selected'}
          disabled={!counterpartyId}
          on:click={() => (orderbookScope = 'selected')}
        >
          Selected Account
        </button>
      </div>
    </div>
    <p class="orderbook-hint">{orderbookHint}</p>
    {#if orderbookHubIds.length > 0}
      <div class="orderbook-wrap">
        <OrderbookPanel
          hubIds={orderbookHubIds}
          hubId={counterpartyId}
          pairId={orderbookPairId}
          depth={12}
          on:levelclick={handleOrderbookLevelClick}
        />
      </div>
    {:else}
      <div class="orderbook-empty">No connected account orderbooks yet.</div>
    {/if}
  </div>

  <!-- Place Swap Offer Form -->
  <div class="section">
    <h4>Place Limit Order</h4>

    {#if !prefilledCounterparty}
    <div class="form-row">
      <label>
        Counterparty (Hub)
        <EntitySelect bind:value={counterpartyId} options={accountIds} placeholder="Select account" />
      </label>
    </div>
    {/if}

    <div class="form-row">
      <label>
        Give Token
        <select bind:value={giveTokenId}>
          {#each availableTokens as token}
            <option value={token.id}>{token.name}</option>
          {/each}
        </select>
      </label>
      <label>
        Give Amount (wei)
        <BigIntInput bind:value={giveAmount} decimals={giveTokenDecimals} placeholder="Amount to sell" />
      </label>
    </div>

    <div class="form-row">
      <label>
        Want Token
        <select bind:value={wantTokenId}>
          {#each availableTokens as token}
            <option value={token.id}>{token.name}</option>
          {/each}
        </select>
      </label>
      <label>
        Want Amount (wei)
        <BigIntInput bind:value={wantAmount} decimals={wantTokenDecimals} placeholder="Amount to receive" />
      </label>
    </div>

    <div class="form-row">
      <label>
        Min Fill %
        <input type="number" bind:value={minFillPercent} min="1" max="100" placeholder="50" />
      </label>
    </div>

    <div class="size-tools">
      <div class="size-top">
        <span class="size-title">Order Sizing</span>
        <button class="max-btn" type="button" on:click={setMaxOrderPercent} disabled={availableGiveCapacity <= 0n}>Max</button>
      </div>
      <div class="size-stats">
        <span>Available: <strong>{formattedAvailableGive}</strong></span>
        <span>Estimate: <strong>{estimatedSpendLabel} → {estimatedReceiveLabel}</strong></span>
        <span>Price: <strong>{estimatedPrice}</strong></span>
      </div>
      <div class="slider-row">
        <input
          class="size-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          value={orderPercent}
          on:input={handleOrderPercentInput}
        />
        <span class="slider-value">{orderPercent}%</span>
      </div>
      {#if selectedOrderLevel}
        <p class="size-hint">
          Level selected: {selectedOrderLevel.side.toUpperCase()} @ {selectedOrderLevel.price.toString()} (max
          {selectedOrderLevel.sizeBase.toString()} base lots)
        </p>
      {:else}
        <p class="size-hint">Tip: click an orderbook level to prefill this form with max executable size.</p>
      {/if}
      {#if capacityWarning}
        <p class="size-warning">{capacityWarning}</p>
      {/if}
    </div>

    <button class="primary-btn" on:click={placeSwapOffer} disabled={Boolean(swapDisabledReason)}>
      Place Swap Offer
    </button>
    {#if swapDisabledReason || submitError}
      <p class="form-error">{submitError || swapDisabledReason}</p>
    {/if}
  </div>

  <!-- Active Swap Offers -->
  {#if activeOffers.length > 0}
    <div class="section">
      <h4>Active Orders ({activeOffers.length})</h4>
      <div class="offers-list">
        {#each activeOffers as offer}
          <div class="offer-card">
            <div class="offer-header">
              <span class="offer-id">{offer.offerId.slice(0, 16)}...</span>
              <button class="cancel-btn" on:click={() => cancelSwapOffer(offer.offerId, offer.accountId)}>
                Request Cancel
              </button>
            </div>
            <div class="offer-details">
              <div class="offer-row">
                <span class="label">Give:</span>
                <span class="value">{formatAmount(offer.giveAmount, offer.giveTokenId)} (Token #{offer.giveTokenId})</span>
              </div>
              <div class="offer-row">
                <span class="label">Want:</span>
                <span class="value">{formatAmount(offer.wantAmount, offer.wantTokenId)} (Token #{offer.wantTokenId})</span>
              </div>
              <div class="offer-row">
                  <span class="label">Price:</span>
                  <span class="value">
                  {formatPriceRatio(offer.wantAmount, offer.giveAmount)}
                  </span>
                </div>
              <div class="offer-row">
                <span class="label">Account:</span>
                <span class="value">{offer.accountId.slice(0, 12)}...</span>
              </div>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .swap-panel {
    padding: 0;
    border-radius: 10px;
  }

  h3 {
    margin: 0 0 16px 0;
    color: #f3f4f6;
    font-size: 16px;
    font-weight: 700;
  }

  h4 {
    margin: 0 0 12px 0;
    color: #e5e7eb;
    font-size: 14px;
    font-weight: 600;
  }

  .section {
    margin-bottom: 24px;
    padding: 14px;
    background: #131419;
    border-radius: 10px;
    border: 1px solid #2b2f39;
  }

  .orderbook-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .scope-toggle {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .scope-btn {
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid #353942;
    background: #111217;
    color: #9ca3af;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .scope-btn.active {
    color: #fbbf24;
    border-color: #fbbf24;
    background: rgba(251, 191, 36, 0.08);
  }

  .scope-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .orderbook-hint {
    margin: 6px 0 10px;
    color: #9ca3af;
    font-size: 12px;
    line-height: 1.45;
  }

  .orderbook-empty {
    border: 1px dashed #3f434d;
    border-radius: 8px;
    padding: 10px 12px;
    color: #9ca3af;
    font-size: 12px;
  }

  .form-row {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
  }

  .form-row label {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: #9ca3af;
  }

  select, input {
    padding: 8px;
    background: #0c0d11;
    border: 1px solid #303442;
    border-radius: 8px;
    color: #f3f4f6;
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
  }

  select:focus, input:focus {
    outline: none;
    border-color: rgba(251, 191, 36, 0.65);
  }

  .primary-btn {
    width: 100%;
    padding: 10px;
    background: linear-gradient(180deg, rgba(251, 191, 36, 0.18), rgba(217, 119, 6, 0.12));
    border: 1px solid rgba(251, 191, 36, 0.55);
    border-radius: 8px;
    color: #fde68a;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .primary-btn:hover {
    background: linear-gradient(180deg, rgba(251, 191, 36, 0.28), rgba(217, 119, 6, 0.2));
    border-color: rgba(251, 191, 36, 0.75);
  }

  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .size-tools {
    margin: 8px 0 14px;
    padding: 10px;
    border: 1px solid #2f343f;
    border-radius: 8px;
    background: #101116;
  }

  .size-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  .size-title {
    color: #d1d5db;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .max-btn {
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid #4b5563;
    background: #161922;
    color: #d1d5db;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .max-btn:hover:not(:disabled) {
    border-color: #fbbf24;
    color: #fbbf24;
  }

  .max-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .size-stats {
    margin-top: 8px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 6px 12px;
    font-size: 12px;
    color: #9ca3af;
  }

  .size-stats strong {
    color: #f3f4f6;
    font-weight: 600;
  }

  .slider-row {
    margin-top: 10px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
  }

  .size-slider {
    width: 100%;
    accent-color: #f59e0b;
  }

  .slider-value {
    min-width: 44px;
    text-align: right;
    color: #fbbf24;
    font-size: 12px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
  }

  .size-hint {
    margin: 8px 0 0;
    color: #9ca3af;
    font-size: 11px;
    line-height: 1.4;
  }

  .size-warning {
    margin: 6px 0 0;
    color: #fca5a5;
    font-size: 11px;
    line-height: 1.4;
  }

  .form-error {
    margin: 8px 0 0;
    color: #fda4af;
    font-size: 12px;
    line-height: 1.4;
  }

  .offers-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .orderbook-wrap :global(.orderbook-panel) {
    width: 100%;
    min-width: 0;
  }

  .offer-card {
    padding: 12px;
    background: #111218;
    border: 1px solid #313644;
    border-radius: 8px;
  }

  .offer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .offer-id {
    font-size: 11px;
    color: #9ca3af;
    font-family: 'SF Mono', monospace;
  }

  .cancel-btn {
    padding: 4px 8px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: 6px;
    color: #fca5a5;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .cancel-btn:hover {
    background: rgba(239, 68, 68, 0.18);
    border-color: rgba(239, 68, 68, 0.6);
  }

  .offer-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .offer-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    font-family: 'SF Mono', monospace;
  }

  .offer-row .label {
    color: #9ca3af;
  }

  .offer-row .value {
    color: #f3f4f6;
  }
</style>
