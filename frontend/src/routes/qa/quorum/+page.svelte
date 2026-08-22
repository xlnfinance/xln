<script lang="ts">
  import './quorum.css';
  import { summarizeModels } from '$lib/qa/quorum/derive';
  import type { QuorumCategory, QuorumInteraction } from '$lib/qa/quorum/types';

  export let data: { interactions: QuorumInteraction[] };

  type Range = '7d' | '30d' | 'all';
  type CategoryFilter = QuorumCategory | 'all';

  let range: Range = 'all';
  let category: CategoryFilter = 'all';
  let selectedId = 'fable-wire-fit-20260822';

  const colors = ['#ffbf3f', '#52d7ff', '#a78bfa', '#4ade80', '#fb7185', '#f97316', '#e879f9', '#94a3b8'];
  const colorFor = (model: string): string => {
    let hash = 0;
    for (const char of model) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return colors[hash % colors.length]!;
  };
  const shortSha = (sha: string): string => sha.slice(0, 10);
  const formatDate = (value: string): string => new Intl.DateTimeFormat('en', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }).format(new Date(value));
  const verdictLabel = (value: string): string => ({
    verified: 'Verified', partial: 'Partial', noise: 'Noise', blocked: 'Blocked',
  }[value] ?? value);

  $: newestAt = Math.max(...data.interactions.map(entry => Date.parse(entry.occurredAt)));
  $: cutoff = range === 'all' ? 0 : newestAt - (range === '7d' ? 7 : 30) * 86_400_000;
  $: interactions = data.interactions
    .filter(entry => Date.parse(entry.occurredAt) >= cutoff)
    .filter(entry => category === 'all' || entry.category === category)
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  $: summaries = summarizeModels(interactions);
  $: selected = interactions.find(entry => entry.id === selectedId) ?? interactions.at(-1) ?? null;
  $: verified = interactions.filter(entry => entry.verdict === 'verified').length;
  $: average = interactions.length
    ? Math.round(interactions.reduce((sum, entry) => sum + entry.score, 0) / interactions.length)
    : 0;
  $: totalImpact = interactions.reduce((sum, entry) => sum + (entry.verifiedImpact ?? 0), 0);
  $: minTime = Math.min(...interactions.map(entry => Date.parse(entry.occurredAt)));
  $: maxTime = Math.max(...interactions.map(entry => Date.parse(entry.occurredAt)));
  $: timeSpan = Math.max(1, maxTime - minTime);
  $: chartX = (entry: QuorumInteraction) => 72 + 886 * (Date.parse(entry.occurredAt) - minTime) / timeSpan;
  $: chartY = (entry: QuorumInteraction) => 370 - entry.score * 0.32;
  $: modelGroups = summaries.map(summary => ({
    ...summary,
    entries: interactions.filter(entry => entry.model === summary.model),
  }));
  $: reviewChains = interactions
    .filter(entry => entry.challengedInteractionId)
    .map(entry => ({
      challenger: entry,
      challenged: interactions.find(candidate => candidate.id === entry.challengedInteractionId),
    }))
    .filter((chain): chain is { challenger: QuorumInteraction; challenged: QuorumInteraction } => Boolean(chain.challenged));
  $: recentInteractions = [...interactions].reverse().slice(0, 8);
</script>

<svelte:head>
  <title>Quorum intelligence · xln QA</title>
  <meta name="description" content="Verified performance of xln's external model quorum over time." />
</svelte:head>

<main class="quorum-shell" data-testid="quorum-dashboard">
  <header class="hero">
    <div>
      <a class="back" href="/qa/hlt">← QA / HLT</a>
      <p class="eyebrow">QA · QUORUM INTELLIGENCE</p>
      <h1>Who actually finds the bottleneck?</h1>
      <p class="lede">Every point is scored by the primary auditor after code, test, or live-profile verification. Self-reported confidence is ignored.</p>
    </div>
    <div class="controls" aria-label="Quorum filters">
      <label>Window
        <select bind:value={range}>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
          <option value="all">All time</option>
        </select>
      </label>
      <label>Work
        <select bind:value={category}>
          <option value="all">All categories</option>
          <option value="performance">Performance</option>
          <option value="security">Security</option>
          <option value="protocol">Protocol</option>
          <option value="reliability">Reliability</option>
        </select>
      </label>
    </div>
  </header>

  <section class="metrics" aria-label="Quorum summary">
    <article><span>Audited answers</span><strong>{interactions.length}</strong><small>{summaries.length} models</small></article>
    <article><span>Verified</span><strong>{verified}</strong><small>{interactions.length ? Math.round(100 * verified / interactions.length) : 0}% hit rate</small></article>
    <article><span>Average score</span><strong>{average}</strong><small>of 1000</small></article>
    <article><span>Verified impact</span><strong>{totalImpact}</strong><small>weighted evidence points</small></article>
  </section>

  <section class="chart-card">
    <div class="section-head">
      <div><p class="eyebrow">AUDITOR SCORE OVER TIME</p><h2>Evidence beats eloquence</h2></div>
      <div class="legend">
        {#each modelGroups as group}
          <span><i style={`--model-color:${colorFor(group.model)}`}></i>{group.model}</span>
        {/each}
      </div>
    </div>
    {#if interactions.length > 0}
      <svg class="score-chart" viewBox="0 0 1000 420" role="img" aria-label="Model response score over time">
        <defs>
          <linearGradient id="plotGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#f4c453" stop-opacity="0.12" />
            <stop offset="1" stop-color="#f4c453" stop-opacity="0" />
          </linearGradient>
        </defs>
        <rect x="72" y="50" width="886" height="320" rx="12" fill="url(#plotGlow)" />
        {#each [0, 250, 500, 750, 1000] as tick}
          <line x1="72" x2="958" y1={370 - tick * 0.32} y2={370 - tick * 0.32} class="grid-line" />
          <text x="58" y={375 - tick * 0.32} text-anchor="end" class="axis-label">{tick}</text>
        {/each}
        {#each modelGroups as group}
          {#if group.entries.length > 1}
            <polyline
              points={group.entries.map(entry => `${chartX(entry)},${chartY(entry)}`).join(' ')}
              fill="none" stroke={colorFor(group.model)} stroke-opacity="0.42" stroke-width="2"
            />
          {/if}
          {#each group.entries as entry}
            <g class:selected-point={entry.id === selected?.id} role="button" tabindex="0"
              onclick={() => selectedId = entry.id}
              onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') selectedId = entry.id; }}>
              <circle cx={chartX(entry)} cy={chartY(entry)}
                r={5 + Math.min(9, Math.sqrt(entry.verifiedImpact ?? 0))}
                fill={colorFor(entry.model)} class={`point ${entry.verdict}`} />
              <title>{entry.model} · {entry.score}/1000 · {entry.scope}</title>
            </g>
          {/each}
        {/each}
        <text x="72" y="405" class="axis-label">{formatDate(new Date(minTime).toISOString())}</text>
        <text x="958" y="405" text-anchor="end" class="axis-label">{formatDate(new Date(maxTime).toISOString())}</text>
      </svg>
      <div class="mobile-timeline" aria-label="Recent model scores over time">
        {#each recentInteractions as entry}
          <button onclick={() => selectedId = entry.id}>
            <span><i style={`--model-color:${colorFor(entry.model)}`}></i><b>{entry.model}</b><small>{formatDate(entry.occurredAt)}</small></span>
            <strong>{entry.score}</strong>
          </button>
        {/each}
      </div>
    {:else}
      <div class="empty">No verified interactions match this filter.</div>
    {/if}
  </section>

  <section class="split">
    <article class="detail-card" data-testid="quorum-selected-interaction">
      <div class="section-head compact"><div><p class="eyebrow">SELECTED INTERACTION</p><h2>{selected?.model ?? '—'}</h2></div>
        {#if selected}<span class={`verdict ${selected.verdict}`}>{verdictLabel(selected.verdict)}</span>{/if}
      </div>
      {#if selected}
        <div class="score-lockup"><strong>{selected.score}</strong><span>/1000<br />auditor score</span></div>
        <h3>{selected.scope}</h3>
        <p class="summary">{selected.summary}</p>
        <div class="evidence"><span>Decisive evidence</span><p>{selected.evidence}</p></div>
        <dl>
          <div><dt>Observed</dt><dd>{formatDate(selected.occurredAt)} UTC</dd></div>
          <div><dt>Source</dt><dd>{shortSha(selected.sourceSha)}</dd></div>
          <div><dt>Session</dt><dd>{selected.sessionId ?? 'not recorded'}</dd></div>
          <div><dt>Response</dt><dd>{selected.responseMinutes === undefined ? 'not recorded' : `${selected.responseMinutes} min`}</dd></div>
          <div><dt>Impact</dt><dd>{selected.verifiedImpact ?? 0}</dd></div>
          <div><dt>Missed before discovery</dt><dd>{selected.missedHours === undefined ? '—' : `${selected.missedHours} h`}</dd></div>
        </dl>
      {/if}
    </article>

    <article class="leader-card">
      <div class="section-head compact"><div><p class="eyebrow">MODEL LEADERBOARD</p><h2>Verified usefulness</h2></div></div>
      <div class="leader-table">
        <div class="leader-row header"><span>Model</span><span>Score</span><span>Verified</span><span>Impact</span><span>Median</span></div>
        {#each summaries as item, index}
          <button class="leader-row" onclick={() => {
            const latest = [...interactions].reverse().find(entry => entry.model === item.model);
            if (latest) selectedId = latest.id;
          }}>
            <span><b>{index + 1}</b><i style={`--model-color:${colorFor(item.model)}`}></i>{item.model}<small>{item.interactions} answers</small></span>
            <strong>{item.averageScore}</strong><span>{item.verifiedRate}%</span><span>{item.verifiedImpact}</span>
            <span>{item.medianResponseMinutes === null ? '—' : `${item.medianResponseMinutes}m`}</span>
          </button>
        {/each}
      </div>
    </article>
  </section>

  <section class="chain-card">
    <div class="section-head compact">
      <div><p class="eyebrow">REVIEW CHAINS</p><h2>Who challenged what</h2></div>
      <p class="chain-note">Only explicit follow-up audits are connected. Missing links are shown as missing data, never inferred.</p>
    </div>
    {#if reviewChains.length > 0}
      <div class="chains">
        {#each reviewChains as chain}
          <button class="chain" onclick={() => selectedId = chain.challenger.id}>
            <span class="chain-node">
              <i style={`--model-color:${colorFor(chain.challenged.model)}`}></i>
              <b>{chain.challenged.model}</b>
              <small>{chain.challenged.score}/1000 · {chain.challenged.scope}</small>
            </span>
            <span class="chain-arrow">challenged by →</span>
            <span class="chain-node">
              <i style={`--model-color:${colorFor(chain.challenger.model)}`}></i>
              <b>{chain.challenger.model}</b>
              <small>{chain.challenger.score}/1000 · {chain.challenger.scope}</small>
            </span>
          </button>
        {/each}
      </div>
    {:else}
      <div class="empty compact-empty">No explicit review chains match this filter.</div>
    {/if}
  </section>

  <section class="method-card">
    <div><p class="eyebrow">SCORING CONTRACT</p><h2>How the 1000 points are earned</h2></div>
    <div class="weights">
      <article><strong>400</strong><span>Claim accuracy</span><p>Every material statement survives direct code inspection.</p></article>
      <article><strong>250</strong><span>Real impact</span><p>Live TPS, reproduced bug, or deleted complexity—not a theoretical percentage.</p></article>
      <article><strong>150</strong><span>Evidence</span><p>Exact path, input, frame, profile, test, SHA and session.</p></article>
      <article><strong>100</strong><span>Speed</span><p>Time from question to actionable verified answer.</p></article>
      <article><strong>100</strong><span>Low noise</span><p>Few false positives, duplicate ideas or protocol misunderstandings.</p></article>
    </div>
  </section>
</main>
