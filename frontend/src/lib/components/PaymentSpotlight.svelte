<script lang="ts">
  import { paymentSpotlight } from '#lib/stores/network/paymentSpotlightStore.ts';

  const opened = paymentSpotlight.opened;
  $: spotlight = $opened;
  const dismiss = paymentSpotlight.close;
  const openReceipt = (dialog: HTMLDialogElement) => { dialog.showModal(); };
</script>

{#if $paymentSpotlight}
  <aside class="payment-notice" data-testid="payment-notification" role="status" aria-live="polite">
    <span>{$paymentSpotlight.kicker || 'Payment'} {$paymentSpotlight.amountLine}</span>
    <button data-testid="receipt-open" on:click={paymentSpotlight.open}>Receipt</button>
    <button aria-label="Dismiss payment notification" on:click={paymentSpotlight.clear}>×</button>
  </aside>
{/if}

{#if spotlight}
    <dialog class="receipt-card" use:openReceipt on:cancel={(event) => { event.preventDefault(); dismiss(); }} aria-label="Payment receipt" data-testid="payment-receipt">
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
        <span class="receipt-time">{new Date(spotlight.observedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        <span class="receipt-status">Confirmed</span>
      </div>

      <button class="receipt-dismiss" on:click={dismiss}>Done</button>
    </dialog>
{/if}

<style>
  .payment-notice { position: fixed; bottom: 24px; left: 24px; z-index: 9998; display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 48px); padding: 12px 16px; border-radius: 12px; color: #e7e5e4; background: #1c1917; border: 1px solid #44403c; pointer-events: none; }
  .payment-notice button { pointer-events: auto; cursor: pointer; color: #86efac; background: transparent; border: 0; padding: 8px; }

  .receipt-card::backdrop { background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(8px); }

  .receipt-card {
    margin: auto;
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
