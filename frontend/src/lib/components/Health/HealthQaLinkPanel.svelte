<section id="qa-cockpit" class="qa-link-panel" data-testid="health-qa-link-panel">
  <div class="panel-head">
    <div>
      <h2>QA Evidence</h2>
      <p class="sub">Linked out from health so test evidence stays owned by QA cockpit.</p>
    </div>
    <div class="panel-actions">
      <a class="panel-link" href="/qa">Open QA cockpit</a>
      <a class="panel-link" href="/qa">UX gallery</a>
    </div>
  </div>

  <div class="link-grid">
    <article>
      <span>Runs</span>
      <strong>QA cockpit</strong>
      <small>Unit, contract, e2e, benchmark, transcript, video, artifacts.</small>
    </article>
    <article>
      <span>Screenshots</span>
      <strong>UX gallery</strong>
      <small>Curated mobile and desktop evidence lives in the QA surface.</small>
    </article>
  </div>
</section>

<style>
  .qa-link-panel {
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
    letter-spacing: 0;
  }

  .sub {
    margin: 4px 0 0;
    color: #8e8a80;
    font-size: 12px;
  }

  .panel-link {
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
    font-size: 12px;
    font-weight: 700;
  }

  .panel-link:hover {
    border-color: #9a7940;
    color: #fff4d8;
  }

  .link-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .link-grid article {
    border: 1px solid #38362f;
    border-radius: 10px;
    padding: 12px;
    background: #0d0e0d;
  }

  .link-grid span,
  .link-grid small {
    display: block;
    color: #958e80;
    font-size: 11px;
  }

  .link-grid strong {
    display: block;
    margin: 5px 0;
    color: #eee8dc;
    font-size: 14px;
  }

  @media (max-width: 760px) {
    .panel-head {
      align-items: stretch;
      flex-direction: column;
    }

    .panel-actions {
      justify-content: flex-start;
    }

    .link-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
