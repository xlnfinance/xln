<script lang="ts">
  import { fade, scale } from 'svelte/transition';
  import { paymentSpotlight, type PaymentSpotlight } from '$lib/stores/paymentSpotlightStore';

  let spotlight: PaymentSpotlight | null = null;
  paymentSpotlight.subscribe((value) => spotlight = value);
</script>

{#if spotlight}
  <div class="payment-spotlight-backdrop" in:fade={{ duration: 140 }} out:fade={{ duration: 140 }}>
    <div class="payment-spotlight-card" in:scale={{ duration: 180, start: 0.96 }} out:scale={{ duration: 140, start: 1 }}>
      <div class="payment-spotlight-kicker">Payment Received</div>
      <h2>{spotlight.title}</h2>
      <div class="payment-spotlight-amount">{spotlight.amountLine}</div>
      {#if spotlight.detail}
        <div class="payment-spotlight-detail">{spotlight.detail}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .payment-spotlight-backdrop {
    position: fixed;
    inset: 0;
    z-index: 12000;
    display: grid;
    place-items: center;
    background: rgba(5, 8, 14, 0.48);
    backdrop-filter: blur(10px);
    padding: 24px;
  }

  .payment-spotlight-card {
    width: min(640px, calc(100vw - 32px));
    padding: 36px 34px 32px;
    border-radius: 28px;
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.94));
    border: 1px solid rgba(110, 231, 183, 0.24);
    box-shadow: 0 30px 90px rgba(15, 23, 42, 0.45);
    color: #f8fafc;
    text-align: center;
  }

  .payment-spotlight-kicker {
    margin-bottom: 12px;
    color: #6ee7b7;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: clamp(34px, 6vw, 56px);
    line-height: 0.98;
    letter-spacing: -0.04em;
  }

  .payment-spotlight-amount {
    margin-top: 14px;
    color: rgba(248, 250, 252, 0.92);
    font-size: clamp(18px, 2.6vw, 24px);
    font-weight: 600;
  }

  .payment-spotlight-detail {
    margin-top: 16px;
    color: rgba(226, 232, 240, 0.84);
    font-size: 15px;
    line-height: 1.45;
  }
 </style>
