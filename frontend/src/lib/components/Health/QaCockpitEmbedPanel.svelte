<script lang="ts">
  let embedded = $state(false);
</script>

<section id="qa-cockpit" class="qa-cockpit-panel">
  <div class="panel-head">
    <div>
      <h2>QA Cockpit</h2>
      <p class="sub">Same-origin embedded run inspector</p>
    </div>
    <div class="panel-actions">
      <button class="ghost" onclick={() => (embedded = !embedded)}>
        {embedded ? 'Hide embed' : 'Embed cockpit'}
      </button>
      <a class="panel-link" href="/qa">Open full</a>
    </div>
  </div>

  {#if embedded}
    <iframe
      class="qa-cockpit-frame"
      title="QA Cockpit"
      src="/qa?embed=1"
      loading="lazy"
      allowfullscreen
    ></iframe>
  {:else}
    <div class="qa-cockpit-placeholder">
      <strong>QA cockpit is ready to embed.</strong>
      <span>It reads the same `/api/qa/*` surface as this health admin.</span>
    </div>
  {/if}
</section>

<style>
  .qa-cockpit-panel {
    border: 1px solid #2c2a25;
    border-radius: 12px;
    padding: 13px;
    background: linear-gradient(180deg, #121312, #0c0d0d);
  }

  .panel-head,
  .panel-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .panel-head {
    margin-bottom: 12px;
  }

  .panel-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  h2 {
    margin: 0 0 6px;
    color: #efe8d8;
    font-size: 16px;
    letter-spacing: 0.2px;
  }

  .sub {
    margin: 4px 0 0;
    color: #8e8a80;
    font-size: 12px;
  }

  .panel-link,
  button.ghost {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #38362f;
    border-radius: 8px;
    padding: 0 11px;
    color: #efe8d8;
    background: #171715;
    text-decoration: none;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .panel-link:hover,
  button.ghost:hover {
    border-color: #9a7940;
    color: #fff4d8;
  }

  .qa-cockpit-frame {
    width: 100%;
    height: min(820px, calc(100vh - 130px));
    min-height: 560px;
    display: block;
    border: 1px solid #38362f;
    border-radius: 10px;
    background: #09090b;
  }

  .qa-cockpit-placeholder {
    min-height: 96px;
    display: grid;
    align-content: center;
    gap: 6px;
    border: 1px dashed #38362f;
    border-radius: 10px;
    padding: 18px;
    background: #0d0e0d;
    color: #958e80;
  }

  .qa-cockpit-placeholder strong {
    color: #eee8dc;
  }

  .qa-cockpit-placeholder span {
    font-size: 12px;
  }

  @media (max-width: 760px) {
    .panel-head {
      align-items: stretch;
      flex-direction: column;
    }

    .panel-actions {
      justify-content: flex-start;
    }

    .qa-cockpit-frame {
      min-height: 680px;
    }
  }
</style>
