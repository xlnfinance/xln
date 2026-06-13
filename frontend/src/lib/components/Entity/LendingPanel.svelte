<script lang="ts">
  import { onMount } from 'svelte';
  import { Banknote, RefreshCw } from 'lucide-svelte';
  import type { EntityReplica } from '$lib/types/ui';
  import { xlnFunctions } from '../../stores/xlnStore';
  import { toasts } from '../../stores/toastStore';
  import BigIntInput from '../Common/BigIntInput.svelte';
  import EntitySelect from './EntitySelect.svelte';

  export let entityId: string;
  export let replica: EntityReplica | null = null;
  export let accountIds: string[] = [];
  export let isLive: boolean = false;

  type TermId = '1h' | '1d' | '1m';

  type LendingPoolPosition = {
    positionId: string;
    hubEntityId: string;
    lenderEntityId: string;
    tokenId: number;
    principalAmount: string;
    availableAmount: string;
    borrowedAmount: string;
    interestBps: number;
    termId: TermId;
    status: string;
    updatedAt: number;
  };

  type LendingLoan = {
    loanId: string;
    hubEntityId: string;
    borrowerEntityId: string;
    lenderEntityId: string;
    positionId: string;
    tokenId: number;
    principalAmount: string;
    interestAmount: string;
    repaymentAmount: string;
    repaidAmount: string;
    interestBps: number;
    termId: TermId;
    dueAt: number;
    status: string;
  };

  type LendingStateResponse = {
    success?: boolean;
    error?: string;
    hubEntityId?: string;
    pools?: LendingPoolPosition[];
    loans?: LendingLoan[];
    totals?: {
      availableAmount: string;
      borrowedAmount: string;
      activePrincipalAmount: string;
    };
  };

  const terms: Array<{ id: TermId; label: string }> = [
    { id: '1h', label: '1 hour' },
    { id: '1d', label: '1 day' },
    { id: '1m', label: '1 month' },
  ];

  let selectedHubEntityId = '';
  let selectedTokenId = 1;
  let lendAmount = 0n;
  let borrowAmount = 0n;
  let lendTermId: TermId = '1d';
  let borrowTermId: TermId = '1d';
  let lendInterestBps = 100;
  let maxBorrowInterestBps = 250;
  let loading = false;
  let submitting = false;
  let lastError = '';
  let lastSuccess = '';
  let state: LendingStateResponse | null = null;

  $: activeXlnFunctions = $xlnFunctions;
  $: normalizedEntityId = String(entityId || replica?.state?.entityId || '').trim().toLowerCase();
  $: normalizedAccounts = Array.from(
    new Set(accountIds.map((id) => String(id || '').trim()).filter(Boolean)),
  );
  $: if (!selectedHubEntityId && normalizedAccounts.length > 0) {
    selectedHubEntityId = normalizedAccounts[0] || '';
  }
  $: tokenOptions = buildTokenOptions();
  $: if (!tokenOptions.some((token) => token.id === selectedTokenId)) {
    selectedTokenId = tokenOptions[0]?.id ?? 1;
  }
  $: selectedTokenDecimals = tokenDecimals(selectedTokenId);
  $: selectedTokenSymbol = tokenSymbol(selectedTokenId);
  $: pools = state?.pools ?? [];
  $: loans = state?.loans ?? [];
  $: activeLoans = loans.filter((loan) => loan.status === 'active');
  $: totalAvailable = parseAmount(state?.totals?.availableAmount);
  $: totalBorrowed = parseAmount(state?.totals?.borrowedAmount);
  $: canSubmit = isLive && !!selectedHubEntityId && !!normalizedEntityId && !submitting;

  function buildTokenOptions(): Array<{ id: number; symbol: string }> {
    const ids = new Set<number>();
    const account = selectedHubEntityId
      ? replica?.state?.accounts?.get?.(selectedHubEntityId)
      : null;
    for (const key of account?.deltas?.keys?.() ?? []) {
      const id = Number(key);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
    if (ids.size === 0) {
      ids.add(1);
      ids.add(2);
      ids.add(3);
    }
    return Array.from(ids.values())
      .sort((left, right) => tokenSymbol(left).localeCompare(tokenSymbol(right)) || left - right)
      .map((id) => ({ id, symbol: tokenSymbol(id) }));
  }

  function tokenSymbol(tokenId: number): string {
    const info = activeXlnFunctions?.getTokenInfo?.(tokenId);
    return String(info?.symbol || `TKN${tokenId}`);
  }

  function tokenDecimals(tokenId: number): number {
    const info = activeXlnFunctions?.getTokenInfo?.(tokenId);
    const decimals = Number(info?.decimals);
    return Number.isFinite(decimals) && decimals >= 0 ? decimals : 18;
  }

  function parseAmount(value: string | bigint | null | undefined): bigint {
    try {
      if (typeof value === 'bigint') return value;
      const raw = String(value ?? '').trim();
      return raw ? BigInt(raw) : 0n;
    } catch {
      return 0n;
    }
  }

  function formatAmount(value: string | bigint | null | undefined, tokenId = selectedTokenId): string {
    const amount = parseAmount(value);
    const decimals = tokenDecimals(tokenId);
    const divisor = 10n ** BigInt(decimals);
    const whole = amount / divisor;
    const frac = amount % divisor;
    if (frac === 0n) return whole.toString();
    const fracText = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
    return fracText ? `${whole}.${fracText}` : whole.toString();
  }

  function rateLabel(bps: number): string {
    return `${(Math.max(0, Number(bps) || 0) / 100).toFixed(2)}%`;
  }

  function dueLabel(ms: number): string {
    if (!ms) return '';
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
  }

  async function readJson(response: Response): Promise<Record<string, unknown>> {
    const raw = await response.text();
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { success: false, error: raw };
    }
  }

  async function refreshLendingState(): Promise<void> {
    if (!selectedHubEntityId || !normalizedEntityId) {
      state = null;
      return;
    }
    loading = true;
    lastError = '';
    try {
      const url = new URL('/api/lending/state', window.location.origin);
      url.searchParams.set('hubEntityId', selectedHubEntityId);
      url.searchParams.set('userEntityId', normalizedEntityId);
      url.searchParams.set('tokenId', String(selectedTokenId));
      const response = await fetch(url, { cache: 'no-store' });
      const result = await readJson(response) as LendingStateResponse;
      if (!response.ok || result.success !== true) {
        throw new Error(result.error || `Lending state failed (${response.status})`);
      }
      state = result;
    } catch (error) {
      state = null;
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  async function postLending(path: string, body: Record<string, unknown>): Promise<void> {
    if (!canSubmit) {
      throw new Error(isLive ? 'Select hub account first' : 'Lending requires live runtime');
    }
    submitting = true;
    lastError = '';
    lastSuccess = '';
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await readJson(response) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) {
        throw new Error(String(result.error || `Lending request failed (${response.status})`));
      }
      lastSuccess = 'Submitted';
      toasts.success('Lending request submitted');
      await refreshLendingState();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      toasts.error(`Lending failed: ${lastError}`);
    } finally {
      submitting = false;
    }
  }

  async function submitLend(): Promise<void> {
    if (lendAmount <= 0n) return;
    await postLending('/api/lending/offer', {
      hubEntityId: selectedHubEntityId,
      lenderEntityId: normalizedEntityId,
      tokenId: selectedTokenId,
      amount: lendAmount.toString(),
      termId: lendTermId,
      interestBps: Math.max(0, Math.floor(Number(lendInterestBps) || 0)),
    });
    if (!lastError) lendAmount = 0n;
  }

  async function submitBorrow(): Promise<void> {
    if (borrowAmount <= 0n) return;
    await postLending('/api/lending/borrow', {
      hubEntityId: selectedHubEntityId,
      borrowerEntityId: normalizedEntityId,
      tokenId: selectedTokenId,
      amount: borrowAmount.toString(),
      termId: borrowTermId,
      maxInterestBps: Math.max(0, Math.floor(Number(maxBorrowInterestBps) || 0)),
    });
    if (!lastError) borrowAmount = 0n;
  }

  async function repayLoan(loanId: string): Promise<void> {
    await postLending('/api/lending/repay', {
      hubEntityId: selectedHubEntityId,
      borrowerEntityId: normalizedEntityId,
      loanId,
    });
  }

  $: if (selectedHubEntityId && normalizedEntityId && selectedTokenId) {
    void refreshLendingState();
  }

  onMount(() => {
    void refreshLendingState();
  });
</script>

<section class="lending-panel" data-testid="lending-panel">
  <div class="lending-head">
    <div>
      <div class="eyebrow">Lending</div>
      <h3>Hub Credit Market</h3>
    </div>
    <button class="icon-button" type="button" on:click={refreshLendingState} disabled={loading} aria-label="Refresh lending state" data-testid="lending-refresh">
      <RefreshCw size={16} />
    </button>
  </div>

  <div class="control-strip">
    <label class="field hub-field">
      <span>Hub account</span>
      <EntitySelect bind:value={selectedHubEntityId} options={normalizedAccounts} placeholder="Select hub account" />
    </label>
    <label class="field token-field">
      <span>Asset</span>
      <select bind:value={selectedTokenId} data-testid="lending-token-select">
        {#each tokenOptions as token}
          <option value={token.id}>{token.symbol}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="metric-row">
    <div class="metric" data-testid="lending-available">
      <span>Available</span>
      <strong>{formatAmount(totalAvailable)} {selectedTokenSymbol}</strong>
    </div>
    <div class="metric" data-testid="lending-borrowed">
      <span>Borrowed</span>
      <strong>{formatAmount(totalBorrowed)} {selectedTokenSymbol}</strong>
    </div>
  </div>

  {#if !isLive}
    <div class="status warning" data-testid="lending-live-required">Lending requires live runtime.</div>
  {/if}
  {#if lastError}
    <div class="status error" data-testid="lending-error">{lastError}</div>
  {:else if lastSuccess}
    <div class="status success" data-testid="lending-success">{lastSuccess}</div>
  {/if}

  <div class="action-grid">
    <form class="action-block" on:submit|preventDefault={submitLend} data-testid="lending-offer-form">
      <div class="action-title">
        <Banknote size={16} />
        <span>Lend to hub</span>
      </div>
      <BigIntInput bind:value={lendAmount} decimals={selectedTokenDecimals} placeholder="Amount" disabled={submitting} />
      <div class="inline-fields">
        <label>
          <span>Term</span>
          <select bind:value={lendTermId} disabled={submitting} data-testid="lending-offer-term">
            {#each terms as term}
              <option value={term.id}>{term.label}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>Rate, bps</span>
          <input type="number" min="0" max="10000" bind:value={lendInterestBps} disabled={submitting} data-testid="lending-offer-rate" />
        </label>
      </div>
      <button class="primary" type="submit" disabled={!canSubmit || lendAmount <= 0n || submitting} data-testid="lending-offer-submit">
        Fund pool
      </button>
    </form>

    <form class="action-block" on:submit|preventDefault={submitBorrow} data-testid="lending-borrow-form">
      <div class="action-title">
        <Banknote size={16} />
        <span>Borrow from hub</span>
      </div>
      <BigIntInput bind:value={borrowAmount} decimals={selectedTokenDecimals} placeholder="Amount" disabled={submitting} />
      <div class="inline-fields">
        <label>
          <span>Term</span>
          <select bind:value={borrowTermId} disabled={submitting} data-testid="lending-borrow-term">
            {#each terms as term}
              <option value={term.id}>{term.label}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>Max bps</span>
          <input type="number" min="0" max="10000" bind:value={maxBorrowInterestBps} disabled={submitting} data-testid="lending-borrow-max-rate" />
        </label>
      </div>
      <button class="primary" type="submit" disabled={!canSubmit || borrowAmount <= 0n || submitting} data-testid="lending-borrow-submit">
        Borrow
      </button>
    </form>
  </div>

  <div class="list-grid">
    <section class="list-block" data-testid="lending-pools">
      <div class="list-title">Your pools</div>
      {#if pools.length === 0}
        <div class="empty">No open pools for {selectedTokenSymbol}.</div>
      {:else}
        {#each pools as pool (pool.positionId)}
          <div class="lending-row" data-testid="lending-pool-row">
            <div>
              <strong>{formatAmount(pool.availableAmount, pool.tokenId)} {tokenSymbol(pool.tokenId)}</strong>
              <span>{pool.termId} · {rateLabel(pool.interestBps)} · {pool.status}</span>
            </div>
            <div class="row-secondary">
              borrowed {formatAmount(pool.borrowedAmount, pool.tokenId)}
            </div>
          </div>
        {/each}
      {/if}
    </section>

    <section class="list-block" data-testid="lending-loans">
      <div class="list-title">Your loans</div>
      {#if activeLoans.length === 0}
        <div class="empty">No active loans for {selectedTokenSymbol}.</div>
      {:else}
        {#each activeLoans as loan (loan.loanId)}
          <div class="lending-row loan-row" data-testid="lending-loan-row">
            <div>
              <strong>{formatAmount(loan.repaymentAmount, loan.tokenId)} {tokenSymbol(loan.tokenId)}</strong>
              <span>{loan.termId} · {rateLabel(loan.interestBps)} · due {dueLabel(loan.dueAt)}</span>
            </div>
            <button class="secondary" type="button" disabled={submitting} on:click={() => repayLoan(loan.loanId)} data-testid="lending-repay-submit">
              Repay
            </button>
          </div>
        {/each}
      {/if}
    </section>
  </div>
</section>

<style>
  .lending-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 980px;
  }

  .lending-head,
  .control-strip,
  .metric-row,
  .action-grid,
  .list-grid {
    display: grid;
    gap: 12px;
  }

  .lending-head {
    grid-template-columns: 1fr auto;
    align-items: center;
  }

  .eyebrow,
  .field > span,
  .inline-fields span,
  .metric span,
  .list-title {
    color: #9ca3af;
    font-size: 0.76rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  h3 {
    margin: 2px 0 0;
    color: #f4f4f5;
    font-size: 1.1rem;
  }

  .icon-button {
    width: 38px;
    height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #2f3442;
    border-radius: 8px;
    background: #111318;
    color: #d4d4d8;
  }

  .control-strip {
    grid-template-columns: minmax(260px, 1fr) minmax(140px, 180px);
    align-items: end;
  }

  .field,
  .inline-fields label {
    display: grid;
    gap: 6px;
  }

  select,
  input[type='number'] {
    min-height: 38px;
    border: 1px solid #303542;
    border-radius: 8px;
    background: #0b0d12;
    color: #f4f4f5;
    padding: 0 12px;
    font: inherit;
  }

  .metric-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .metric,
  .action-block,
  .list-block {
    border: 1px solid #242b3a;
    border-radius: 8px;
    background: #101319;
  }

  .metric {
    padding: 12px;
  }

  .metric strong {
    display: block;
    margin-top: 4px;
    color: #e5e7eb;
    font-variant-numeric: tabular-nums;
  }

  .status {
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 0.9rem;
  }

  .status.warning {
    border: 1px solid rgba(251, 191, 36, 0.36);
    color: #facc15;
    background: rgba(251, 191, 36, 0.08);
  }

  .status.error {
    border: 1px solid rgba(248, 113, 113, 0.4);
    color: #fecaca;
    background: rgba(127, 29, 29, 0.24);
  }

  .status.success {
    border: 1px solid rgba(52, 211, 153, 0.32);
    color: #a7f3d0;
    background: rgba(6, 95, 70, 0.18);
  }

  .action-grid,
  .list-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .action-block {
    display: grid;
    gap: 10px;
    padding: 12px;
  }

  .action-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: #f4f4f5;
    font-weight: 700;
  }

  .inline-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  button.primary,
  button.secondary {
    min-height: 40px;
    border-radius: 8px;
    border: 1px solid transparent;
    color: #111827;
    font-weight: 800;
  }

  button.primary {
    background: #d4a514;
  }

  button.secondary {
    padding: 0 12px;
    background: #1f2937;
    border-color: #374151;
    color: #e5e7eb;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .list-block {
    padding: 12px;
  }

  .list-title {
    margin-bottom: 8px;
  }

  .empty {
    color: #71717a;
    padding: 12px 0;
  }

  .lending-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 10px 0;
    border-top: 1px solid #232936;
  }

  .lending-row:first-of-type {
    border-top: 0;
  }

  .lending-row strong {
    display: block;
    color: #f4f4f5;
    font-variant-numeric: tabular-nums;
  }

  .lending-row span,
  .row-secondary {
    display: block;
    margin-top: 3px;
    color: #9ca3af;
    font-size: 0.84rem;
  }

  :global(.lending-panel .bigint-input) {
    width: 100%;
    min-height: 40px;
    box-sizing: border-box;
    border-radius: 8px;
    border-color: #303542;
    background: #0b0d12;
    color: #f4f4f5;
  }

  @media (max-width: 760px) {
    .control-strip,
    .metric-row,
    .action-grid,
    .list-grid,
    .inline-fields {
      grid-template-columns: 1fr;
    }
  }
</style>
