<script lang="ts">
  import { onDestroy } from 'svelte';
  import { emptyLendingBalance, watchLendingBalance, type LendingBalanceAccount } from '#lib/utils/ui/lendingBalance.ts';
  import { walletHelp } from '#lib/utils/ui/walletHelp.ts';
  export let entityId: string;
  export let apiBase: string;
  export let accounts: LendingBalanceAccount[];
  export let isLive: boolean;
  export let walletBalance: number;
  export let getAssetValue: (token: number, amount: bigint) => number;
  export let formatUsdExact: (value: number) => string;
  let result = emptyLendingBalance();
  let previous = '';
  let stop = () => {};
  $: key = JSON.stringify({ apiBase, userEntityId: entityId, accounts, isLive });
  $: if (key !== previous) {
    previous = key;
    stop();
    result = emptyLendingBalance();
    if (isLive) stop = watchLendingBalance({ apiBase, userEntityId: entityId, accounts }, value => { result = value; });
  }
  $: lendingValue = [...result.byToken].reduce((sum, [token, amount]) => sum + getAssetValue(token, amount), 0);
  $: unavailable = result.loading || Boolean(result.error) || (!isLive && accounts.some(account => account.intents.length > 0));
  onDestroy(() => stop());
</script>

<div class="total" data-testid="home-total">
  {unavailable ? 'Updating total balance…' : formatUsdExact(walletBalance + lendingValue)}
</div>
{#if lendingValue !== 0 || unavailable}
  <div class="note" data-testid="home-lending-balance">
    {unavailable ? 'Lending positions are being reconciled with your wallet.' : `Lending deposits minus loans: ${formatUsdExact(lendingValue)} · reported by your hub`}
    {#if result.error}<p role="alert">{result.error}</p>{/if}
    <details><summary>How lending affects my balance</summary><p>{walletHelp['lendingBalance']}</p></details>
  </div>
{/if}

<style>
  .total { color: var(--theme-text-primary, #f4f4f5); font-size: 28px; line-height: 1.2; font-weight: 800; overflow-wrap: anywhere; }
  .note { margin-top: 6px; font-size: 12px; max-width: 440px; overflow-wrap: anywhere; }
  summary { cursor: pointer; }
  p { line-height: 1.5; }
  @media (max-width: 760px) { .total { font-size: 24px; } }
</style>
