<script lang="ts">
  import { onMount } from 'svelte';

  export let darkMode = true;

  interface RankingRow {
    solution: string;
    innovation: number;
    scalability: number;
    security: number;
    decentralization: number;
    ux: number;
    capitalEfficiency: number;
    total: number;
  }

  interface ComparisonResult {
    model: string;
    date: string;
    evaluator?: string;
    shareableLink?: string;
    rankings: RankingRow[];
    insights: string[];
  }

  let results: ComparisonResult[] = [];
  let loading = true;
  let selectedCategory: keyof RankingRow = 'total';

  const categories: Array<{key: keyof RankingRow, label: string}> = [
    { key: 'total', label: 'Overall' },
    { key: 'innovation', label: 'Innovation' },
    { key: 'scalability', label: 'Scalability' },
    { key: 'security', label: 'Security' },
    { key: 'decentralization', label: 'Decentralization' },
    { key: 'ux', label: 'UX' },
    { key: 'capitalEfficiency', label: 'Capital Efficiency' },
  ];

  onMount(async () => {
    try {
      const response = await fetch('/comparative-results.json');
      const data = await response.json();
      results = data.results || [];
    } catch (error) {
      console.error('Failed to load results:', error);
    } finally {
      loading = false;
    }
  });

  // Aggregate scores across all models
  $: aggregatedScores = (() => {
    if (results.length === 0) return [];

    const solutionMap = new Map<string, { scores: number[], solution: string }>();

    results.forEach(result => {
      result.rankings.forEach(row => {
        const score = row[selectedCategory] as number;
        if (!solutionMap.has(row.solution)) {
          solutionMap.set(row.solution, { scores: [], solution: row.solution });
        }
        solutionMap.get(row.solution)!.scores.push(score);
      });
    });

    const aggregated = Array.from(solutionMap.values()).map(({ solution, scores }) => {
      const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
      const variance = scores.length > 1
        ? Math.sqrt(scores.reduce((sum, s) => sum + Math.pow(s - avg, 2), 0) / scores.length)
        : 0;

      return {
        solution,
        avg: Math.round(avg),
        variance: Math.round(variance),
        models: scores.length
      };
    });

    return aggregated.sort((a, b) => b.avg - a.avg);
  })();

  $: maxScore = Math.max(...aggregatedScores.map(s => s.avg), 1);

  function solutionColor(solution: string): string {
    if (solution.toLowerCase() === 'xln') {
      return '#4fd18b';
    }
    return darkMode ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.4)';
  }
</script>

{#if loading}
  <div class="loading">Loading evaluation results...</div>
{:else if results.length === 0}
  <div class="empty">
    <p>No evaluations yet. Be the first to submit!</p>
    <p class="hint">Copy the superprompt above and run it in GPT-4, Claude, or Gemini</p>
  </div>
{:else}
  <div class="chart-container">
    <div class="chart-header">
      <h3>Crowdsourced AI Evaluations</h3>
      <p class="chart-meta">{results.length} evaluations from {new Set(results.map(r => r.model)).size} different models</p>
    </div>

    <div class="category-selector">
      {#each categories as cat}
        <button
          class="category-btn"
          class:active={selectedCategory === cat.key}
          on:click={() => selectedCategory = cat.key}
        >
          {cat.label}
        </button>
      {/each}
    </div>

    <div class="rankings">
      {#each aggregatedScores as score, i}
        <div class="ranking-row">
          <div class="rank-label">
            <span class="rank-number">#{i + 1}</span>
            <span class="solution-name" style="color: {solutionColor(score.solution)}">{score.solution}</span>
          </div>
          <div class="bar-container">
            <div
              class="bar"
              style="
                width: {(score.avg / maxScore) * 100}%;
                background: {solutionColor(score.solution)};
              "
            />
            <span class="bar-score">{score.avg}</span>
            {#if score.variance > 0}
              <span class="bar-variance">±{score.variance}</span>
            {/if}
          </div>
          <span class="model-count">{score.models} model{score.models > 1 ? 's' : ''}</span>
        </div>
      {/each}
    </div>

    <div class="model-list">
      <h4>Individual Evaluations:</h4>
      <div class="model-cards">
        {#each results as result}
          <div class="model-card">
            <div class="model-header">
              <strong>{result.model}</strong>
              <span class="model-date">{result.date}</span>
            </div>
            {#if result.shareableLink}
              <a href={result.shareableLink} target="_blank" rel="noopener noreferrer" class="share-link">
                View conversation →
              </a>
            {/if}
            {#if result.insights && result.insights.length > 0}
              <div class="insights">
                {#each result.insights as insight}
                  <p>• {insight}</p>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .loading, .empty {
    text-align: center;
    padding: 2rem;
    color: rgba(255, 255, 255, 0.5);
    font-family: 'JetBrains Mono', monospace;
  }

  .empty .hint {
    font-size: 0.85rem;
    margin-top: 0.5rem;
  }

  .chart-container {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 2rem;
    margin-top: 2rem;
  }

  .chart-header h3 {
    font-size: 1.3rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
    color: rgba(255, 255, 255, 0.95);
  }

  .chart-meta {
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.5);
    margin: 0;
  }

  .category-selector {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .category-btn {
    padding: 0.5rem 1rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.6);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .category-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.3);
  }

  .category-btn.active {
    background: rgba(77, 209, 139, 0.15);
    border-color: #4fd18b;
    color: #4fd18b;
  }

  .rankings {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .ranking-row {
    display: grid;
    grid-template-columns: 200px 1fr 80px;
    gap: 1rem;
    align-items: center;
    padding: 0.75rem;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 6px;
    transition: all 0.2s;
  }

  .ranking-row:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .rank-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .rank-number {
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.4);
    min-width: 2ch;
  }

  .solution-name {
    font-weight: 500;
    font-size: 0.95rem;
  }

  .bar-container {
    position: relative;
    height: 28px;
    display: flex;
    align-items: center;
  }

  .bar {
    height: 100%;
    border-radius: 4px;
    transition: width 0.5s ease;
    min-width: 40px;
  }

  .bar-score {
    position: absolute;
    left: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    color: #000;
    z-index: 1;
  }

  .bar-variance {
    margin-left: 8px;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.5);
  }

  .model-count {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.4);
    text-align: right;
  }

  .model-list {
    margin-top: 1rem;
  }

  .model-list h4 {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0 0 1rem;
    color: rgba(255, 255, 255, 0.9);
  }

  .model-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
  }

  .model-card {
    padding: 1rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .model-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .model-header strong {
    color: rgba(255, 255, 255, 0.95);
  }

  .model-date {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.4);
  }

  .share-link {
    font-size: 0.85rem;
    color: #4fd18b;
    text-decoration: none;
    transition: color 0.2s;
  }

  .share-link:hover {
    color: #5fe19b;
  }

  .insights {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .insights p {
    font-size: 0.85rem;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.7);
    margin: 0;
  }

  @media (max-width: 768px) {
    .ranking-row {
      grid-template-columns: 1fr;
      gap: 0.5rem;
    }

    .model-cards {
      grid-template-columns: 1fr;
    }
  }

  /* Light mode overrides */
  :global(.light-mode) .loading,
  :global(.light-mode) .empty {
    color: rgba(0, 0, 0, 0.5);
  }

  :global(.light-mode) .chart-header h3 {
    color: rgba(0, 0, 0, 0.95);
  }

  :global(.light-mode) .chart-meta {
    color: rgba(0, 0, 0, 0.5);
  }

  :global(.light-mode) .category-btn {
    background: rgba(0, 0, 0, 0.05);
    border-color: rgba(0, 0, 0, 0.15);
    color: rgba(0, 0, 0, 0.6);
  }

  :global(.light-mode) .category-btn:hover {
    background: rgba(0, 0, 0, 0.08);
    border-color: rgba(0, 0, 0, 0.3);
  }

  :global(.light-mode) .category-btn.active {
    background: rgba(77, 209, 139, 0.15);
    border-color: #4fd18b;
    color: #2a8a5f;
  }

  :global(.light-mode) .ranking-row {
    background: rgba(0, 0, 0, 0.02);
  }

  :global(.light-mode) .ranking-row:hover {
    background: rgba(0, 0, 0, 0.04);
  }

  :global(.light-mode) .rank-number {
    color: rgba(0, 0, 0, 0.4);
  }

  :global(.light-mode) .bar-variance {
    color: rgba(0, 0, 0, 0.5);
  }

  :global(.light-mode) .model-count {
    color: rgba(0, 0, 0, 0.4);
  }

  :global(.light-mode) .model-list h4 {
    color: rgba(0, 0, 0, 0.9);
  }

  :global(.light-mode) .model-card {
    background: rgba(0, 0, 0, 0.03);
    border-color: rgba(0, 0, 0, 0.1);
  }

  :global(.light-mode) .model-header strong {
    color: rgba(0, 0, 0, 0.95);
  }

  :global(.light-mode) .model-date {
    color: rgba(0, 0, 0, 0.4);
  }

  :global(.light-mode) .insights p {
    color: rgba(0, 0, 0, 0.7);
  }
</style>
