<script lang="ts">
  import QaProtectedImage from './QaProtectedImage.svelte';
  import QaProtectedVideo from './QaProtectedVideo.svelte';
  import {
    formatQaBytes,
    shortHealthId,
    type QaAdminHealthSnapshot,
    type QaAdminStoryCard,
  } from '$lib/qa/adminEvidence';

  type Props = {
    stories: QaAdminStoryCard[];
    health: QaAdminHealthSnapshot | null;
    healthError?: string | null;
    loadingHealth?: boolean;
    onOpenScreenshot?: (index: number) => void;
    onSelectShard?: (index: number) => void;
  };

  let {
    stories,
    health,
    healthError = null,
    loadingHealth = false,
    onOpenScreenshot,
    onSelectShard,
  }: Props = $props();

  const visibleOwners = $derived((health?.owners ?? []).slice(0, 8));
  const visibleTracks = $derived((health?.tracked ?? []).slice(0, 6));
  const visibleCreditPairs = $derived((health?.creditPairs ?? []).slice(0, 4));

  const openScreenshot = (index: number | null): void => {
    if (typeof index !== 'number') return;
    onOpenScreenshot?.(index);
  };

  const selectShard = (index: number | null): void => {
    if (typeof index !== 'number') return;
    onSelectShard?.(index);
  };
</script>

<section class="evidence-board" data-testid="qa-admin-evidence-board">
  <div class="board-head">
    <div>
      <div class="eyebrow">Pre-mainnet user stories</div>
      <h2>4 flows to inspect first</h2>
      <p>Payment, swap, cross-chain route, and dispute evidence. Each card links the video shard and a screenshot.</p>
    </div>
    <div class="board-counts">
      <span>{stories.filter(story => story.video).length}/4 videos</span>
      <span>{stories.filter(story => story.screenshot).length}/4 screens</span>
    </div>
  </div>

  <div class="story-grid">
    {#each stories as story}
      <article class="story-card" data-testid="qa-admin-story-card" data-story-key={story.key}>
        <div class="story-copy">
          <span>{story.short}</span>
          <h3>{story.title}</h3>
          <p>{story.full}</p>
        </div>
        <div class="story-media">
          {#if story.video}
            <QaProtectedVideo url={story.video.url ?? ''} testId="qa-story-video" />
          {:else if story.screenshot}
            <button type="button" class="story-screenshot-button" onclick={() => openScreenshot(story.screenshotIndex)}>
              <QaProtectedImage url={story.screenshot.url} alt={story.screenshot.title} loading="lazy" />
              <span>open screenshot</span>
            </button>
          {:else}
            <div class="story-missing">no evidence yet</div>
          {/if}
        </div>
        <div class="story-actions">
          <button type="button" disabled={story.shardIndex === null} onclick={() => selectShard(story.shardIndex)}>
            Open shard
          </button>
          <button type="button" disabled={story.screenshotIndex === null} onclick={() => openScreenshot(story.screenshotIndex)}>
            Screenshot
          </button>
        </div>
        <div class="story-meta">
          <span>{story.shard ? story.shard.handle : 'video missing'}</span>
          <span>{story.screenshot ? story.screenshot.title : 'screen missing'}</span>
        </div>
      </article>
    {/each}
  </div>
</section>

<section class="evidence-board" data-testid="qa-storage-watchers">
  <div class="board-head">
    <div>
      <div class="eyebrow">Storage / Watchers</div>
      <h2>Who stores what</h2>
      <p>Runtime owners, DB paths, tracked artifact directories, direct hub links, and credit-line evidence.</p>
    </div>
    <div class="board-counts">
      {#if loadingHealth}
        <span>loading</span>
      {:else if health}
        <span class:ok={health.systemOk === true} class:warn={health.systemOk === false}>system {health.systemOk === true ? 'ok' : 'check'}</span>
        <span>disk {health.disk.freeGiB === null ? 'n/a' : `${health.disk.freeGiB.toFixed(1)} GiB`}</span>
      {:else}
        <span class="warn">unavailable</span>
      {/if}
    </div>
  </div>

  {#if healthError}
    <div class="watch-error" data-testid="qa-storage-watchers-error">{healthError}</div>
  {/if}

  {#if health}
    <div class="watch-summary">
      <article>
        <span>direct links</span>
        <strong>{health.directLinkCount}</strong>
      </article>
      <article>
        <span>tracked paths</span>
        <strong>{health.tracked.length}</strong>
      </article>
      <article>
        <span>credit pairs</span>
        <strong>{health.creditPairs.length}</strong>
      </article>
      <article>
        <span>disk used</span>
        <strong>{health.disk.usedPct === null ? 'n/a' : `${health.disk.usedPct.toFixed(1)}%`}</strong>
      </article>
    </div>

    {#if visibleCreditPairs.length > 0}
      <div class="credit-strip" data-testid="qa-credit-line-evidence">
        {#each visibleCreditPairs as pair}
          <span class:ok={pair.ok} class:warn={!pair.ok}>
            {shortHealthId(pair.left)} → {shortHealthId(pair.right)} · {pair.expectedCreditAmount}
          </span>
        {/each}
      </div>
    {/if}

    <div class="watch-grid">
      <div class="watch-list" data-testid="qa-storage-owners">
        <h3>Owners</h3>
        {#if visibleOwners.length > 0}
          {#each visibleOwners as owner}
            <div class="watch-row">
              <span class={owner.status}>{owner.status}</span>
              <strong>{owner.name}</strong>
              <code>{owner.dbPath ?? owner.detail ?? 'no db path'}</code>
              <small>{owner.role} · {shortHealthId(owner.runtimeId)}</small>
            </div>
          {/each}
        {:else}
          <div class="watch-empty">No owners reported</div>
        {/if}
      </div>
      <div class="watch-list" data-testid="qa-storage-tracks">
        <h3>Tracked Storage</h3>
        {#if visibleTracks.length > 0}
          {#each visibleTracks as track}
            <div class="watch-row">
              <span>{track.kind}</span>
              <strong>{track.name}</strong>
              <code>{track.path}</code>
              <small>{formatQaBytes(track.currentBytes)} · {formatQaBytes(track.bytesPerHour)}/h · {track.scanMode}{track.scanTruncated ? ' truncated' : ''}</small>
            </div>
          {/each}
        {:else}
          <div class="watch-empty">No tracked storage paths</div>
        {/if}
      </div>
    </div>
  {:else if !healthError}
    <div class="watch-empty">Health snapshot has not loaded yet</div>
  {/if}
</section>

<style>
  .evidence-board {
    display: grid;
    gap: 1rem;
    padding: 1rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.03);
  }

  .board-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 1rem;
  }

  .board-head h2,
  .board-head p,
  .story-copy h3,
  .story-copy p,
  .watch-list h3 {
    margin: 0;
  }

  .board-head p,
  .story-copy p,
  .story-meta,
  .watch-row small,
  .watch-empty {
    color: #9b978a;
    line-height: 1.4;
  }

  .eyebrow,
  .story-copy span,
  .watch-summary span,
  .watch-row > span {
    color: #d8af4f;
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .board-counts,
  .story-actions,
  .story-meta,
  .credit-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .board-counts span,
  .story-meta span,
  .credit-strip span {
    border: 1px solid rgba(112, 165, 255, 0.24);
    border-radius: 999px;
    padding: 0.34rem 0.5rem;
    color: #b9d2ff;
    background: rgba(112, 165, 255, 0.08);
    font-size: 0.74rem;
  }

  .board-counts span.ok,
  .credit-strip span.ok {
    border-color: rgba(132, 224, 161, 0.25);
    color: #84e0a1;
    background: rgba(132, 224, 161, 0.08);
  }

  .board-counts span.warn,
  .credit-strip span.warn {
    border-color: rgba(255, 146, 132, 0.3);
    color: #ffb1a6;
    background: rgba(255, 146, 132, 0.08);
  }

  .story-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.85rem;
  }

  .story-card {
    display: grid;
    grid-template-rows: auto 150px auto auto;
    gap: 0.75rem;
    min-width: 0;
    padding: 0.8rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.18);
  }

  .story-copy {
    display: grid;
    gap: 0.32rem;
    min-width: 0;
  }

  .story-copy h3 {
    color: #f1efe7;
    font-size: 1.05rem;
  }

  .story-copy p {
    min-height: 3.8em;
    font-size: 0.82rem;
  }

  .story-media {
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 7px;
    background: #070809;
  }

  .story-media :global(video),
  .story-screenshot-button :global(img) {
    width: 100%;
    height: 150px;
    object-fit: cover;
    object-position: top center;
    display: block;
    background: #070809;
  }

  .story-screenshot-button {
    position: relative;
    width: 100%;
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;
    cursor: pointer;
  }

  .story-screenshot-button span {
    position: absolute;
    left: 0.45rem;
    bottom: 0.45rem;
    border-radius: 999px;
    padding: 0.28rem 0.45rem;
    color: #f1efe7;
    background: rgba(0, 0, 0, 0.72);
    font-size: 0.72rem;
  }

  .story-missing,
  .watch-empty,
  .watch-error {
    display: grid;
    place-items: center;
    min-height: 92px;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    color: #8f8b80;
  }

  .watch-error {
    justify-items: start;
    min-height: auto;
    padding: 0.8rem;
    color: #ffb1a6;
    border-color: rgba(255, 146, 132, 0.3);
    background: rgba(255, 146, 132, 0.06);
  }

  .story-actions button {
    min-height: 32px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    padding: 0 0.65rem;
    color: #f1efe7;
    background: rgba(255, 255, 255, 0.04);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }

  .story-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .watch-summary,
  .watch-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .watch-summary article,
  .watch-list {
    display: grid;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.16);
  }

  .watch-summary strong {
    color: #f1efe7;
    font-size: 1.1rem;
  }

  .watch-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .watch-row {
    display: grid;
    grid-template-columns: 72px minmax(100px, 0.45fr) minmax(0, 1fr);
    gap: 0.55rem;
    align-items: center;
    min-width: 0;
    padding-bottom: 0.55rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .watch-row > span.online {
    color: #84e0a1;
  }

  .watch-row > span.offline {
    color: #ffb1a6;
  }

  .watch-row strong,
  .watch-row code,
  .watch-row small {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .watch-row code {
    color: #b9d2ff;
    font-size: 0.76rem;
  }

  .watch-row small {
    grid-column: 2 / -1;
    font-size: 0.74rem;
  }

  @media (max-width: 1400px) {
    .story-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 900px) {
    .board-head,
    .watch-row {
      display: grid;
    }

    .story-grid,
    .watch-summary,
    .watch-grid {
      grid-template-columns: 1fr;
    }

    .watch-row {
      grid-template-columns: 1fr;
      align-items: start;
    }

    .watch-row small {
      grid-column: auto;
    }
  }
</style>
