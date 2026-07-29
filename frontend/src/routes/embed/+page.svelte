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
   *   /embed?trail=ahb              replay a recorded trail from /trails/ahb.json
   *   /embed#trail=<encoded>        replay an inline trail — nothing fetched at all
   *
   * Both trail forms are portable and instant: a recorded run needs no runtime and no EVM,
   * while running a scenario in the browser takes minutes. The hash form additionally never
   * reaches a server, so a demo can travel as a single link.
   */

  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import View from '$lib/view/View.svelte';
  import { settingsOperations } from '$lib/stores/settingsStore';
  import { networkMachineRuntimeOperations } from '$lib/stores/networkMachineRuntimeStore';
  import { networkMachineOperations } from '$lib/stores/networkMachineStore';
  import { networkMachineDemo } from '$lib/stores/networkMachineDemoStore';
  import { decodeNetworkTrailFromHash, parseNetworkTrail } from '$lib/network3d/networkTimelineSource';

  let embedMode = true;
  let scenarioError = '';
  let demoMode = false;

  $: scenario = $page.url.searchParams.get('scenario')?.trim() ?? '';
  $: trailName = $page.url.searchParams.get('trail')?.trim() ?? '';
  $: autoplay = $page.url.searchParams.get('autoplay') === '1';
  $: speed = Number($page.url.searchParams.get('speed') || 1) || 1;
  // `?stage=2d` swaps the spatial graph for the account-first stage. Same data, same
  // player, different picture — the two are meant to be compared on one demo.
  $: stage = $page.url.searchParams.get('stage') ?? '';

  const trailFromHash = (hash: string): string =>
    new URLSearchParams(hash.replace(/^#/, '')).get('trail')?.trim() ?? '';

  const fetchTrail = async (name: string) => {
    // Recorded trails are static assets, so a demo page is cacheable and needs no backend.
    const response = await fetch(`/trails/${encodeURIComponent(name)}.json`);
    if (!response.ok) throw new Error(`TRAIL_NOT_FOUND:${name}:${response.status}`);
    return parseNetworkTrail(await response.text());
  };

  onMount(() => {
    settingsOperations.initialize();
    const encodedTrail = trailFromHash($page.url.hash);
    if (!scenario && !trailName && !encodedTrail) return;

    // The Time Machine is the narration in a demo, so it must be visible, and the dock
    // drops every other panel: a wallet prompt next to the story is noise.
    demoMode = true;
    settingsOperations.setShowTimeMachine(true);
    // Technical R-frames (consensus bookkeeping) carry no story. A demo scrubs the steps
    // that changed the network.
    networkMachineOperations.setTimelineMode('graph-changes');
    networkMachineDemo.set({ autoplay, speed, stage: stage as '2d' | '3d' });

    const fail = (error: unknown): void => {
      scenarioError = error instanceof Error ? error.message : String(error || 'demo failed');
    };

    // Recorded trails win: they are exact, instant, and need no runtime to replay.
    if (encodedTrail) {
      void decodeNetworkTrailFromHash(encodedTrail)
        .then((trail) => networkMachineRuntimeOperations.loadTrail(trail))
        .catch(fail);
      return;
    }
    if (trailName) {
      void fetchTrail(trailName)
        .then((trail) => networkMachineRuntimeOperations.loadTrail(trail))
        .catch(fail);
      return;
    }
    void networkMachineRuntimeOperations.loadScenario(scenario).catch(fail);
  });
</script>

<svelte:head>
  <title>xln — {scenario ? `${scenario} scenario` : 'Embedded Workspace'}</title>
</svelte:head>

{#if scenarioError}
  <div class="scenario-error" role="alert" data-testid="embed-scenario-error">{scenarioError}</div>
{/if}

<View
  layout="default"
  networkMode="simnet"
  {embedMode}
  {demoMode}
  userMode={false}
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
