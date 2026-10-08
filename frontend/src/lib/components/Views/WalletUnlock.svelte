<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { allRuntimes } from '#lib/stores/vault/vaultStore.ts';
  import RuntimeCreation from './RuntimeCreation.svelte';
  import WalletPasswordForm from './WalletPasswordForm.svelte';
  export let runtimeId: string;
  let selectedId = '';
  let mode: 'welcome' | 'create' | 'unlock' | 'recover' = 'welcome';
  const dispatch = createEventDispatcher<{ unlocked: void }>();
</script>

{#if mode === 'welcome'}
  <main class="wallet-entry">
    <section>
      <h1>Welcome to xln</h1>
      <button class="primary" on:click={() => { mode = 'create'; }}>Create a wallet</button>
      <h2>Saved wallets</h2>
      {#each $allRuntimes as wallet (wallet.id)}
        <button class="wallet" on:click={() => { selectedId = wallet.id; mode = 'unlock'; }}>
          <span>{wallet.label || 'Wallet'}</span><small>{wallet.id.slice(-8)}</small><span>Unlock →</span>
        </button>
      {/each}
    </section>
  </main>
{:else}
  <button class="back" on:click={() => { mode = 'welcome'; }}>← Back</button>
  {#if mode === 'create'}
    <RuntimeCreation embedded={true} on:walletReady={() => dispatch('unlocked')} />
  {:else if mode === 'recover'}
    <RuntimeCreation embedded={true} unlockRuntimeId={selectedId || runtimeId} on:walletReady={() => dispatch('unlocked')} />
  {:else}
    {#key selectedId}
      <WalletPasswordForm runtimeId={selectedId} on:unlocked={() => dispatch('unlocked')} on:recover={() => { mode = 'recover'; }} />
    {/key}
  {/if}
{/if}

<style>
  .wallet-entry { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #141412; color: #f4efe6; }
  section { width: min(100%, 440px); } h1 { font-size: 28px; margin-bottom: 24px; }
  h2 { font-size: 13px; color: #aaa69d; margin: 36px 0 12px; }
  button { font: inherit; cursor: pointer; border: 0; border-radius: 12px; padding: 16px; }
  .primary { width: 100%; background: #f4efe6; color: #141412; }
  .wallet { width: 100%; display: flex; align-items: center; gap: 12px; margin-top: 8px; background: #22221e; color: inherit; text-align: left; }
  .wallet span:first-child { flex: 1; } small { color: #aaa69d; }
  .back { position: absolute; top: 16px; left: 16px; z-index: 1; background: #22221e; color: #f4efe6; }
</style>
