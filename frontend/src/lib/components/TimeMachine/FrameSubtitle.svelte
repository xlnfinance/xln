<script lang="ts">
  export let subtitle: {
    title: string;
    what: string;
    why: string;
    tradfiParallel: string;
    keyMetrics?: string[];
  } | undefined;

  export let visible: boolean = true;

  let expanded = false;
</script>

{#if visible && subtitle}
  <div class="subtitle-overlay" class:expanded>
    <!-- Compact pill (always visible) -->
    <button class="subtitle-pill" on:click={() => expanded = !expanded}>
      <span class="pill-title">{subtitle.title}</span>
      <span class="pill-toggle">{expanded ? '−' : '+'}</span>
    </button>

    <!-- Expanded card -->
    {#if expanded}
      <div class="subtitle-card">
        <div class="card-row">
          <div class="card-section what">
            <span class="tag">What</span>
            <p>{subtitle.what}</p>
          </div>
          <div class="card-section why">
            <span class="tag">Why</span>
            <p>{subtitle.why}</p>
          </div>
        </div>
        <div class="card-row tradfi-row">
          <div class="card-section tradfi">
            <span class="tag">TradFi</span>
            <p>{subtitle.tradfiParallel}</p>
          </div>
          {#if subtitle.keyMetrics && subtitle.keyMetrics.length > 0}
            <div class="card-section metrics">
              <span class="tag">Metrics</span>
              <div class="metrics-list">
                {#each subtitle.keyMetrics as metric}
                  <span class="metric">{metric}</span>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .subtitle-overlay {
    /* Fixed position above the fixed time machine bar (60px height + 8px margin) */
    position: fixed;
    bottom: 68px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    z-index: 101; /* Above time machine (z-index: 100) */
    pointer-events: none;
  }

  /* Compact pill - liquid glass style */
  .subtitle-pill {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(40px) saturate(180%);
    -webkit-backdrop-filter: blur(40px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 20px;
    cursor: pointer;
    pointer-events: auto;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow:
      0 4px 24px rgba(0, 0, 0, 0.15),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }

  .subtitle-pill:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.2);
    transform: translateY(-1px);
    box-shadow:
      0 6px 32px rgba(0, 0, 0, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.12);
  }

  .pill-title {
    font-size: 13px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.9);
    letter-spacing: 0.01em;
  }

  .pill-toggle {
    font-size: 14px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.5);
    width: 16px;
    text-align: center;
  }

  /* Expanded card - liquid glass */
  .subtitle-card {
    background: rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(40px) saturate(180%);
    -webkit-backdrop-filter: blur(40px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 16px;
    max-width: 700px;
    width: calc(100vw - 48px);
    pointer-events: auto;
    animation: expandIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    box-shadow:
      0 8px 40px rgba(0, 0, 0, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }

  @keyframes expandIn {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .card-row {
    display: flex;
    gap: 12px;
  }

  .card-row + .card-row {
    margin-top: 12px;
  }

  .card-section {
    flex: 1;
    min-width: 0;
  }

  .tag {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.4);
    margin-bottom: 4px;
  }

  .card-section p {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.8);
  }

  .what .tag { color: rgba(0, 200, 255, 0.7); }
  .why .tag { color: rgba(100, 255, 180, 0.7); }
  .tradfi .tag { color: rgba(255, 200, 100, 0.7); }
  .metrics .tag { color: rgba(200, 150, 255, 0.7); }

  .tradfi-row {
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .metrics-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .metric {
    font-size: 11px;
    padding: 3px 8px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.7);
  }

  /* Responsive */
  @media (max-width: 600px) {
    .subtitle-overlay {
      width: calc(100vw - 32px);
      max-width: none;
    }

    .card-row {
      flex-direction: column;
      gap: 10px;
    }

    .subtitle-card {
      padding: 12px;
      width: 100%;
    }

    .pill-title {
      font-size: 12px;
    }
  }
</style>
