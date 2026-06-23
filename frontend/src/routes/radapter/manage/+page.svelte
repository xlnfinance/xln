<script lang="ts">
  import RemoteRuntimeManager from '$lib/components/Runtime/RemoteRuntimeManager.svelte';
  import { runtimes } from '$lib/stores/runtimeStore';

  $: remoteCount = Array.from($runtimes.values()).filter((runtime) => runtime.type === 'remote').length;
</script>

<svelte:head>
  <title>Remote Runtime Manager</title>
</svelte:head>

<main class="remote-manager-page">
  <header>
    <a href="/app">Back to app</a>
    <div>
      <span>Remote runtimes</span>
      <strong>{remoteCount}/100</strong>
    </div>
  </header>

  <section class="manager-panel">
    <RemoteRuntimeManager />
  </section>
</main>

<style>
  :global(body) {
    background: #0f0d0b;
  }

  .remote-manager-page {
    min-height: 100vh;
    display: grid;
    place-items: start center;
    padding: 32px 16px;
    color: #f5f5f4;
  }

  header,
  .manager-panel {
    width: min(560px, 100%);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 12px;
  }

  header a {
    color: #93c5fd;
    font-size: 13px;
    text-decoration: none;
  }

  header a:hover {
    color: #dbeafe;
  }

  header div {
    display: flex;
    align-items: baseline;
    gap: 10px;
    color: #a8a29e;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
  }

  header strong {
    color: #f5f5f4;
    font-size: 13px;
  }

  .manager-panel {
    border: 1px solid #292524;
    border-radius: 8px;
    background: #141210;
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.32);
  }
</style>
