<script lang="ts">
  import { onDestroy } from 'svelte';
  import QRCode from 'qrcode';
  import { Check, Copy, Download, QrCode } from 'lucide-svelte';
  import TokenSelect from '../shared/TokenSelect.svelte';
  import { buildXlnInvoiceUri } from '$lib/utils/xlnInvoice';

  export let entityId: string;

  let amount = '';
  let tokenId = 1;
  let description = '';
  let copiedId = false;
  let copiedInvoice = false;
  let qrDataUrl = '';
  let qrError = '';
  let qrJob = 0;

  const copyText = async (text: string, kind: 'id' | 'invoice'): Promise<void> => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    if (kind === 'id') {
      copiedId = true;
      setTimeout(() => copiedId = false, 1500);
      return;
    }
    copiedInvoice = true;
    setTimeout(() => copiedInvoice = false, 1500);
  };

  $: fullInvoice = buildXlnInvoiceUri({
    targetEntityId: entityId,
    tokenId,
    amount,
    description,
  });
  $: invoicePreview = amount.trim() || description.trim() ? fullInvoice : `xln:?id=${entityId}`;

  $: {
    const nextJob = ++qrJob;
    qrError = '';
    QRCode.toDataURL(invoicePreview, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: {
        dark: '#f5efe6',
        light: '#171513',
      },
    }).then((url) => {
      if (nextJob !== qrJob) return;
      qrDataUrl = url;
    }).catch((error) => {
      if (nextJob !== qrJob) return;
      qrDataUrl = '';
      qrError = error instanceof Error ? error.message : String(error);
    });
  }

  const downloadQr = (): void => {
    if (!qrDataUrl) return;
    const link = document.createElement('a');
    link.download = `xln-invoice-${entityId.slice(2, 10)}.png`;
    link.href = qrDataUrl;
    link.click();
  };

  onDestroy(() => {
    qrJob += 1;
  });
</script>

<div class="receive-panel">
  <div class="receive-intro">
    <div>
      <h3>Receive</h3>
      <p>Use your entity id for open-ended payments, or create a full invoice below.</p>
    </div>
    <button class="secondary-inline" type="button" on:click={() => copyText(entityId, 'id')}>
      {#if copiedId}
        <Check size={14} />
        <span>Copied ID</span>
      {:else}
        <Copy size={14} />
        <span>Copy ID</span>
      {/if}
    </button>
  </div>

  <div class="entity-id-card">
    <div class="entity-id-label">Entity ID</div>
    <code>{entityId}</code>
  </div>

  <div class="receive-grid">
    <section class="invoice-builder">
      <div class="field">
        <label>Amount</label>
        <input type="text" bind:value={amount} placeholder="Optional amount" />
      </div>
      <div class="field">
        <label>Asset</label>
        <div class="token-field">
          <TokenSelect value={tokenId} compact={true} on:change={(event) => tokenId = event.detail.value} />
        </div>
      </div>
      <div class="field">
        <label>Description</label>
        <input type="text" bind:value={description} placeholder="Optional description" />
      </div>
      <div class="invoice-actions">
        <button class="primary-inline" type="button" on:click={() => copyText(invoicePreview, 'invoice')}>
          {#if copiedInvoice}
            <Check size={14} />
            <span>Copied Invoice</span>
          {:else}
            <Copy size={14} />
            <span>Copy Invoice</span>
          {/if}
        </button>
        <button class="secondary-inline" type="button" on:click={downloadQr} disabled={!qrDataUrl}>
          <Download size={14} />
          <span>Download QR</span>
        </button>
      </div>
    </section>

    <section class="invoice-preview">
      <div class="qr-header">
        <QrCode size={16} />
        <span>Invoice QR</span>
      </div>
      {#if qrDataUrl}
        <img class="qr-image" src={qrDataUrl} alt="XLN invoice QR" />
      {:else}
        <div class="qr-placeholder">Generating QR…</div>
      {/if}
      {#if qrError}
        <div class="invoice-error">{qrError}</div>
      {/if}
      <div class="invoice-string">
        <label>Invoice</label>
        <code>{invoicePreview}</code>
      </div>
    </section>
  </div>
</div>

<style>
  .receive-panel {
    --receive-field-h: 48px;
    --receive-field-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    max-width: 1120px;
  }

  .receive-intro {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
  }

  .receive-intro h3 {
    margin: 0 0 6px;
    font-size: 18px;
    color: #f5efe6;
  }

  .receive-intro p {
    margin: 0;
    color: #9a948b;
    font-size: 14px;
  }

  .entity-id-card,
  .invoice-builder,
  .invoice-preview {
    background: #171513;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 16px;
  }

  .entity-id-card {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .entity-id-label,
  label {
    color: #8d857d;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 11px;
    font-weight: 600;
  }

  .entity-id-card code,
  .invoice-string code,
  .wallet-fallback code {
    font-family: 'JetBrains Mono', monospace;
    color: #f5efe6;
    word-break: break-all;
  }

  .receive-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(320px, 420px);
    gap: 18px;
  }

  .invoice-builder,
  .invoice-preview {
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field input {
    width: 100%;
    box-sizing: border-box;
    min-height: var(--receive-field-h);
    padding: 0 14px;
    border-radius: var(--receive-field-radius);
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: #211d1a;
    color: #f5efe6;
    font-size: 14px;
  }

  .field input:focus {
    outline: none;
    border-color: #fbbf24;
  }

  .token-field :global(.token-select) {
    width: 100%;
  }

  .token-field :global(.select-trigger) {
    min-height: var(--receive-field-h);
    border-radius: var(--receive-field-radius);
    background: #211d1a;
  }

  .invoice-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .primary-inline,
  .secondary-inline {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border-radius: 10px;
    padding: 11px 14px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .primary-inline {
    background: linear-gradient(180deg, #8d5421, #a16207);
    color: #fff7ed;
    border-color: #ca8a04;
  }

  .secondary-inline {
    background: rgba(255, 255, 255, 0.04);
    color: #f5efe6;
  }

  .secondary-inline:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .qr-header {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: #f5efe6;
    font-weight: 700;
  }

  .qr-image,
  .qr-placeholder {
    width: min(100%, 320px);
    aspect-ratio: 1;
    border-radius: 16px;
    align-self: center;
    background: #0e0c0b;
    border: 1px solid rgba(255, 255, 255, 0.08);
    object-fit: contain;
    display: block;
  }

  .qr-placeholder {
    display: grid;
    place-items: center;
    color: #8d857d;
    font-size: 14px;
  }

  .invoice-string {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .invoice-string code {
    display: block;
    max-height: 124px;
    overflow: auto;
    padding: 12px 14px;
    border-radius: 12px;
    background: #211d1a;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .invoice-error {
    color: #f87171;
    font-size: 13px;
  }

  @media (max-width: 980px) {
    .receive-grid {
      grid-template-columns: 1fr;
    }

    .receive-intro {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
