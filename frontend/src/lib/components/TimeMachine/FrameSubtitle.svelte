<script lang="ts">
  export let subtitle: {
    title: string;
    what: string;
    why: string;
    tradfiParallel: string;
    keyMetrics?: string[];
  } | undefined;

  export let visible: boolean = true;
</script>

{#if visible && subtitle}
  <div class="subtitle-overlay">
    <div class="subtitle-card">
      <div class="subtitle-header">
        <span class="subtitle-icon">📊</span>
        <h3>{subtitle.title}</h3>
      </div>

      <div class="subtitle-section">
        <div class="section-label">
          <span class="icon">⚙️</span>
          <strong>What's Happening</strong>
        </div>
        <p>{subtitle.what}</p>
      </div>

      <div class="subtitle-section">
        <div class="section-label">
          <span class="icon">💡</span>
          <strong>Why This Matters</strong>
        </div>
        <p>{subtitle.why}</p>
      </div>

      <div class="subtitle-section tradfi">
        <div class="section-label">
          <span class="icon">🏦</span>
          <strong>Traditional Finance Parallel</strong>
        </div>
        <p>{subtitle.tradfiParallel}</p>
      </div>

      {#if subtitle.keyMetrics && subtitle.keyMetrics.length > 0}
        <div class="subtitle-section metrics">
          <div class="section-label">
            <span class="icon">📈</span>
            <strong>Key Metrics</strong>
          </div>
          <ul>
            {#each subtitle.keyMetrics as metric}
              <li>{metric}</li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .subtitle-overlay {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    max-width: 800px;
    width: calc(100% - 40px);
    pointer-events: none;
  }

  .subtitle-card {
    background: rgba(10, 10, 15, 0.95);
    backdrop-filter: blur(20px);
    border: 2px solid rgba(0, 217, 255, 0.3);
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 60px rgba(0, 217, 255, 0.15);
    pointer-events: auto;
    animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .subtitle-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid rgba(0, 217, 255, 0.2);
  }

  .subtitle-icon {
    font-size: 24px;
  }

  h3 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: #00d9ff;
    letter-spacing: -0.02em;
  }

  .subtitle-section {
    margin-bottom: 16px;
  }

  .subtitle-section:last-child {
    margin-bottom: 0;
  }

  .section-label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .icon {
    font-size: 16px;
  }

  .section-label strong {
    font-size: 13px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  p {
    margin: 0;
    font-size: 15px;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.85);
    padding-left: 24px;
  }

  .tradfi {
    background: rgba(0, 122, 204, 0.08);
    padding: 12px;
    border-radius: 8px;
    border-left: 3px solid rgba(0, 122, 204, 0.5);
  }

  .tradfi p {
    padding-left: 0;
  }

  .metrics {
    background: rgba(0, 217, 255, 0.05);
    padding: 12px;
    border-radius: 8px;
  }

  ul {
    margin: 0;
    padding: 0 0 0 24px;
    list-style: none;
  }

  li {
    font-size: 14px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.8);
    position: relative;
    padding-left: 16px;
  }

  li:before {
    content: '▸';
    position: absolute;
    left: 0;
    color: #00d9ff;
    font-weight: bold;
  }

  /* Responsive design */
  @media (max-width: 900px) {
    .subtitle-overlay {
      max-width: 600px;
    }

    .subtitle-card {
      padding: 20px;
    }

    h3 {
      font-size: 18px;
    }

    p {
      font-size: 14px;
    }
  }

  @media (max-width: 600px) {
    .subtitle-overlay {
      bottom: 10px;
      width: calc(100% - 20px);
    }

    .subtitle-card {
      padding: 16px;
    }

    h3 {
      font-size: 16px;
    }

    p {
      font-size: 13px;
    }

    li {
      font-size: 13px;
    }
  }
</style>
