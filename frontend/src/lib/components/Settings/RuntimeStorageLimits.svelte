<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { RuntimeReplica } from '@xln/core/runtime/types';

  const GIB = 1024 ** 3;

  export let runtimeFrameEnv: Writable<RuntimeReplica | null>;

  let loadedRuntimeId = '';
  let walEpochGiB = '';
  let status = '';
  let error = '';

  const formatGiB = (bytes: number | undefined): string =>
    bytes === undefined || bytes === Number.MAX_SAFE_INTEGER
      ? ''
      : String(Number((bytes / GIB).toFixed(6)));

  const loadRuntime = (env: RuntimeReplica | null): void => {
    const runtimeId = String(env?.runtimeId || env?.dbNamespace || '');
    if (!env || runtimeId === loadedRuntimeId) return;
    loadedRuntimeId = runtimeId;
    const storage = env.runtimeConfig?.storage;
    walEpochGiB = formatGiB(storage?.epochMaxBytes);
    status = '';
    error = '';
  };

  const parseGiB = (raw: string, label: string): number | undefined => {
    const value = raw.trim();
    if (!value) return undefined;
    const gib = Number(value);
    const bytes = gib * GIB;
    if (!Number.isFinite(gib) || gib <= 0 || !Number.isSafeInteger(bytes)) {
      throw new Error(`${label} must be a positive GiB value`);
    }
    return bytes;
  };

  const writeOptional = (
    target: Record<string, unknown>,
    key: string,
    value: number | undefined,
  ): void => {
    if (value === undefined) delete target[key];
    else target[key] = value;
  };

  function applyLimits(): void {
    try {
      const epochMaxBytes = parseGiB(walEpochGiB, 'WAL epoch limit');
      runtimeFrameEnv.update(env => {
        if (!env) throw new Error('No Runtime is selected');
        env.runtimeConfig ??= {};
        const storage = { ...(env.runtimeConfig.storage ?? {}) } as Record<string, unknown> &
          NonNullable<NonNullable<RuntimeReplica['runtimeConfig']>['storage']>;
        writeOptional(storage, 'epochMaxBytes', epochMaxBytes);
        env.runtimeConfig.storage = storage;
        return env;
      });
      walEpochGiB = formatGiB(epochMaxBytes);
      error = '';
      status = 'Storage policy saved. It applies from the next Runtime frame.';
    } catch (cause) {
      status = '';
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  $: loadRuntime($runtimeFrameEnv);
</script>

<section class="storage-limits" data-testid="runtime-storage-limits">
  <header>
    <div>
      <h4>Runtime storage policy</h4>
      <p>Blank means unlimited. The WAL is the only retained Runtime history.</p>
    </div>
  </header>

  <div class="limit-grid">
    <label>
      <span>WAL epoch rollover</span>
      <input bind:value={walEpochGiB} inputmode="decimal" placeholder="Unlimited" data-testid="storage-wal-gib" />
      <small>GiB · closes the epoch at a durable checkpoint</small>
    </label>
  </div>

  <p class="storage-note">
    Hot state always keeps the latest complete Runtime state. A quota never deletes a partial financial frame.
  </p>
  <button type="button" on:click={applyLimits} data-testid="storage-limits-save">Save storage policy</button>
  {#if status}<p class="status" data-testid="storage-limits-status">{status}</p>{/if}
  {#if error}<p class="error" role="alert" data-testid="storage-limits-error">{error}</p>{/if}
</section>

<style>
  .storage-limits {
    display: grid;
    gap: 14px;
    margin-bottom: 18px;
    padding: 16px;
    border: 1px solid var(--border-color, #30343b);
    border-radius: 12px;
    background: color-mix(in srgb, var(--panel-bg, #15171b) 92%, white 8%);
  }
  h4, p { margin: 0; }
  header p, small, .storage-note { color: #9299a5; font-size: 12px; }
  .limit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
  label { display: grid; gap: 6px; font-size: 13px; }
  input {
    min-width: 0;
    padding: 9px 10px;
    color: inherit;
    border: 1px solid #3a3f48;
    border-radius: 8px;
    background: #111318;
  }
  button {
    justify-self: start;
    padding: 9px 14px;
    color: #fff;
    border: 0;
    border-radius: 8px;
    background: #315cff;
    cursor: pointer;
  }
  .status { color: #5fd39a; font-size: 12px; }
  .error { color: #ff7171; font-size: 12px; }
</style>
