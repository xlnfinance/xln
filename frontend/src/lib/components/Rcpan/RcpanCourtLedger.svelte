<script lang="ts">
  import type {
    MicroscopeCourtDisplay,
    MicroscopeCourtPlacement,
    MicroscopeCourtRow,
  } from './microscope-visual-types';
  import './rcpan-court-ledger.css';

  export let display: MicroscopeCourtDisplay;
  export let placement: MicroscopeCourtPlacement = 'top';

  function validateRow(row: MicroscopeCourtRow): void {
    if (!row.tokenKey || !row.tokenSymbol) throw new Error('RCPAN court row requires token identity');
    const values = [
      row.leftReserveLabel,
      row.rightReserveLabel,
      row.collateralLabel,
      row.signedDeltaLabel,
      row.finalDeltaLabel,
      row.verdictLabel,
    ];
    if (values.some((value) => value === '')) throw new Error(`RCPAN court ${row.tokenKey} row has an empty display value`);
  }

  function validateDisplay(value: MicroscopeCourtDisplay): void {
    if (!value.courtLabel || !value.machineLabel || !value.phase.title || !value.color) {
      throw new Error('RCPAN court requires court, machine, and phase labels');
    }
    if (value.rows.length === 0 || value.rows.length > 4) {
      throw new Error('RCPAN court ledger requires 1 to 4 token rows');
    }
    for (const row of value.rows) validateRow(row);
    if (value.request.visible && (!value.request.fromLabel || !value.request.actionLabel || !value.request.proofLabel)) {
      throw new Error('RCPAN court request path requires visible labels');
    }
  }

  $: validateDisplay(display);
</script>

<section
  class="court-ledger placement-{placement} tone-{display.phase.tone}"
  class:fixed-rail={display.mode === 'fixed-rail'}
  style={`--court-custom:${display.color}`}
  data-placement={placement}
  data-testid="microscope-court-ledger"
  aria-label={display.courtLabel}
>
  {#if display.request.visible}
    <div
      class="court-request initiator-{display.request.initiator}"
      class:moving={display.request.moving}
      style={`--request-color:${display.request.color}`}
      data-testid="microscope-court-request"
    >
      <span class="request-origin">{display.request.fromLabel}</span>
      <span class="request-track" aria-hidden="true"><i></i></span>
      <span class="request-proof">{display.request.proofLabel}</span>
      <span class="request-action">{display.request.actionLabel}</span>
    </div>
  {/if}

  <header class="court-header">
    <div class="court-identity">
      <span class="court-icon" aria-hidden="true">
        <svg viewBox="0 0 28 28">
          <path d="m3 10 11-6 11 6H3Zm2 3h18M7 13v8m5-8v8m4-8v8m5-8v8M4 24h20" />
        </svg>
      </span>
      <span><b>{display.courtLabel}</b><small>{display.machineLabel}</small></span>
    </div>

    <div class="phase-header">
      <span>{display.phase.stepLabel}</span>
      <b>{display.phase.title}</b>
      <small>{display.phase.detail}</small>
    </div>

    <div class="phase-progress">
      <i></i><span>{display.phase.progressLabel}</span>
    </div>
  </header>

  <div class="ledger-scroll">
    <div class="ledger-grid ledger-head" aria-hidden="true">
      <span>Token</span>
      <span>Left · {display.leftLabel}</span>
      <span>Right · {display.rightLabel}</span>
      <span>Collateral</span>
      <span>Signed Δ</span>
      <span>Final Δ</span>
      <span>Verdict</span>
    </div>

    <div class="ledger-body">
      {#each display.rows as row (row.tokenKey)}
        <div class="ledger-grid ledger-row row-{row.tone}" data-testid={`microscope-court-row-${row.tokenKey}`}>
          <span class="token-cell" data-label="Token" style={`--token-color:${row.tokenColor}`}>
            <i></i><b>{row.tokenSymbol}</b>
          </span>
          <span data-label="Left reserve">{row.leftReserveLabel}</span>
          <span data-label="Right reserve">{row.rightReserveLabel}</span>
          <span class="collateral-cell" data-label="Collateral">{row.collateralLabel}</span>
          <span data-label="Signed Δ">{row.signedDeltaLabel}</span>
          <span class="final-cell" data-label="Final Δ">{row.finalDeltaLabel}</span>
          <span class="verdict-cell" data-label="Verdict">{row.verdictLabel}</span>
        </div>
      {/each}
    </div>
  </div>

  <footer class="court-footer">
    <span><i></i> {display.footerNote}</span>
    <strong>{display.footerSummary}</strong>
  </footer>
</section>
