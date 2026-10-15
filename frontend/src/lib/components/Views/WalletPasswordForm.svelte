<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  import { allRuntimes, vaultOperations } from '#lib/stores/vault/vaultStore.ts';
  import { hasPasswordVault, savePasswordVault, unlockPasswordVault } from '#lib/security/passwordVault.ts';
  import { deleteVaultDeviceKey } from '#lib/security/vaultProtection.ts';
  export let runtimeId: string;
  export let seed: string | undefined = undefined;
  export let scheme: 'dark' | 'light' = 'dark';
  export let onCancel: (() => void) | undefined = undefined;
  const dispatch = createEventDispatcher<{ unlocked: void; recover: void }>();
  let password = '', confirmation = '', error = '', busy = false;
  let passwordInput: HTMLInputElement;
  let protectedHere = hasPasswordVault(runtimeId);
  $: wallet = $allRuntimes.find(value => value.id.toLowerCase() === runtimeId.toLowerCase());
  $: setup = !protectedHere && Boolean(seed || wallet?.seed);
  async function submit() {
    if (busy) return;
    busy = true; error = '';
    const secret = password;
    password = '';
    try {
      if (setup) {
        if (secret.length < 8) throw new Error('Use at least 8 characters.');
        if (secret !== confirmation) throw new Error('Passwords do not match.');
        const unlockedSeed = seed || wallet?.seed;
        if (!unlockedSeed) throw new Error('Restore your wallet first.');
        await savePasswordVault(runtimeId, unlockedSeed, secret);
        if (wallet?.protectedSecrets) await deleteVaultDeviceKey(runtimeId, wallet.protectedSecrets);
        protectedHere = true;
      } else {
        const seed = await unlockPasswordVault(runtimeId, secret);
        await vaultOperations.unlockRuntime(runtimeId, seed);
      }
      dispatch('unlocked');
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally {
      confirmation = ''; busy = false;
      if (error) { await tick(); passwordInput?.focus(); }
    }
  }
</script>

  <main class="unlock" class:scheme-light={scheme === 'light'}>
    <form on:submit|preventDefault={submit}>
      <p class="name">{wallet?.label || 'Wallet'}</p>
      <h1>{setup ? 'Set a local password' : 'Unlock wallet'}</h1>
      {#if protectedHere || setup}
        <label for="local-wallet-password">Password</label>
        <input id="local-wallet-password" type="password" bind:this={passwordInput} bind:value={password} autocomplete={setup ? 'new-password' : 'current-password'} required minlength={setup ? 8 : undefined} disabled={busy} />
        {#if setup}
          <label for="local-wallet-confirm">Confirm password</label>
          <input id="local-wallet-confirm" type="password" bind:value={confirmation} autocomplete="new-password" required disabled={busy} />
        {/if}
        <button type="submit" disabled={busy || !password}>{busy ? 'Opening…' : setup ? 'Save and open' : 'Unlock'}</button>
      {:else}
        <p>Restore this wallet once to set a password for this device.</p>
      {/if}
      {#if error}<p role="alert">{error}</p>{/if}
      {#if onCancel}<button type="button" class="recover" disabled={busy} on:click={onCancel}>Back</button>{/if}
      {#if !setup}<button type="button" class="recover" disabled={busy} on:click={() => dispatch('recover')}>Restore wallet</button>{/if}
    </form>
  </main>
<style>
  .unlock {
    --theme-bg: #141412; --theme-text-primary: #f4efe6; --theme-text-secondary: #aaa69d;
    --theme-input-bg: #1c1c19; --theme-input-border: #494740; --theme-error: #ff9487;
    --theme-input-text: var(--theme-text-primary);
    min-height: 100vh; display: grid; place-items: center; padding: 24px;
    color: var(--theme-text-primary); background: var(--theme-bg); color-scheme: dark;
  }
  .scheme-light {
    --theme-bg: #f8fafb; --theme-text-primary: #17212e; --theme-text-secondary: #566376;
    --theme-input-bg: #fff; --theme-input-border: #c7cfd8; --theme-error: #b42318;
    color-scheme: light;
  }
  form { width: min(100%, 360px); display: grid; gap: 16px; }
  h1 { font-size: 28px; margin: 0 0 12px; } p { line-height: 1.5; margin: 0; } .name { color: var(--theme-text-secondary); }
  label { font-size: 14px; } input { padding: 14px; border: 1px solid var(--theme-input-border); border-radius: 10px; background: var(--theme-input-bg); color: inherit; font: inherit; }
  button { padding: 14px; border: 0; border-radius: 10px; background: var(--theme-text-primary); color: var(--theme-bg); font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; } .recover { background: transparent; color: var(--theme-text-secondary); } [role=alert] { color: var(--theme-error); }
</style>
