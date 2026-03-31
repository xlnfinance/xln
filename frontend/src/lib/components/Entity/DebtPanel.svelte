<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import EntityIdentity from '../shared/EntityIdentity.svelte';
  import { xlnFunctions } from '$lib/stores/xlnStore';
  import { amountToUsd } from '$lib/utils/assetPricing';
  import { getEntityDisplayName } from '$lib/utils/entityNaming';
  import type { DebtEntry, EntityState, Env, EnvSnapshot } from '@xln/runtime/xln-api';

  export let entityId: string;
  export let signerId: string;
  export let sourceEnv: Env | EnvSnapshot;
  export let canEnforce: boolean = false;
  export let enforcingTokenId: number | null = null;

  const dispatch = createEventDispatcher<{
    enforce: { tokenId: number; symbol: string };
  }>();

  type TokenGroup = {
    key: string;
    tokenId: number;
    symbol: string;
    direction: DebtDirection;
    decimals: number;
    debts: DebtEntry[];
    openCount: number;
    outgoingOpenCount: number;
    outstandingAmount: bigint;
    usdOutstanding: number;
    usdTotal: number;
  };
  type DebtStatus = DebtEntry['status'];
  type DebtDirection = DebtEntry['direction'];
  type DebtRowTone = DebtStatus | 'neutral';

  type DebtTotals = {
    entries: number;
    openCount: number;
    usdOutstanding: number;
  };

  $: activeXlnFunctions = $xlnFunctions;
  $: entityState = resolveEntityState(sourceEnv, entityId, signerId);

  function resolveEntityState(
    env: Env | EnvSnapshot,
    currentEntityId: string,
    currentSignerId: string,
  ): EntityState | null {
    if (!(env?.eReplicas instanceof Map)) return null;
    const exact = env.eReplicas.get(`${currentEntityId}:${currentSignerId}`);
    if (exact?.state) return exact.state as EntityState;

    const entityNorm = String(currentEntityId || '').trim().toLowerCase();
    const signerNorm = String(currentSignerId || '').trim().toLowerCase();
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const [keyEntityId, keySignerId] = String(replicaKey || '').split(':');
      const resolvedEntityId = String(keyEntityId || replica?.entityId || '').trim().toLowerCase();
      const resolvedSignerId = String(keySignerId || replica?.signerId || '').trim().toLowerCase();
      if (resolvedEntityId === entityNorm && resolvedSignerId === signerNorm) {
        return (replica?.state || null) as EntityState | null;
      }
    }
    return null;
  }

  function flattenLedger(ledger: Map<number, Map<string, DebtEntry>> | undefined): DebtEntry[] {
    if (!ledger) return [];
    return Array.from(ledger.values())
      .flatMap((bucket) => Array.from(bucket.values()))
      .sort((left, right) =>
        Number(right.lastUpdatedBlock || 0) - Number(left.lastUpdatedBlock || 0) ||
        String(left.debtId).localeCompare(String(right.debtId)),
      );
  }

  function tokenMeta(tokenId: number): { symbol: string; decimals: number } {
    const tokenInfo = activeXlnFunctions?.getTokenInfo?.(tokenId);
    return {
      symbol: tokenInfo?.symbol || `Token #${tokenId}`,
      decimals: Number.isFinite(tokenInfo?.decimals) ? Number(tokenInfo.decimals) : 18,
    };
  }

  function formatAmount(tokenId: number, amount: bigint): string {
    if (activeXlnFunctions?.formatTokenAmount) {
      return activeXlnFunctions.formatTokenAmount(tokenId, amount);
    }
    return `${amount.toString()} ${tokenMeta(tokenId).symbol}`;
  }

  function formatUsd(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
  }

  function debtUsd(entry: DebtEntry, field: 'createdAmount' | 'paidAmount' | 'remainingAmount' | 'forgivenAmount'): number {
    const meta = tokenMeta(entry.tokenId);
    return amountToUsd(entry[field], meta.decimals, meta.symbol);
  }

  function entityName(entityId: string): string {
    return getEntityDisplayName(entityId, {
      source: sourceEnv,
      selfEntityId: entityState?.entityId || '',
      selfLabel: 'You',
      fallback: 'Unknown',
    });
  }

  function debtStatusClass(status: DebtEntry['status']): string {
    if (status === 'paid') return 'paid';
    if (status === 'forgiven') return 'forgiven';
    return 'open';
  }

  function debtStatusLabel(status: DebtEntry['status']): string {
    if (status === 'paid') return 'Paid';
    if (status === 'forgiven') return 'Forgiven';
    return 'Open';
  }

  function debtDirectionLabel(direction: DebtDirection): string {
    return direction === 'out' ? 'Outgoing' : 'Incoming';
  }

  function compareDebtRows(left: DebtEntry, right: DebtEntry): number {
    const leftOpen = left.status === 'open' ? 1 : 0;
    const rightOpen = right.status === 'open' ? 1 : 0;
    if (leftOpen !== rightOpen) return rightOpen - leftOpen;
    if (left.direction !== right.direction) return left.direction === 'out' ? -1 : 1;
    const blockDiff = Number(right.lastUpdatedBlock || 0) - Number(left.lastUpdatedBlock || 0);
    if (blockDiff !== 0) return blockDiff;
    return String(left.debtId).localeCompare(String(right.debtId));
  }

  function buildTokenGroups(): TokenGroup[] {
    const allDebts = [
      ...flattenLedger(entityState?.outDebtsByToken),
      ...flattenLedger(entityState?.inDebtsByToken),
    ];
    const byToken = new Map<string, DebtEntry[]>();
    for (const entry of allDebts) {
      const key = `${entry.tokenId}:${entry.direction}`;
      const list = byToken.get(key) || [];
      list.push(entry);
      byToken.set(key, list);
    }
    return Array.from(byToken.entries())
      .map(([groupKey, tokenDebts]) => {
        const firstDebt = tokenDebts[0];
        if (!firstDebt) {
          return null;
        }
        const tokenId = firstDebt.tokenId;
        const meta = tokenMeta(tokenId);
        const orderedDebts = [...tokenDebts].sort(compareDebtRows);
        const openDebts = orderedDebts.filter((entry) => entry.status === 'open');
        const outstandingAmount = openDebts.reduce((sum, entry) => sum + entry.remainingAmount, 0n);
        return {
          key: groupKey,
          tokenId,
          symbol: meta.symbol,
          decimals: meta.decimals,
          direction: firstDebt.direction,
          debts: orderedDebts,
          openCount: openDebts.length,
          outgoingOpenCount: firstDebt.direction === 'out' ? openDebts.length : 0,
          outstandingAmount,
          usdOutstanding: openDebts.reduce((sum, entry) => sum + debtUsd(entry, 'remainingAmount'), 0),
          usdTotal: orderedDebts.reduce((sum, entry) => sum + debtUsd(entry, 'remainingAmount'), 0),
        };
      })
      .filter((group): group is TokenGroup => group !== null)
      .sort((left, right) => right.usdOutstanding - left.usdOutstanding || right.usdTotal - left.usdTotal || left.symbol.localeCompare(right.symbol));
  }

  function buildTotals(tokenGroups: TokenGroup[]): DebtTotals {
    return tokenGroups.reduce<DebtTotals>((totals, group) => ({
      entries: totals.entries + group.debts.length,
      openCount: totals.openCount + group.openCount,
      usdOutstanding: totals.usdOutstanding + group.usdOutstanding,
    }), {
      entries: 0,
      openCount: 0,
      usdOutstanding: 0,
    });
  }

  function debtTone(status: DebtStatus): DebtRowTone {
    return status === 'open' ? 'open' : status;
  }

  $: tokenGroups = buildTokenGroups();
  $: debtTotals = buildTotals(tokenGroups);
</script>

{#if debtTotals.entries > 0}
  <details class="debt-panel" data-testid="debt-panel" open>
    <summary class="debt-summary">
      <div class="debt-summary-copy">
        <span class="debt-summary-title">Debts {formatUsd(debtTotals.usdOutstanding)}</span>
        <span class="debt-summary-meta">{debtTotals.openCount} open · {debtTotals.entries} entries</span>
      </div>
      <div class="debt-summary-total">
        <span>Total debts</span>
        <strong>{formatUsd(debtTotals.usdOutstanding)}</strong>
      </div>
    </summary>

    <div class="debt-body">
      <div class="debt-token-groups">
        {#each tokenGroups as tokenGroup (tokenGroup.key)}
          <details class="debt-token-group" open={tokenGroup.openCount > 0}>
            <summary class="debt-token-summary">
              <div class="debt-token-copy">
                <span class="debt-token-title">
                  {formatAmount(tokenGroup.tokenId, tokenGroup.outstandingAmount)} {tokenGroup.direction === 'out' ? 'we owe' : 'owed to us'}
                </span>
                <span class="debt-token-meta">{tokenGroup.openCount} open · {tokenGroup.debts.length} debts</span>
              </div>
              <strong>{formatUsd(tokenGroup.usdOutstanding || tokenGroup.usdTotal)}</strong>
            </summary>

            {#if tokenGroup.outgoingOpenCount > 0}
              <div class="debt-token-actions">
                <button
                  class="debt-enforce-btn"
                  type="button"
                  data-testid={`debt-enforce-${tokenGroup.tokenId}`}
                  disabled={!canEnforce || enforcingTokenId === tokenGroup.tokenId}
                  on:click={() => dispatch('enforce', { tokenId: tokenGroup.tokenId, symbol: tokenGroup.symbol })}
                >
                  {enforcingTokenId === tokenGroup.tokenId ? 'Enforcing...' : `Enforce ${tokenGroup.symbol}`}
                </button>
              </div>
            {/if}

            <div class="debt-rows">
              {#each tokenGroup.debts as debt (debt.debtId)}
                <article class="debt-row" data-testid={`debt-row-${debt.direction}-${debt.tokenId}`}>
                  <div class="debt-row-summary">
                    <div class="debt-row-identity">
                      <EntityIdentity
                        entityId={debt.counterparty}
                        name={entityName(debt.counterparty)}
                        size={24}
                        clickable={false}
                        copyable={false}
                        showAddress={false}
                      />
                      <span class={`debt-badge debt-direction-${debt.direction}`}>{debtDirectionLabel(debt.direction)}</span>
                      <span class={`debt-badge debt-status ${debtStatusClass(debt.status)}`}>{debtStatusLabel(debt.status)}</span>
                    </div>
                    <div class="debt-row-amounts">
                      <span>Opened {formatAmount(debt.tokenId, debt.createdAmount)}</span>
                      <span>Paid {formatAmount(debt.tokenId, debt.paidAmount)}</span>
                      <strong>Left {formatAmount(debt.tokenId, debt.remainingAmount)}</strong>
                    </div>
                  </div>

                  <div class="debt-row-details">
                    <div class="debt-detail-grid">
                      <div><span>Opened</span><strong>{formatAmount(debt.tokenId, debt.createdAmount)} · {formatUsd(debtUsd(debt, 'createdAmount'))}</strong></div>
                      <div><span>Paid</span><strong>{formatAmount(debt.tokenId, debt.paidAmount)} · {formatUsd(debtUsd(debt, 'paidAmount'))}</strong></div>
                      <div><span>Forgiven</span><strong>{formatAmount(debt.tokenId, debt.forgivenAmount)} · {formatUsd(debtUsd(debt, 'forgivenAmount'))}</strong></div>
                      <div><span>Left</span><strong>{formatAmount(debt.tokenId, debt.remainingAmount)} · {formatUsd(debtUsd(debt, 'remainingAmount'))}</strong></div>
                      <div><span>Debt ID</span><code>{debt.debtId}</code></div>
                      <div><span>Indexes</span><strong>{debt.createdDebtIndex} → {debt.currentDebtIndex ?? 'closed'}</strong></div>
                      <div><span>Direction</span><strong>{debtDirectionLabel(debt.direction)}</strong></div>
                      <div><span>Updated</span><strong>J#{debt.lastUpdatedBlock} · {debt.lastUpdatedTxHash || '—'}</strong></div>
                    </div>

                    <div class="debt-updates">
                      <div class="debt-updates-title">Timeline</div>
                      {#each debt.updates as update, index (`${debt.debtId}-${index}`)}
                        <div class="debt-update-row">
                          <span>{update.eventType}</span>
                          <span>J#{update.blockNumber}</span>
                          <span>Δ {formatAmount(debt.tokenId, update.amountDelta)}</span>
                          <strong>Left {formatAmount(debt.tokenId, update.remainingAmount)}</strong>
                        </div>
                      {/each}
                    </div>
                  </div>
                </article>
              {/each}
            </div>
          </details>
        {/each}
      </div>
    </div>
  </details>
{/if}

<style>
  .debt-panel {
    margin: 14px 0;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 86%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #111111)) 94%, transparent);
    box-shadow: 0 18px 36px color-mix(in srgb, var(--theme-background, #09090b) 14%, transparent);
  }

  .debt-token-group,
  .debt-row {
    border: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 84%, transparent);
    border-radius: 14px;
    background: color-mix(in srgb, var(--theme-background, #0a0a0a) 72%, transparent);
  }

  .debt-summary,
  .debt-token-summary {
    list-style: none;
    cursor: pointer;
  }

  .debt-summary::-webkit-details-marker,
  .debt-token-summary::-webkit-details-marker {
    display: none;
  }

  .debt-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px;
  }

  .debt-summary-copy,
  .debt-summary-total {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .debt-summary-title,
  .debt-token-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--theme-text-primary, #f5f5f5);
  }

  .debt-summary-meta,
  .debt-token-meta {
    color: var(--theme-text-muted, #a1a1aa);
    font-size: 12px;
  }

  .debt-summary-total span {
    color: var(--theme-text-muted, #a1a1aa);
    font-size: 12px;
  }

  .debt-summary-total strong,
  .debt-token-summary strong {
    color: var(--theme-text-primary, #ffffff);
    font-size: 14px;
  }

  .debt-body,
  .debt-token-groups,
  .debt-rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .debt-body {
    padding: 0 14px 14px;
  }

  .debt-token-summary {
    padding: 12px 14px;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
  }

  .debt-token-groups,
  .debt-rows {
    padding: 0 12px 12px;
  }

  .debt-token-copy {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .debt-token-actions {
    padding: 0 12px 12px;
    display: flex;
    justify-content: flex-end;
  }

  .debt-enforce-btn {
    border: 1px solid color-mix(in srgb, var(--theme-text-secondary, #d4d4d8) 22%, transparent);
    background: color-mix(in srgb, var(--theme-background, #09090b) 82%, var(--theme-text-primary, #ffffff) 6%);
    color: var(--theme-text-primary, #f4f4f5);
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .debt-enforce-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .debt-row-summary {
    padding: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }

  .debt-row-identity {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    min-width: 0;
  }

  .debt-badge {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
    border: 1px solid color-mix(in srgb, var(--theme-text-muted, #a1a1aa) 22%, transparent);
    background: color-mix(in srgb, var(--theme-background, #09090b) 82%, var(--theme-text-primary, #ffffff) 6%);
    color: var(--theme-text-secondary, #d4d4d8);
  }

  .debt-direction-out {
    color: var(--theme-text-primary, #ffffff);
  }

  .debt-direction-in {
    color: var(--theme-text-muted, #d4d4d8);
  }

  .debt-status.open {
    color: var(--theme-text-primary, #ffffff);
    border-color: color-mix(in srgb, var(--theme-text-primary, #ffffff) 28%, transparent);
  }

  .debt-status.paid,
  .debt-status.forgiven {
    color: var(--theme-text-muted, #a1a1aa);
  }

  .debt-row-amounts {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 14px;
    color: var(--theme-text-secondary, #d4d4d8);
    font-size: 12px;
  }

  .debt-row-amounts strong {
    color: var(--theme-text-primary, #ffffff);
  }

  .debt-row-details {
    padding: 0 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .debt-detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
  }

  .debt-detail-grid div {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--theme-background, #09090b) 78%, var(--theme-text-primary, #ffffff) 4%);
    padding: 10px;
  }

  .debt-detail-grid span {
    color: var(--theme-text-muted, #a1a1aa);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .debt-detail-grid strong,
  .debt-detail-grid code {
    color: var(--theme-text-primary, #f5f5f5);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .debt-updates {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .debt-updates-title {
    color: var(--theme-text-primary, #f5f5f5);
    font-size: 12px;
    font-weight: 700;
  }

  .debt-update-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    gap: 12px;
    align-items: center;
    font-size: 12px;
    color: var(--theme-text-secondary, #d4d4d8);
    border-radius: 10px;
    background: color-mix(in srgb, var(--theme-background, #09090b) 78%, var(--theme-text-primary, #ffffff) 4%);
    padding: 10px 12px;
  }

  .debt-update-row strong {
    color: var(--theme-text-primary, #ffffff);
  }

  @media (max-width: 860px) {
    .debt-row-summary,
    .debt-summary {
      flex-direction: column;
      align-items: flex-start;
    }

    .debt-row-amounts,
    .debt-summary-total {
      justify-content: flex-start;
    }

    .debt-update-row {
      grid-template-columns: 1fr;
    }
  }
</style>
