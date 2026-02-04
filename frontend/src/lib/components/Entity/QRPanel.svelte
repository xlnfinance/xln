<!--
  QRPanel.svelte - Receive payments via QR code

  Share entity address for incoming payments.
  Compatible with Send tab for end-to-end payments.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { xlnFunctions } from '../../stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { Copy, Check, QrCode, Camera, Download } from 'lucide-svelte';

  export let entityId: string = '';

  // Context
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  $: activeFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;

  // State
  let qrCanvas: HTMLCanvasElement;
  let copied = false;
  let qrSize = 200;

  // Format short ID
  function formatShortId(id: string): string {
    return id || '';
  }

  // Simple QR code generator (minimal implementation)
  // In production, use a proper library like qrcode
  function generateQR(data: string, canvas: HTMLCanvasElement, size: number) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = size;
    canvas.height = size;

    // Background
    ctx.fillStyle = '#1c1917';
    ctx.fillRect(0, 0, size, size);

    // Simple visual representation (not a real QR code)
    // For real QR, integrate a library like 'qrcode'
    const moduleSize = Math.floor(size / 25);
    const padding = Math.floor((size - moduleSize * 21) / 2);

    ctx.fillStyle = '#fbbf24';

    // Generate pseudo-random pattern from data hash
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash) + data.charCodeAt(i);
      hash = hash & hash;
    }

    // Position patterns (corners)
    const drawPositionPattern = (x: number, y: number) => {
      ctx.fillRect(padding + x * moduleSize, padding + y * moduleSize, moduleSize * 7, moduleSize);
      ctx.fillRect(padding + x * moduleSize, padding + (y + 6) * moduleSize, moduleSize * 7, moduleSize);
      ctx.fillRect(padding + x * moduleSize, padding + y * moduleSize, moduleSize, moduleSize * 7);
      ctx.fillRect(padding + (x + 6) * moduleSize, padding + y * moduleSize, moduleSize, moduleSize * 7);
      ctx.fillRect(padding + (x + 2) * moduleSize, padding + (y + 2) * moduleSize, moduleSize * 3, moduleSize * 3);
    };

    drawPositionPattern(0, 0);
    drawPositionPattern(14, 0);
    drawPositionPattern(0, 14);

    // Data modules (pseudo-random based on hash)
    let seed = Math.abs(hash);
    for (let y = 0; y < 21; y++) {
      for (let x = 0; x < 21; x++) {
        // Skip position patterns
        if ((x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12)) continue;

        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        if (seed % 3 === 0) {
          ctx.fillRect(padding + x * moduleSize, padding + y * moduleSize, moduleSize, moduleSize);
        }
      }
    }

    // Center logo area
    ctx.fillStyle = '#0c0a09';
    ctx.fillRect(size / 2 - 20, size / 2 - 20, 40, 40);
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 16px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('XLN', size / 2, size / 2);
  }

  // Generate QR on mount and when entityId changes
  $: if (qrCanvas && entityId) {
    generateQR(entityId, qrCanvas, qrSize);
  }

  async function copyEntityId() {
    if (!entityId) return;
    await navigator.clipboard.writeText(entityId);
    copied = true;
    setTimeout(() => copied = false, 2000);
  }

  function downloadQR() {
    if (!qrCanvas) return;
    const link = document.createElement('a');
    link.download = `xln-entity-${formatShortId(entityId)}.png`;
    link.href = qrCanvas.toDataURL('image/png');
    link.click();
  }

  // XLN payment URI format
  $: paymentUri = entityId ? `xln:${entityId}` : '';
</script>

<div class="qr-panel">
  <header class="panel-header">
    <h3>Receive Payments</h3>
  </header>

  {#if !entityId}
    <div class="empty-state">
      <QrCode size={40} />
      <p>Select an entity to generate QR code</p>
    </div>
  {:else}
    <!-- QR Code Display -->
    <div class="qr-container">
      <canvas bind:this={qrCanvas}></canvas>
    </div>

    <!-- Entity Info -->
    <div class="entity-info">
      <div class="short-id">{formatShortId(entityId)}</div>
      <div class="full-id">
      <code>{entityId}</code>
        <button class="copy-btn" on:click={copyEntityId}>
          {#if copied}
            <Check size={14} />
          {:else}
            <Copy size={14} />
          {/if}
        </button>
      </div>
    </div>

    <!-- Payment URI -->
    <div class="uri-section">
      <label>Payment URI</label>
      <div class="uri-display">
        <code>{paymentUri}</code>
        <button class="copy-btn" on:click={() => navigator.clipboard.writeText(paymentUri)}>
          <Copy size={12} />
        </button>
      </div>
    </div>

    <!-- Actions -->
    <div class="actions">
      <button class="btn-action" on:click={downloadQR}>
        <Download size={14} />
        Download QR
      </button>
    </div>

    <!-- Instructions -->
    <div class="instructions">
      <p>Share your entity address to receive payments. Senders can use the Send tab with this address for direct or routed transfers.</p>
    </div>
  {/if}
</div>

<style>
  .qr-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .panel-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: #e7e5e4;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px;
    color: #57534e;
    gap: 12px;
  }

  .empty-state p {
    margin: 0;
    font-size: 13px;
  }

  .qr-container {
    display: flex;
    justify-content: center;
    padding: 20px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 12px;
  }

  .qr-container canvas {
    border-radius: 8px;
  }

  .entity-info {
    text-align: center;
  }

  .short-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 24px;
    font-weight: 700;
    color: #fbbf24;
    margin-bottom: 8px;
  }

  .full-id {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .full-id code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #78716c;
  }

  .copy-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: #292524;
    border: none;
    border-radius: 4px;
    color: #78716c;
    cursor: pointer;
  }

  .copy-btn:hover {
    color: #fbbf24;
  }

  .uri-section {
    padding: 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
  }

  .uri-section label {
    display: block;
    font-size: 10px;
    color: #57534e;
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  .uri-display {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .uri-display code {
    flex: 1;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #a8a29e;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .btn-action {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    color: #a8a29e;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-action:hover {
    border-color: #fbbf24;
    color: #fbbf24;
  }

  .instructions {
    padding: 12px;
    background: rgba(251, 191, 36, 0.05);
    border: 1px solid rgba(251, 191, 36, 0.1);
    border-radius: 8px;
  }

  .instructions p {
    margin: 0;
    font-size: 12px;
    color: #78716c;
    line-height: 1.5;
  }
</style>
