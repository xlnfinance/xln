<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { allRuntimes, vaultOperations } from '#lib/stores/vault/vaultStore.ts';
  import { hasPasswordVault, savePasswordVault, unlockPasswordVault } from '#lib/security/passwordVault.ts';
  import { deleteVaultDeviceKey } from '#lib/security/vaultProtection.ts';
  export let runtimeId: string;
  export let seed: string | undefined = undefined;
  const dispatch = createEventDispatcher<{ unlocked: void; recover: void }>();
  let password = '', confirmation = '', error = '', busy = false;
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
    finally { confirmation = ''; busy = false; }
  }
</script>

  <main class="unlock">
    <form on:submit|preventDefault={submit}>
      <p class="name">{wallet?.label || 'Wallet'}</p>
      <h1>{setup ? 'Set a local password' : 'Unlock wallet'}</h1>
      {#if protectedHere || setup}
        <label for="local-wallet-password">Password</label>
        <input id="local-wallet-password" type="password" bind:value={password} autocomplete={setup ? 'new-password' : 'current-password'} required minlength={setup ? 8 : undefined} disabled={busy} />
        {#if setup}
          <label for="local-wallet-confirm">Confirm password</label>
          <input id="local-wallet-confirm" type="password" bind:value={confirmation} autocomplete="new-password" required disabled={busy} />
        {/if}
        <button type="submit" disabled={busy || !password}>{busy ? 'Opening…' : setup ? 'Save and open' : 'Unlock'}</button>
      {:else}
        <p>Restore this wallet once to set a password for this device.</p>
      {/if}
      {#if error}<p role="alert">{error}</p>{/if}
      {#if !setup}<button type="button" class="recover" disabled={busy} on:click={() => dispatch('recover')}>Restore wallet</button>{/if}
    </form>
  </main>
<style>
  .unlock { min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #f4efe6; background: #141412; }
  form { width: min(100%, 360px); display: grid; gap: 16px; }
  h1 { font-size: 28px; margin: 0 0 12px; } p { line-height: 1.5; margin: 0; } .name { color: #aaa69d; }
  label { font-size: 14px; } input { padding: 14px; border: 1px solid #494740; border-radius: 10px; background: #1c1c19; color: inherit; font: inherit; }
  button { padding: 14px; border: 0; border-radius: 10px; background: #f4efe6; color: #141412; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; } .recover { background: transparent; color: #aaa69d; } [role=alert] { color: #ff9487; }
</style>
