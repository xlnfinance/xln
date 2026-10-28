<script lang="ts">
  import { onMount } from 'svelte';
  import type { JFeeQuote } from '@xln/core/api/public/runtime-module';
  import { getRuntimeControllerAdapter } from '#lib/stores/runtimeControllerStore.ts';
  export let entityId: string;
  let quote: JFeeQuote | null = null;
  let error = '';
  let now = Date.now();
  const fee = (value: string) => {
    const wei = BigInt(value);
    return `${wei / 1_000_000_000n}.${(wei % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '') || '0'}`;
  };
  onMount(() => {
    let alive = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      const requested = entityId;
      try {
        const adapter = getRuntimeControllerAdapter();
        const next = adapter ? await adapter.read<JFeeQuote | null>('j-fee', { entityId: requested }) : null;
        if (alive && entityId === requested) { quote = next; error = ''; now = Date.now(); }
      } catch (cause) {
        if (alive) error = cause instanceof Error ? cause.message : String(cause);
      } finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { alive = false; clearInterval(timer); };
  });
</script>
{#if error}<p role="alert">Fee estimate unavailable: {error}</p>
{:else if quote}
  <p role="alert" data-testid="batch-fee-warning">
    {quote.deadline === null ? 'Pending EVM transaction.' : `Dispute response deadline: ${Math.max(0, Math.ceil((quote.deadline - now) / 1000))}s left.`}
    Max fee {fee(quote.currentMaxFeeWei)} → suggested {fee(quote.suggestedMaxFeeWei)} gwei;
    priority {fee(quote.currentPriorityFeeWei)} → {fee(quote.suggestedPriorityFeeWei)} gwei.
    Speed up keeps the same nonce and call.
  </p>
{/if}
