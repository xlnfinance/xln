<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { SwapCompletionModal } from './swap-order-history';

  export let modal: SwapCompletionModal;
  export let formatAmount: (amount: bigint, tokenId: number) => string;
  export let tokenSymbol: (tokenId: number) => string;
  export let formatPriceImprovement: (amount: bigint, tokenId: number | null) => string;
  export let formatSwapFee: (amount: bigint, tokenId: number | null) => string;

  const dispatch = createEventDispatcher<{ close: void }>();
</script>

<div class="swap-modal-overlay">
  <div class="swap-modal">
    <div class="swap-modal-kicker">Swap Filled</div>
    <h3>{modal.side} {modal.pairLabel}</h3>
    <p class="swap-modal-copy">
      {formatAmount(modal.filledGiveAmount, modal.giveTokenId)} {tokenSymbol(modal.giveTokenId)}
      → {formatAmount(modal.filledWantAmount, modal.wantTokenId)} {tokenSymbol(modal.wantTokenId)}
    </p>
    {#if modal.priceImprovementAmount > 0n}
      <p class="swap-modal-improvement">
        Price Improvement: <strong>{formatPriceImprovement(modal.priceImprovementAmount, modal.priceImprovementTokenId)}</strong>
      </p>
    {/if}
    {#if modal.feeAmount > 0n}
      <p class="swap-modal-improvement">
        Fee: <strong>{formatSwapFee(modal.feeAmount, modal.feeTokenId)}</strong>
      </p>
    {/if}
    <div class="swap-modal-actions">
      <button
        class="scope-btn active"
        data-testid="swap-completion-close"
        on:click={() => dispatch('close')}
      >Close</button>
    </div>
  </div>
</div>
