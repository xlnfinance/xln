<script lang="ts">
  /**
   * Embed Route — the full workspace, embeddable.
   *
   * `?scenario=<key>` replays a scenario as a network: it runs in this browser, and the
   * NetworkMachine scrubs its frames with a caption per step. No wallet, no connected
   * runtime, nothing to set up — which is what makes it embeddable.
   *
   *   /embed?scenario=ahb            run and show, paused on the first frame
   *   /embed?scenario=ahb&autoplay=1 play it
   *   /embed?scenario=ahb&speed=2    playback speed
   *   /embed?trail=ahb               replay the shipped trail /demo-trails/ahb.json offline
   *   /embed#trail=<encoded>         replay a recorded trail — no runtime, no scenario run
   *   ...&present=1                  presentation mode: graph-dominant, narration card, keys
   *
   * The hash form is what makes a demo portable: it never reaches a server, and it carries
   * the frames themselves, so the same URL renders the same network anywhere.
   */

  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import View from '#lib/view/View.svelte';
  import { settingsOperations } from '#lib/stores/settingsStore.ts';
  import { networkMachineRuntimeOperations } from '#lib/stores/network/networkMachineRuntimeStore.ts';
  import { networkMachineDemo, networkMachinePresentation } from '#lib/stores/network/networkMachineDemoStore.ts';
  import { decodeNetworkTrailFromHash, fetchDemoNetworkTrail } from '#lib/network3d/timeline/networkTimelineSource.ts';
  import { getXLN } from '#lib/stores/bootstrap/xlnRuntimeLoader.ts';
  import { demoChapterHref, demoChapterPosition } from '#lib/network3d/timeline/demoStory.ts';

  let embedMode = true;
  let scenarioError = $state('');

  let scenario = $derived(page.url.searchParams.get('scenario')?.trim() ?? '');
  let trailName = $derived(page.url.searchParams.get('trail')?.trim() ?? '');
  let autoplay = $derived(page.url.searchParams.get('autoplay') === '1');
  let speed = $derived(Number(page.url.searchParams.get('speed') || 1) || 1);
  let presentMode = $derived(page.url.searchParams.get('present') === '1');
  let demoTitle = $derived(scenario || trailName);

  const trailFromHash = (hash: string): string =>
    new URLSearchParams(hash.replace(/^#/, '')).get('trail')?.trim() ?? '';

  onMount(() => {
    settingsOperations.initialize();
    const encodedTrail = trailFromHash(page.url.hash);
    if (!scenario && !trailName && !encodedTrail) return;

    // The Time Machine is the narration in a demo, so it must be visible.
    settingsOperations.setShowTimeMachine(true);
    networkMachineDemo.set({ autoplay, speed });
    const fail = (error: unknown): void => {
      scenarioError = error instanceof Error ? error.message : String(error || 'demo failed');
    };

    // A story chapter is named by the story and offers the next chapter at its last step.
    const position = presentMode && trailName ? demoChapterPosition(trailName) : null;
    networkMachinePresentation.set(!presentMode ? null : position ? {
      title: position.chapter.title,
      chapter: {
        index: position.index,
        count: position.count,
        next: position.next ? { title: position.next.title, href: demoChapterHref(position.next.trail) } : null,
      },
    } : { title: demoTitle });

    // Outside the story the catalog names the scenario; an unknown trail keeps its slug.
    if (presentMode && !position) {
      void getXLN()
        .then((xln) => {
          const name = xln.getScenario(demoTitle)?.name;
          if (name) networkMachinePresentation.set({ title: name });
        })
        .catch(fail);
    }

    // A recorded trail wins: it is exact, and it does not need a runtime to replay.
    if (encodedTrail) {
      void decodeNetworkTrailFromHash(encodedTrail)
        .then((trail) => networkMachineRuntimeOperations.loadTrail(trail))
        .catch(fail);
      return;
    }
    if (trailName) {
      void fetchDemoNetworkTrail(trailName)
        .then((trail) => networkMachineRuntimeOperations.loadTrail(trail))
        .catch(fail);
      return;
    }
    void networkMachineRuntimeOperations.loadScenario(scenario).catch(fail);
  });
</script>

<svelte:head>
  <title>xln — {demoTitle ? `${demoTitle} scenario` : 'Embedded Workspace'}</title>
</svelte:head>

{#if scenarioError}
  <div class="scenario-error" role="alert" data-testid="embed-scenario-error">{scenarioError}</div>
{/if}

<View
  layout="default"
  networkMode="simnet"
  {embedMode}
  {presentMode}
/>

<style>
  :global(body) {
    margin: 0;
  }

  /* Hide mode toggle in embed */
  :global(.mode-toggle) {
    display: none !important;
  }

  .scenario-error {
    position: fixed;
    top: 12px;
    left: 12px;
    right: 12px;
    z-index: 90;
    padding: 9px 11px;
    border: 1px solid rgba(255, 91, 113, 0.55);
    border-radius: 7px;
    background: rgba(40, 8, 14, 0.94);
    color: #ffb8c2;
    font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
</style>
