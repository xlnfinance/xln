<script lang="ts">
  import { getReviewText, REVIEW_MODELS, REVIEW_PROMPTS } from '$lib/reviews/reviews-model';

  let selectedPrompt = 0;
</script>

<div class="reviews-page">
  <div class="header">
    <h1>AI Reviews of xln</h1>
    <p class="subtitle">What happens when you feed 112k tokens of architecture to frontier models?</p>
  </div>

  <!-- Prompt Selector (Slideshow) -->
  <div class="prompt-selector">
    {#each REVIEW_PROMPTS as prompt, i}
      <button
        class="prompt-pill"
        class:active={selectedPrompt === i}
        on:click={() => selectedPrompt = i}
      >
        P{i + 1}: {prompt.title}
      </button>
    {/each}
  </div>

  <!-- Reviews Grid -->
  <div class="reviews-grid">
    {#each REVIEW_MODELS as model}
      <div class="model-column">
        <div class="model-header">{model.label}</div>
        <div class="review-card">
          <div class="review-text">{getReviewText(model, selectedPrompt)}</div>
        </div>
      </div>
    {/each}
  </div>

  <div class="disclaimer">
    These are real responses from GPT-4, Claude Opus, Sonnet 4, Gemini 2.0.
    Prompts available at <a href="/">xln.finance</a> → 10 Expert Perspectives.
  </div>
</div>

<style>
  .reviews-page {
    min-height: 100vh;
    background: #000;
    color: #fff;
    padding: 4rem 2rem;
  }

  .header {
    text-align: center;
    margin-bottom: 4rem;
  }

  .header h1 {
    font-size: 3rem;
    font-weight: 700;
    color: #4fd18b;
    margin-bottom: 1rem;
  }

  .subtitle {
    font-size: 1.2rem;
    color: rgba(255,255,255,0.7);
  }

  .prompt-selector {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    justify-content: center;
    margin-bottom: 3rem;
  }

  .prompt-pill {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.15);
    color: rgba(255,255,255,0.75);
    padding: 0.75rem 1.5rem;
    border-radius: 24px;
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.3s ease;
  }

  .prompt-pill.active {
    background: rgba(79,209,139,0.15);
    border-color: rgba(79,209,139,0.5);
    color: #4fd18b;
    font-weight: 600;
  }

  .prompt-pill:hover {
    background: rgba(255,255,255,0.08);
    border-color: rgba(255,255,255,0.25);
  }

  .reviews-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2rem;
    max-width: 1600px;
    margin: 0 auto;
  }

  .model-column {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .model-header {
    font-size: 1.3rem;
    font-weight: 700;
    color: #00d1ff;
    text-align: center;
    font-family: 'JetBrains Mono', monospace;
  }

  .review-card {
    background: linear-gradient(135deg, rgba(79,209,139,0.08), rgba(0,209,255,0.05));
    border: 1px solid rgba(79,209,139,0.2);
    border-radius: 12px;
    padding: 2rem;
    min-height: 200px;
  }

  .review-text {
    font-size: 1.05rem;
    line-height: 1.7;
    color: rgba(255,255,255,0.88);
    font-style: italic;
  }

  .disclaimer {
    text-align: center;
    margin-top: 4rem;
    font-size: 0.9rem;
    color: rgba(255,255,255,0.5);
  }

  .disclaimer a {
    color: #4fd18b;
    text-decoration: none;
    border-bottom: 1px solid rgba(79,209,139,0.3);
  }
</style>
