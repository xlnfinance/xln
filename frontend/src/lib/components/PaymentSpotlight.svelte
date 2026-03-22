<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { paymentSpotlight, type PaymentSpotlight } from '$lib/stores/paymentSpotlightStore';

  let spotlight: PaymentSpotlight | null = null;
  paymentSpotlight.subscribe((value) => spotlight = value);

  function dismiss() {
    paymentSpotlight.clear();
  }
</script>

{#if spotlight}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="receipt-backdrop" in:fade={{ duration: 150 }} out:fade={{ duration: 120 }} on:click={dismiss} role="presentation">
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="receipt-card" in:fly={{ y: 30, duration: 250 }} out:fly={{ y: -20, duration: 150 }} on:click|stopPropagation role="dialog">
      <div class="receipt-check">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="24" fill="rgba(74, 222, 128, 0.12)" />
          <circle cx="24" cy="24" r="18" fill="rgba(74, 222, 128, 0.2)" />
          <path d="M16 24L22 30L34 18" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>

      <div class="receipt-kicker">{spotlight.kicker || 'Payment Sent'}</div>

      <div class="receipt-amount">{spotlight.amountLine}</div>

      <div class="receipt-title">{spotlight.title}</div>

      {#if spotlight.detail}
        <div class="receipt-detail">{spotlight.detail}</div>
      {/if}

      <div class="receipt-divider"></div>

      <div class="receipt-meta">
        <span class="receipt-time">{new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        <span class="receipt-status">Confirmed</span>
      </div>

      <button class="receipt-dismiss" on:click={dismiss}>Done</button>
    </div>
  </div>
{/if}

<style>
  .receipt-backdrop {
    position: fixed;
    inset: 0;
    z-index: 12000;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(8px);
    padding: 24px;
  }

  .receipt-card {
    width: min(380px, calc(100vw - 48px));
    padding: 32px 28px 24px;
    border-radius: 20px;
    background: #1a1a1e;
    border: 1px solid #2f2f35;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .receipt-check {
    margin-bottom: 16px;
  }

  .receipt-kicker {
    color: #4ade80;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 8px;
  }

  .receipt-amount {
    font-size: clamp(28px, 5vw, 40px);
    font-weight: 700;
    color: #f3f4f6;
    letter-spacing: -0.03em;
    line-height: 1.1;
    margin-bottom: 6px;
  }

  .receipt-title {
    color: #9ca3af;
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 4px;
  }

  .receipt-detail {
    color: #6b7280;
    font-size: 12px;
    margin-top: 4px;
    line-height: 1.4;
  }

  .receipt-divider {
    width: 100%;
    height: 1px;
    background: #27272a;
    margin: 18px 0 12px;
  }

  .receipt-meta {
    display: flex;
    justify-content: space-between;
    width: 100%;
    color: #52525b;
    font-size: 11px;
    margin-bottom: 18px;
  }

  .receipt-status {
    color: #4ade80;
    font-weight: 600;
  }

  .receipt-dismiss {
    width: 100%;
    padding: 12px;
    border-radius: 10px;
    border: none;
    background: rgba(74, 222, 128, 0.1);
    color: #4ade80;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .receipt-dismiss:hover {
    background: rgba(74, 222, 128, 0.18);
  }
</style>
