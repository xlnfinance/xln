<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { RuntimeReplica } from '@xln/runtime/runtime/types';

  const MIB = 1024 ** 2;
  export let runtimeFrameEnv: Writable<RuntimeReplica | null>;

  let loadedRuntimeId = '';
  let cloneMiB = '';
  let cloneMs = '';
  let reducerMs = '';
  let walMs = '';
  let status = '';
  let error = '';

  const display = (value: number | undefined, divisor = 1): string =>
    value === undefined ? '' : String(Number((value / divisor).toFixed(3)));

  const loadRuntime = (env: RuntimeReplica | null): void => {
    const runtimeId = String(env?.runtimeId || env?.dbNamespace || '');
    if (!env || runtimeId === loadedRuntimeId) return;
    loadedRuntimeId = runtimeId;
    const budget = env.runtimeConfig?.performance;
    cloneMiB = display(budget?.maxCloneBytes, MIB);
    cloneMs = display(budget?.maxCloneMs);
    reducerMs = display(budget?.maxReducerMs);
    walMs = display(budget?.maxWalMs);
    status = '';
    error = '';
  };

  const parse = (raw: string, label: string, multiplier = 1): number | undefined => {
    const value = raw.trim();
    if (!value) return undefined;
    const parsed = Number(value) * multiplier;
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER) {
      throw new Error(`${label} must be a positive finite number`);
    }
    return parsed;
  };

  function saveBudgets(): void {
    try {
      const next = {
        maxCloneBytes: parse(cloneMiB, 'Clone budget', MIB),
        maxCloneMs: parse(cloneMs, 'Clone latency budget'),
        maxReducerMs: parse(reducerMs, 'Reducer latency budget'),
        maxWalMs: parse(walMs, 'WAL latency budget'),
      };
      runtimeFrameEnv.update(env => {
        if (!env) throw new Error('No Runtime is selected');
        env.runtimeConfig ??= {};
        env.runtimeConfig.performance = Object.fromEntries(
          Object.entries(next).filter((entry): entry is [string, number] => entry[1] !== undefined),
        );
        return env;
      });
      error = '';
      status = 'Performance budgets saved. Blank metrics remain observation-only.';
    } catch (cause) {
      status = '';
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  $: loadRuntime($runtimeFrameEnv);
</script>

<section class="perf-budgets" data-testid="runtime-performance-budgets">
  <header>
    <h4>Runtime frame budgets</h4>
    <p>Local alarms only. A slow frame is still committed according to protocol.</p>
  </header>
  <div class="budget-grid">
    <label><span>Clone payload</span><input bind:value={cloneMiB} placeholder="Observe" inputmode="decimal" data-testid="perf-clone-mib" /><small>MiB</small></label>
    <label><span>Clone latency</span><input bind:value={cloneMs} placeholder="Observe" inputmode="decimal" data-testid="perf-clone-ms" /><small>ms</small></label>
    <label><span>Reducer latency</span><input bind:value={reducerMs} placeholder="Observe" inputmode="decimal" data-testid="perf-reducer-ms" /><small>ms</small></label>
    <label><span>Durable WAL write</span><input bind:value={walMs} placeholder="Observe" inputmode="decimal" data-testid="perf-wal-ms" /><small>ms</small></label>
  </div>
  <button type="button" on:click={saveBudgets} data-testid="perf-budgets-save">Save frame budgets</button>
  {#if status}<p class="status" data-testid="perf-budgets-status">{status}</p>{/if}
  {#if error}<p class="error" role="alert" data-testid="perf-budgets-error">{error}</p>{/if}
</section>

<style>
  .perf-budgets { display: grid; gap: 14px; margin-bottom: 18px; padding: 16px; border: 1px solid #30343b; border-radius: 12px; background: #15171b; }
  h4, p { margin: 0; }
  header p, small { color: #9299a5; font-size: 12px; }
  .budget-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  label { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; font-size: 13px; }
  label span { grid-column: 1 / -1; }
  input { min-width: 0; padding: 9px 10px; color: inherit; border: 1px solid #3a3f48; border-radius: 8px; background: #111318; }
  button { justify-self: start; padding: 9px 14px; color: #fff; border: 0; border-radius: 8px; background: #315cff; cursor: pointer; }
  .status { color: #5fd39a; font-size: 12px; }
  .error { color: #ff7171; font-size: 12px; }
</style>
