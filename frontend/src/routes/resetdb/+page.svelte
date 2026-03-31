<script lang="ts">
  import { onMount } from 'svelte';
  import { resetEverything } from '$lib/utils/resetEverything';

  let status = $state('Resetting local XLN data...');
  let detail = $state('Closing local runtime handles and deleting browser storage.');
  let failed = $state(false);

  onMount(() => {
    void (async () => {
      try {
        await resetEverything('reset-route');
      } catch (error) {
        failed = true;
        status = 'Reset blocked';
        detail = error instanceof Error ? error.message : String(error);
      }
    })();
  });

  async function retryReset(): Promise<void> {
    failed = false;
    status = 'Retrying reset...';
    detail = 'Deleting local storage again.';
    try {
      await resetEverything('reset-route-retry');
    } catch (error) {
      failed = true;
      status = 'Reset blocked';
      detail = error instanceof Error ? error.message : String(error);
    }
  }
</script>

<svelte:head>
  <title>xln - Reset</title>
</svelte:head>

<main class="reset-shell" data-testid="reset-shell">
  <section class="reset-card">
    <div class="reset-kicker">Local reset</div>
    <h1>{status}</h1>
    <p>{detail}</p>
    {#if failed}
      <button class="reset-button" type="button" onclick={retryReset}>Retry reset</button>
    {/if}
  </section>
</main>

<style>
  .reset-shell {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 32px;
    background:
      radial-gradient(circle at top, rgba(245, 158, 11, 0.12), transparent 34%),
      linear-gradient(180deg, #050506 0%, #101014 100%);
    color: #f4f4f5;
  }

  .reset-card {
    width: min(560px, 100%);
    padding: 28px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    background: rgba(18, 18, 24, 0.92);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
  }

  .reset-kicker {
    margin-bottom: 10px;
    color: rgba(245, 158, 11, 0.8);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0 0 10px;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.03em;
  }

  p {
    margin: 0;
    color: rgba(228, 228, 231, 0.82);
    line-height: 1.55;
    word-break: break-word;
  }

  .reset-button {
    margin-top: 18px;
    min-height: 44px;
    padding: 0 18px;
    border: 1px solid rgba(245, 158, 11, 0.35);
    border-radius: 12px;
    background: rgba(245, 158, 11, 0.12);
    color: #f8fafc;
    font: inherit;
    cursor: pointer;
  }
</style>
