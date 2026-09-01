import { useMemo, useState } from 'react';

import { buildAdminStoryCards, formatQaBytes } from '../../../packages/runtime-client/src/qa-admin-evidence';
import type { QaStoryScreenshot, QaUxReleasePackAudit } from '../../../packages/runtime-client/src/qa-types';
import type { OpsQaSourceSnapshot } from './ops-qa-source';
import { OpsQaProtectedImage, OpsQaProtectedVideo } from './ops-qa-media';

export function OpsQaEvidenceBoard({ source, onOpenShard, onOpenStory }: Readonly<{
  source: OpsQaSourceSnapshot;
  onOpenShard: (index: number) => void;
  onOpenStory: (index: number) => void;
}>) {
  const stories = useMemo(() => buildAdminStoryCards(source.selectedRun, [...source.stories]), [source.selectedRun, source.stories]);
  return <>
    <section className="ops-qa-evidence-board" data-testid="qa-admin-evidence-board">
      <header><div><span>PRE-MAINNET USER STORIES</span><h2>4 flows to inspect first</h2></div><p>Payment, swap, cross-chain route, and dispute evidence.</p></header>
      <div>{stories.map(story => <article data-story-key={story.key} data-testid="qa-admin-story-card" key={story.key}>
        <span>{story.short}</span><h3>{story.title}</h3><p>{story.full}</p>
        <div className="ops-qa-story-media">
          {story.video?.url ? <OpsQaProtectedVideo controls data-testid="qa-story-video" preload="metadata" sourceUrl={story.video.url} />
            : story.screenshot?.url ? <OpsQaProtectedImage alt={story.title} loading="lazy" sourceUrl={story.screenshot.url} />
              : <span className="ops-qa-media-empty">No evidence yet</span>}
        </div>
        <div className="ops-qa-story-actions">
          <button disabled={story.shardIndex === null} onClick={() => { if (story.shardIndex !== null) onOpenShard(story.shardIndex); }} type="button">Open shard</button>
          <button disabled={story.screenshotIndex === null} onClick={() => { if (story.screenshotIndex !== null) onOpenStory(story.screenshotIndex); }} type="button">Screenshot</button>
          <code>{story.shard?.handle ?? 'video missing'}</code>
        </div>
      </article>)}</div>
    </section>
    <OpsQaStorageEvidence source={source} />
  </>;
}

function OpsQaStorageEvidence({ source }: Readonly<{ source: OpsQaSourceSnapshot }>) {
  const health = source.adminHealth;
  return <section className="ops-qa-storage" data-testid="qa-storage-watchers">
    <header><div><span>LIVE ADMIN HEALTH</span><h2>Who stores what</h2></div><p>{source.adminHealthError || 'Health evidence is read directly from the orchestrator.'}</p></header>
    {health ? <>
      <div className="ops-qa-health-metrics">
        <span>system <b>{health.systemOk === true ? 'ready' : health.systemOk === false ? 'failed' : 'unknown'}</b></span>
        <span>relay clients <b>{health.relayActiveClientCount}</b></span><span>profiles <b>{health.relayProfileCount}</b></span>
        <span>disk <b>{health.disk.freeGiB === null ? 'n/a' : `${health.disk.freeGiB.toFixed(1)} GiB`}</b></span>
      </div>
      <div className="ops-qa-storage-grid">
        <div>{health.owners.slice(0, 8).map(owner => <article data-status={owner.status} key={`${owner.role}:${owner.name}`}>
          <strong>{owner.name}</strong><span>{owner.role} · {owner.status}</span><code>{owner.dbPath ?? owner.runtimeId ?? owner.detail ?? 'n/a'}</code>
        </article>)}</div>
        <div>{health.tracked.slice(0, 8).map(track => <article key={`${track.kind}:${track.path}`}>
          <strong>{track.name}</strong><span>{track.kind} · {formatQaBytes(track.currentBytes)}</span><code>{track.path}</code>
        </article>)}</div>
      </div>
      {health.creditPairs.length > 0 ? <div className="ops-qa-credit-lines" data-testid="qa-credit-line-evidence">{health.creditPairs.map(pair => <span data-status={pair.ok ? 'ok' : 'fail'} key={`${pair.left}:${pair.right}`}>{pair.left} ↔ {pair.right} · {pair.expectedCreditAmount}</span>)}</div> : null}
    </> : <p className="ops-qa-empty">Admin health evidence unavailable.</p>}
  </section>;
}

export function OpsQaGallery({ stories, releasePack, selectedStoryIndex, onSelectStory }: Readonly<{
  stories: readonly QaStoryScreenshot[];
  releasePack: QaUxReleasePackAudit | null;
  selectedStoryIndex: number | null;
  onSelectStory: (index: number | null) => void;
}>) {
  const [filter, setFilter] = useState('all');
  const groups = useMemo(() => Array.from(new Set(stories.map(story => story.group))), [stories]);
  const visible = filter === 'all' ? stories : stories.filter(story => story.group === filter);
  const story = selectedStoryIndex === null ? null : stories[selectedStoryIndex] ?? null;
  const selectRelative = (delta: number): void => {
    if (stories.length === 0) return;
    onSelectStory(((selectedStoryIndex ?? 0) + delta + stories.length) % stories.length);
  };
  return <section className="ops-qa-gallery" data-testid="qa-ux-gallery">
    <header><div><span>APPLICATION SCREENS</span><h2>UX Gallery</h2><p>{stories.length} screenshots from e2e runs and curated fixtures.</p></div>
      <div className="ops-qa-gallery-count" data-testid="qa-ux-gallery-count"><span>{stories.filter(item => item.curated).length || stories.length} curated</span><span>{releasePack?.desktopCount ?? 0} desktop</span><span>{releasePack?.mobileCount ?? 0} mobile</span></div>
    </header>
    {releasePack ? <div className="ops-qa-release-pack" data-testid="qa-ux-gallery-release-pack"><strong>{releasePack.status === 'ready' ? 'release ready' : 'release incomplete'}</strong><span>{releasePack.curatedCount}/{releasePack.minScreens}</span><span>{releasePack.presentGroups.length}/{releasePack.requiredGroups.length} groups</span></div> : null}
    <div className="ops-qa-filters" data-testid="qa-ux-gallery-filter"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')} type="button">all</button>{groups.map(group => <button aria-pressed={filter === group} key={group} onClick={() => setFilter(group)} type="button">{group}</button>)}</div>
    <div className="ops-qa-gallery-grid">{visible.map(item => {
      const index = stories.indexOf(item);
      return <button data-platform={item.platform ?? 'unknown'} data-testid="qa-ux-gallery-card" key={item.id} onClick={() => onSelectStory(index)} type="button">
        <div><OpsQaProtectedImage alt={item.title} loading="lazy" sourceUrl={item.url} /></div>
        <span>{item.group}</span><strong>{item.title}</strong><small>{item.description ?? item.name}</small>
      </button>;
    })}</div>
    {visible.length === 0 ? <p className="ops-qa-empty">No screenshots match this group.</p> : null}
    {story ? <div className="ops-qa-slideshow" data-testid="qa-ux-slideshow" role="dialog" aria-label="UX screenshot slideshow" aria-modal="true">
      <section><header><div><span>{story.group}</span><h2>{story.title}</h2><p>{story.description ?? story.name}</p></div><button data-testid="qa-ux-slideshow-close" onClick={() => onSelectStory(null)} type="button">Close</button></header>
        <OpsQaProtectedImage alt={story.title} loading="eager" sourceUrl={story.url} />
        <footer><button data-testid="qa-ux-slideshow-prev" onClick={() => selectRelative(-1)} type="button">Prev</button><span>{(selectedStoryIndex ?? 0) + 1}/{stories.length}</span><button data-testid="qa-ux-slideshow-next" onClick={() => selectRelative(1)} type="button">Next</button></footer>
      </section>
    </div> : null}
  </section>;
}
