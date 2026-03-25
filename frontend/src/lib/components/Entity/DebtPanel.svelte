<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import EntityIdentity from '../shared/EntityIdentity.svelte';
  import { xlnFunctions } from '$lib/stores/xlnStore';
  import { amountToUsd } from '$lib/utils/assetPricing';
  import { getEntityDisplayName } from '$lib/utils/entityNaming';
  import type { DebtEntry, EntityState, Env } from '@xln/runtime/xln-api';

  export let entityState: EntityState | null = null;
  export let sourceEnv: Env | null = null;
  export let canEnforce: boolean = false;
  export let enforcingTokenId: number | null = null;

  const dispatch = createEventDispatcher<{
    enforce: { tokenId: number; symbol: string };
  }>();

  type DebtDirection = 'out' | 'in';
  type DebtSectionKey = 'outstanding' | 'settled';
  type TokenGroup = {
    tokenId: number;
    symbol: string;
    decimals: number;
    debts: DebtEntry[];
    usdTotal: number;
  };
  type SectionGroup = {
    key: DebtSectionKey;
    label: string;
    debts: DebtEntry[];
    usdTotal: number;
    tokenGroups: TokenGroup[];
  };
  type DirectionGroup = {
    key: DebtDirection;
    label: string;
    debts: DebtEntry[];
    openCount: number;
    usdOutstanding: number;
    sections: SectionGroup[];
  };

  $: activeXlnFunctions = $xlnFunctions;

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

  function buildSection(debts: DebtEntry[], key: DebtSectionKey): SectionGroup {
    const filtered = debts.filter((entry) => key === 'outstanding' ? entry.status === 'open' : entry.status !== 'open');
    const byToken = new Map<number, DebtEntry[]>();
    for (const entry of filtered) {
      const list = byToken.get(entry.tokenId) || [];
      list.push(entry);
      byToken.set(entry.tokenId, list);
    }
    const tokenGroups = Array.from(byToken.entries()).map(([tokenId, tokenDebts]) => {
      const meta = tokenMeta(tokenId);
      return {
        tokenId,
        symbol: meta.symbol,
        decimals: meta.decimals,
        debts: tokenDebts.sort((left, right) =>
          Number(right.lastUpdatedBlock || 0) - Number(left.lastUpdatedBlock || 0) ||
          left.debtId.localeCompare(right.debtId),
        ),
        usdTotal: tokenDebts.reduce((sum, entry) => sum + debtUsd(entry, 'remainingAmount'), 0),
      };
    }).sort((left, right) => right.usdTotal - left.usdTotal || left.symbol.localeCompare(right.symbol));

    return {
      key,
      label: key === 'outstanding' ? 'Outstanding' : 'Settled',
      debts: filtered,
      usdTotal: filtered.reduce((sum, entry) => sum + debtUsd(entry, 'remainingAmount'), 0),
      tokenGroups,
    };
  }

  function buildDirectionGroup(key: DebtDirection): DirectionGroup {
    const debts = flattenLedger(key === 'out' ? entityState?.outDebtsByToken : entityState?.inDebtsByToken);
    return {
      key,
      label: key === 'out' ? 'Outgoing (We Owe)' : 'Incoming (Owed To Us)',
      debts,
      openCount: debts.filter((entry) => entry.status === 'open').length,
      usdOutstanding: debts.filter((entry) => entry.status === 'open').reduce((sum, entry) => sum + debtUsd(entry, 'remainingAmount'), 0),
      sections: [buildSection(debts, 'outstanding'), buildSection(debts, 'settled')],
    };
  }

  $: directionGroups = [buildDirectionGroup('out'), buildDirectionGroup('in')];
  $: totalDebtEntries = directionGroups.reduce((sum, group) => sum + group.debts.length, 0);
  $: totalOutstandingUsd = directionGroups.reduce((sum, group) => sum + group.usdOutstanding, 0);
  $: totalOpenDebtCount = directionGroups.reduce((sum, group) => sum + group.openCount, 0);
</script>

{#if totalDebtEntries > 0}
  <details class="debt-panel" data-testid="debt-panel">
    <summary class="debt-summary">
      <div class="debt-summary-copy">
        <span class="debt-summary-title">Debts {formatUsd(totalOutstandingUsd)}</span>
        <span class="debt-summary-meta">{totalOpenDebtCount} open · {totalDebtEntries} entries</span>
      </div>
      <div class="debt-summary-total">
        <span>Total debts</span>
        <strong>{formatUsd(totalOutstandingUsd)}</strong>
      </div>
    </summary>

    <div class="debt-body">
      {#each directionGroups as direction (direction.key)}
        {#if direction.debts.length > 0}
          <details class="debt-direction" open={direction.key === 'out'}>
            <summary class="debt-direction-summary">
              <div>
                <span class="debt-direction-title">{direction.label}</span>
                <span class="debt-direction-meta">{direction.openCount} open</span>
              </div>
              <strong>{formatUsd(direction.usdOutstanding)}</strong>
            </summary>

            <div class="debt-sections">
              {#each direction.sections as section (section.key)}
                {#if section.debts.length > 0}
                  <details class="debt-section" open={section.key === 'outstanding'}>
                    <summary class="debt-section-summary">
                      <span>{section.label}</span>
                      <span>{section.debts.length} debts · {formatUsd(section.usdTotal)}</span>
                    </summary>

                    <div class="debt-token-groups">
                      {#each section.tokenGroups as tokenGroup (`${direction.key}-${section.key}-${tokenGroup.tokenId}`)}
                        <details class="debt-token-group">
                          <summary class="debt-token-summary">
                            <span>{tokenGroup.symbol}</span>
                            <span>{tokenGroup.debts.length} debts · {formatUsd(tokenGroup.usdTotal)}</span>
                          </summary>

                          {#if direction.key === 'out' && section.key === 'outstanding'}
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
                              <details class="debt-row" data-testid={`debt-row-${debt.direction}-${debt.tokenId}`}>
                                <summary class="debt-row-summary">
                                  <div class="debt-row-identity">
                                    <EntityIdentity
                                      entityId={debt.counterparty}
                                      name={entityName(debt.counterparty)}
                                      size={24}
                                      clickable={false}
                                      copyable={false}
                                      showAddress={false}
                                    />
                                    <span class={`debt-status ${debtStatusClass(debt.status)}`}>{debtStatusLabel(debt.status)}</span>
                                  </div>
                                  <div class="debt-row-amounts">
                                    <span>Opened {formatAmount(debt.tokenId, debt.createdAmount)}</span>
                                    <span>Paid {formatAmount(debt.tokenId, debt.paidAmount)}</span>
                                    <strong>Left {formatAmount(debt.tokenId, debt.remainingAmount)}</strong>
                                  </div>
                                </summary>

                                <div class="debt-row-details">
                                  <div class="debt-detail-grid">
                                    <div><span>Opened</span><strong>{formatAmount(debt.tokenId, debt.createdAmount)} · {formatUsd(debtUsd(debt, 'createdAmount'))}</strong></div>
                                    <div><span>Paid</span><strong>{formatAmount(debt.tokenId, debt.paidAmount)} · {formatUsd(debtUsd(debt, 'paidAmount'))}</strong></div>
                                    <div><span>Forgiven</span><strong>{formatAmount(debt.tokenId, debt.forgivenAmount)} · {formatUsd(debtUsd(debt, 'forgivenAmount'))}</strong></div>
                                    <div><span>Left</span><strong>{formatAmount(debt.tokenId, debt.remainingAmount)} · {formatUsd(debtUsd(debt, 'remainingAmount'))}</strong></div>
                                    <div><span>Debt ID</span><code>{debt.debtId}</code></div>
                                    <div><span>Indexes</span><strong>{debt.createdDebtIndex} → {debt.currentDebtIndex ?? 'closed'}</strong></div>
                                    <div><span>Created</span><strong>J#{debt.createdAtBlock} · {debt.createdTxHash || '—'}</strong></div>
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
                              </details>
                            {/each}
                          </div>
                        </details>
                      {/each}
                    </div>
                  </details>
                {/if}
              {/each}
            </div>
          </details>
        {/if}
      {/each}
    </div>
  </details>
{/if}

<style>
  .debt-panel,
  .debt-direction,
  .debt-section,
  .debt-token-group,
  .debt-row {
    border: 1px solid rgba(148, 163, 184, 0.14);
    border-radius: 14px;
    background: rgba(15, 23, 42, 0.48);
  }

  .debt-panel {
    margin: 14px 0;
    overflow: hidden;
  }

  .debt-summary,
  .debt-direction-summary,
  .debt-section-summary,
  .debt-token-summary,
  .debt-row-summary {
    list-style: none;
    cursor: pointer;
  }

  .debt-summary::-webkit-details-marker,
  .debt-direction-summary::-webkit-details-marker,
  .debt-section-summary::-webkit-details-marker,
  .debt-token-summary::-webkit-details-marker,
  .debt-row-summary::-webkit-details-marker {
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
  .debt-direction-title {
    font-size: 14px;
    font-weight: 700;
    color: #f8fafc;
  }

  .debt-summary-meta,
  .debt-direction-meta,
  .debt-section-summary span:last-child,
  .debt-token-summary span:last-child {
    color: #94a3b8;
    font-size: 12px;
  }

  .debt-summary-total strong,
  .debt-direction-summary strong {
    color: #fbbf24;
    font-size: 14px;
  }

  .debt-body,
  .debt-sections,
  .debt-token-groups,
  .debt-rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .debt-body {
    padding: 0 14px 14px;
  }

  .debt-direction-summary,
  .debt-section-summary,
  .debt-token-summary {
    padding: 12px 14px;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
  }

  .debt-sections,
  .debt-token-groups,
  .debt-rows {
    padding: 0 12px 12px;
  }

  .debt-token-actions {
    padding: 0 12px 12px;
    display: flex;
    justify-content: flex-end;
  }

  .debt-enforce-btn {
    border: 1px solid rgba(248, 113, 113, 0.28);
    background: rgba(127, 29, 29, 0.28);
    color: #fecaca;
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
    gap: 10px;
    min-width: 0;
  }

  .debt-status {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .debt-status.open {
    background: rgba(251, 146, 60, 0.16);
    color: #fdba74;
  }

  .debt-status.paid {
    background: rgba(34, 197, 94, 0.14);
    color: #86efac;
  }

  .debt-status.forgiven {
    background: rgba(148, 163, 184, 0.16);
    color: #cbd5e1;
  }

  .debt-row-amounts {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 14px;
    color: #cbd5e1;
    font-size: 12px;
  }

  .debt-row-amounts strong {
    color: #f8fafc;
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
    background: rgba(15, 23, 42, 0.5);
    padding: 10px;
  }

  .debt-detail-grid span {
    color: #94a3b8;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .debt-detail-grid strong,
  .debt-detail-grid code {
    color: #e2e8f0;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .debt-updates {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .debt-updates-title {
    color: #f8fafc;
    font-size: 12px;
    font-weight: 700;
  }

  .debt-update-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    gap: 12px;
    align-items: center;
    font-size: 12px;
    color: #cbd5e1;
    border-radius: 10px;
    background: rgba(15, 23, 42, 0.5);
    padding: 10px 12px;
  }

  .debt-update-row strong {
    color: #f8fafc;
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
