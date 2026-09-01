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
   *   /embed#trail=<encoded>         replay a recorded trail — no runtime, no scenario run
   *
   * The hash form is what makes a demo portable: it never reaches a server, and it carries
   * the frames themselves, so the same URL renders the same network anywhere.
   */

  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import View from '$lib/view/View.svelte';
  import { settingsOperations } from '$lib/stores/settingsStore';
  import { networkMachineRuntimeOperations } from '$lib/stores/network/networkMachineRuntimeStore';
  import { networkMachineDemo } from '$lib/stores/network/networkMachineDemoStore';
  import { decodeNetworkTrailFromHash } from '$lib/network3d/timeline/networkTimelineSource';
  import { embedBootErrorMessage, embedBootTitle, parseEmbedBootRequest } from '../../../packages/runtime-client/src/embed-boot-model';

  let embedMode = true;
  let scenarioError = '';

  // URL semantics (scenario/autoplay/speed, trail-wins precedence) live in the
  // shared boot model so the React workspace parses the identical contract.
  $: boot = parseEmbedBootRequest($page.url);
  $: documentTitle = embedBootTitle(boot);

  onMount(() => {
    settingsOperations.initialize();
    if (boot.kind === 'plain') return;

    // The Time Machine is the narration in a demo, so it must be visible.
    settingsOperations.setShowTimeMachine(true);
    networkMachineDemo.set({ autoplay: boot.autoplay, speed: boot.speed });

    const fail = (error: unknown): void => {
      scenarioError = embedBootErrorMessage(error);
    };

    // A recorded trail wins: it is exact, and it does not need a runtime to replay.
    if (boot.kind === 'trail') {
      void decodeNetworkTrailFromHash(boot.encodedTrail)
        .then((trail) => networkMachineRuntimeOperations.loadTrail(trail))
        .catch(fail);
      return;
    }
    void networkMachineRuntimeOperations.loadScenario(boot.scenario).catch(fail);
  });
</script>

<svelte:head>
  <title>{documentTitle}</title>
</svelte:head>

{#if scenarioError}
  <div class="scenario-error" role="alert" data-testid="embed-scenario-error">{scenarioError}</div>
{/if}

<View
  layout="default"
  networkMode="simnet"
  {embedMode}
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
