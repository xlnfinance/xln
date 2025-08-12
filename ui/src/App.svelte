<script lang="ts">
  import { onMount } from 'svelte';
  import Formation from './components/Formation.svelte';
  import Panels from './components/Panels.svelte';
  import { initEnvFromBrowser, xlnEnv } from './stores/xln';
  let initialized = false;
  onMount(async () => { await initEnvFromBrowser(); initialized = true; });
</script>

<main class="min-h-screen">
  <header class="sticky top-0 z-10 bg-black/60 backdrop-blur border-b border-outline">
    <div class="w-full mx-auto px-4 py-3 flex items-center justify-between">
      <div class="text-white font-mono text-xl">xln</div>
      <nav class="flex gap-2">
        <a href="/ui/" class="px-3 py-1 rounded bg-accent/20 hover:bg-accent/30">Formation</a>
        <a href="/ui/#panels" class="px-3 py-1 rounded bg-accent/20 hover:bg-accent/30">Panels</a>
        <a href="/ui/#jurisdictions" class="px-3 py-1 rounded bg-accent/20 hover:bg-accent/30">Jurisdictions</a>
      </nav>
    </div>
  </header>

  <section class="w-full mx-auto p-4">
    {#if !initialized}
      <div class="text-gray-400">Loading environment…</div>
    {:else}
      <div class="grid grid-cols-1 gap-4">
        <div class="bg-panel border border-outline rounded p-4">
          <h2 class="font-semibold mb-2">🏗️ Entity Formation</h2>
          <Formation />
        </div>
        <div class="bg-panel border border-outline rounded p-4">
          <h2 class="font-semibold mb-2">👁️ Panels</h2>
          <Panels />
        </div>
      </div>
    {/if}
  </section>
</main>

<style>
  :global(.border-outline){ border-color:#3e3e3e }
</style>


