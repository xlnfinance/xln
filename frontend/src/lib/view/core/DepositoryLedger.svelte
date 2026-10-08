<script lang="ts">
  /**
   * Presentation ledger: what the Depository itself holds at this step — each bank's reserve
   * and each account's collateral — with the change since the R-frame before flashed beside
   * it. It sits in the empty upper stage, so an on-chain outcome is visible as a number, not
   * only as a moving packet.
   */
  import type { DepositoryLedger, LedgerRow, TokenLookup } from '$lib/network3d/timeline/presentationStage';
  import { formatLedgerAmount } from '$lib/network3d/timeline/presentationStage';

  export let ledger: DepositoryLedger;
  export let tokenOf: TokenLookup;
  /** Changes flash once per step; the step index keys the animation. */
  export let stepIndex: number;

  const amount = (row: LedgerRow): string => {
    const token = tokenOf(row.tokenId);
    return `${formatLedgerAmount(row.amount, token)} ${token.symbol}`;
  };
  const change = (row: LedgerRow): string => {
    const text = formatLedgerAmount(row.change, tokenOf(row.tokenId));
    return row.change > 0n ? `+${text}` : text;
  };
  $: empty = ledger.reserves.length === 0 && ledger.collateral.length === 0 && ledger.debts.length === 0;
</script>

<section class="ledger" data-testid="depository-ledger" aria-label="Depository ledger">
  <h2>Depository <span>on-chain balances</span></h2>
  {#if empty}
    <p class="empty">No reserves or collateral: every position here is bilateral credit.</p>
  {/if}
  {#each [{ title: 'Reserves', rows: ledger.reserves }, { title: 'Collateral', rows: ledger.collateral }, { title: 'Debts, first-come queue', rows: ledger.debts }] as group}
    {#if group.rows.length > 0}
      <h3>{group.title}</h3>
      <ul>
        {#each group.rows as row (row.key)}
          <li class:changed={row.change !== 0n} data-ledger-row={row.key}>
            <span class="label">{row.label}</span>
            <span class="amount">{amount(row)}</span>
            {#if row.change !== 0n}
              {#key `${stepIndex}:${row.key}`}
                <span class="change" class:up={row.change > 0n} class:down={row.change < 0n}>{change(row)}</span>
              {/key}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
</section>

<style>
  .ledger {
    position: fixed;
    top: 22px;
    left: calc(var(--xln-present-narration-width, 460px) + 24px);
    z-index: 24;
    min-width: 330px;
    max-width: min(520px, 34vw);
    padding: 14px 18px 12px;
    border-radius: 12px;
    border: 1px solid rgba(148, 196, 255, 0.16);
    background: rgba(8, 14, 26, 0.86);
    color: #e8eef6;
    font-family: Inter, 'Helvetica Neue', Arial, sans-serif;
    pointer-events: none;
  }

  h2 {
    margin: 0 0 6px;
    font-size: 17px;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: #ffffff;
  }

  h2 span {
    margin-left: 6px;
    color: #7f95ad;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h3 {
    margin: 8px 0 2px;
    color: #8fb1cf;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: minmax(90px, auto) 1fr auto;
    align-items: baseline;
    gap: 12px;
    padding: 3px 0;
    font-size: 17px;
    line-height: 1.3;
  }

  .label {
    color: #c9d6e4;
    white-space: nowrap;
  }

  .amount {
    justify-self: end;
    color: #ffffff;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .change {
    min-width: 70px;
    padding: 1px 8px;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
    animation: flash 1.6s ease-out;
  }

  .change.up {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.12);
  }

  .change.down {
    color: #ff8a99;
    background: rgba(255, 122, 138, 0.12);
  }

  li.changed .amount {
    color: #fff7d6;
  }

  .empty {
    margin: 4px 0 2px;
    color: #9fb1c6;
    font-size: 15px;
    line-height: 1.4;
  }

  @keyframes flash {
    0% { transform: scale(1.35); filter: brightness(1.8); }
    100% { transform: none; filter: none; }
  }

  @media (max-width: 900px) {
    .ledger { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .change { animation: none; }
  }
</style>
