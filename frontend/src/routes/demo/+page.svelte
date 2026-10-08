<script lang="ts">
  /**
   * Presenter lobby: the story's chapters as cards. Each opens its shipped trail in
   * presentation mode; "Start the full story" opens the first chapter, and every chapter
   * offers the next one at its last step. Step counts are read from the shipped trails, so the
   * lobby can never advertise a different demo from the one that plays.
   */
  import { onMount } from 'svelte';
  import { DEMO_STORY, demoChapterHref } from '$lib/network3d/timeline/demoStory';
  import { fetchDemoNetworkTrail, type NetworkTrail } from '$lib/network3d/timeline/networkTimelineSource';
  import { compileNetworkMachine, DEFAULT_NETWORK_MACHINE_CONFIG, presentationNetworkMachine } from '$lib/network3d/networkMachine';

  /** Presentation playback advances one step per second at 1×. */
  const STEP_MS_AT_1X = 1_000;

  let stepCounts = $state<Record<string, number>>({});
  let loadErrors = $state<Record<string, string>>({});

  /** The steps a presentation of this trail plays: setup condensed, narrated beats included. */
  const presentationSteps = (trail: NetworkTrail): number =>
    presentationNetworkMachine(compileNetworkMachine([trail.index], { ...DEFAULT_NETWORK_MACHINE_CONFIG, cues: trail.cues ?? [] })).steps.length;

  const duration = (steps: number): string => {
    const seconds = Math.round((steps * STEP_MS_AT_1X) / 1_000);
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
  };

  onMount(() => {
    for (const chapter of DEMO_STORY) {
      void fetchDemoNetworkTrail(chapter.trail)
        .then((trail) => { stepCounts = { ...stepCounts, [chapter.trail]: presentationSteps(trail) }; })
        .catch((error: unknown) => {
          loadErrors = { ...loadErrors, [chapter.trail]: error instanceof Error ? error.message : String(error) };
        });
    }
  });
</script>

<svelte:head>
  <title>xln — demos</title>
</svelte:head>

<main class="lobby" data-testid="demo-lobby">
  <header>
    <div class="brand"><span class="logo">xln</span><span class="tag">Bilateral settlement, step by step</span></div>
    <h1>Five short demonstrations, recorded from the real protocol.</h1>
    <p class="intro">
      Every frame you will see was produced by the xln runtime settling on an EVM Depository contract on a local test chain,
      with a USDC test token as the settlement asset. Banks hold bilateral accounts backed by collateral, credit limits or both;
      payments stay in the accounts, and only collateral moves and net settlements reach the chain.
    </p>
    <a class="start" href={demoChapterHref(DEMO_STORY[0]!.trail)} data-sveltekit-reload data-testid="demo-start-story">
      Start the full story <span aria-hidden="true">→</span>
    </a>
  </header>

  <ol class="chapters">
    {#each DEMO_STORY as chapter, index}
      <li>
        <a class="card" href={demoChapterHref(chapter.trail)} data-sveltekit-reload data-testid="demo-card" data-trail={chapter.trail}>
          <span class="part">Part {index + 1}</span>
          <h2>{chapter.title}</h2>
          <p class="see">{chapter.see}</p>
          <span class="meta" data-testid="demo-card-meta">
            {#if loadErrors[chapter.trail]}
              <span class="error" role="alert">{loadErrors[chapter.trail]}</span>
            {:else if stepCounts[chapter.trail] !== undefined}
              {stepCounts[chapter.trail]} steps · {duration(stepCounts[chapter.trail]!)} at 1×
            {:else}
              Loading…
            {/if}
          </span>
          <span class="present">Present <span aria-hidden="true">→</span></span>
        </a>
      </li>
    {/each}
  </ol>

  <footer>
    <span><kbd>→</kbd> next step</span>
    <span><kbd>←</kbd> previous step</span>
    <span><kbd>Space</kbd> play / pause</span>
    <span>At the last step, <kbd>→</kbd> opens the next part</span>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #060a13;
  }

  .lobby {
    min-height: 100vh;
    box-sizing: border-box;
    padding: 64px clamp(20px, 6vw, 96px) 40px;
    display: flex;
    flex-direction: column;
    gap: 40px;
    background:
      radial-gradient(90% 60% at 0% 0%, rgba(56, 224, 184, 0.08), transparent 60%),
      radial-gradient(70% 50% at 100% 0%, rgba(167, 139, 250, 0.07), transparent 60%),
      #060a13;
    color: #e8eef6;
    font-family: Inter, 'Helvetica Neue', Arial, sans-serif;
  }

  header {
    display: flex;
    flex-direction: column;
    gap: 18px;
    max-width: 900px;
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 14px;
  }

  .logo {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #ffffff;
  }

  .tag {
    color: #8da2bb;
    font-size: 15px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(30px, 3.4vw, 46px);
    line-height: 1.12;
    font-weight: 750;
    letter-spacing: -0.02em;
    color: #ffffff;
  }

  .intro {
    margin: 0;
    max-width: 760px;
    color: #b9c7d8;
    font-size: 18px;
    line-height: 1.55;
  }

  .start {
    align-self: flex-start;
    margin-top: 6px;
    padding: 14px 22px;
    border-radius: 10px;
    background: #38e0b8;
    color: #04130f;
    font-size: 17px;
    font-weight: 700;
    text-decoration: none;
  }

  .start:hover {
    background: #5eeacb;
  }

  .chapters {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 18px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .card {
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 22px 22px 20px;
    border-radius: 14px;
    border: 1px solid rgba(148, 196, 255, 0.12);
    background: linear-gradient(180deg, rgba(18, 26, 42, 0.92), rgba(10, 16, 28, 0.92));
    color: inherit;
    text-decoration: none;
    transition: border-color 160ms ease, transform 160ms ease;
  }

  .card:hover {
    border-color: rgba(56, 224, 184, 0.5);
    transform: translateY(-2px);
  }

  .part {
    color: #38e0b8;
    font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: 22px;
    line-height: 1.25;
    font-weight: 700;
    color: #ffffff;
  }

  .see {
    margin: 0;
    flex: 1;
    color: #b3c2d4;
    font-size: 15.5px;
    line-height: 1.5;
  }

  .meta {
    color: #7f95ad;
    font: 600 13px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .error {
    color: #ff9aae;
  }

  .present {
    margin-top: 4px;
    color: #38e0b8;
    font-weight: 700;
    font-size: 15px;
  }

  footer {
    margin-top: auto;
    display: flex;
    flex-wrap: wrap;
    gap: 10px 26px;
    color: #6f86a3;
    font-size: 14px;
  }

  kbd {
    display: inline-block;
    min-width: 18px;
    margin-right: 4px;
    padding: 2px 6px;
    border: 1px solid rgba(148, 196, 255, 0.25);
    border-bottom-width: 2px;
    border-radius: 5px;
    background: rgba(148, 196, 255, 0.06);
    color: #c7d6e6;
    font: 600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    text-align: center;
  }
</style>
