<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { Env, EnvSnapshot, JReplica } from '@xln/runtime/xln-api';
  import { safeStringify } from '@xln/runtime/protocol/serialization';

  export let runtimeFrameEnv: Writable<Env | null>;
  export let runtimeFrameHistory: Writable<EnvSnapshot[]>;
  export let runtimeFrameTimeIndex: Writable<number>;

  type Machine = JReplica & {
    reserves?: Map<unknown, unknown> | Record<string, unknown>;
    collaterals?: Map<unknown, unknown> | Record<string, unknown>;
  };
  type ContractRow = { name: string; address: string; bytes: number | null; error: string };

  let selectedName = '';
  let contracts: ContractRow[] = [];
  let loadingCode = false;
  let inspectorError = '';

  $: selectedFrame = $runtimeFrameTimeIndex >= 0
    ? ($runtimeFrameHistory[Math.min($runtimeFrameTimeIndex, $runtimeFrameHistory.length - 1)] ?? null)
    : $runtimeFrameEnv;
  $: machines = Array.from(selectedFrame?.jReplicas?.values?.() ?? []) as Machine[];
  $: if (!selectedName || !machines.some((machine) => machine.name === selectedName)) selectedName = machines[0]?.name ?? '';
  $: selected = machines.find((machine) => machine.name === selectedName) ?? null;
  $: reserveCount = selected?.reserves instanceof Map ? selected.reserves.size : Object.keys(selected?.reserves ?? {}).length;
  $: collateralCount = selected?.collaterals instanceof Map ? selected.collaterals.size : Object.keys(selected?.collaterals ?? {}).length;
  $: rawState = selected ? safeStringify({
    name: selected.name,
    blockNumber: selected.blockNumber,
    stateRoot: selected.stateRoot,
    mempool: selected.mempool,
    blockDelayMs: selected.blockDelayMs,
    blockTimeMs: selected.blockTimeMs,
    lastBlockTimestamp: selected.lastBlockTimestamp,
    chainId: selected.chainId,
    rpcs: selected.rpcs,
    position: selected.position,
    contracts: selected.contracts,
    depositoryAddress: selected.depositoryAddress,
    entityProviderAddress: selected.entityProviderAddress,
    reserves: selected.reserves,
    collaterals: selected.collaterals,
  }, 2) : '';

  const contractAddresses = (machine: Machine): Array<{ name: string; address: string }> => {
    const entries = [
      ['Depository', machine.depositoryAddress || machine.contracts?.depository],
      ['EntityProvider', machine.entityProviderAddress || machine.contracts?.entityProvider],
      ['Account', machine.contracts?.account],
      ['DeltaTransformer', machine.contracts?.deltaTransformer],
    ] as const;
    return entries.flatMap(([name, address]) => address ? [{ name, address }] : []);
  };
  const byteLength = (code: unknown): number => {
    if (typeof code === 'string') return code.startsWith('0x') ? Math.max(0, (code.length - 2) / 2) : new TextEncoder().encode(code).length;
    if (code instanceof Uint8Array) return code.byteLength;
    throw new Error('Contract provider returned unsupported bytecode');
  };

  async function inspectBytecode(): Promise<void> {
    if (!selected) return;
    const provider = selected.jadapter?.provider as unknown as { getCode?: (address: string) => Promise<unknown> } | undefined;
    if (!provider?.getCode) {
      inspectorError = 'Selected J-Machine has no readable contract provider';
      contracts = contractAddresses(selected).map((entry) => ({ ...entry, bytes: null, error: inspectorError }));
      return;
    }
    loadingCode = true;
    inspectorError = '';
    contracts = await Promise.all(contractAddresses(selected).map(async (entry) => {
      try {
        return { ...entry, bytes: byteLength(await provider.getCode!(entry.address)), error: '' };
      } catch (cause) {
        return { ...entry, bytes: null, error: cause instanceof Error ? cause.message : String(cause) };
      }
    }));
    const failures = contracts.filter((entry) => entry.error);
    if (failures.length > 0) inspectorError = failures.map((entry) => `${entry.name}: ${entry.error}`).join('; ');
    loadingCode = false;
  }
</script>

<section class="inspector" data-testid="jmachine-storage-inspector">
  <header><div><small>Dock-only raw state</small><h2>J-Machine Inspector</h2></div><select bind:value={selectedName}>{#each machines as machine}<option value={machine.name}>{machine.name}</option>{/each}</select></header>
  {#if !selected}
    <div class="message">No J-Machine in the selected frame.</div>
  {:else}
    <div class="metrics">
      <article><small>J height</small><strong>{selected.blockNumber.toString()}</strong></article>
      <article><small>Mempool</small><strong>{selected.mempool.length}</strong></article>
      <article><small>Reserve maps</small><strong>{reserveCount}</strong></article>
      <article><small>Collateral maps</small><strong>{collateralCount}</strong></article>
    </div>
    <section class="contracts">
      <div class="section-head"><h3>Contract bytecode</h3><button disabled={loadingCode} on:click={() => void inspectBytecode()}>{loadingCode ? 'Reading…' : 'Read code'}</button></div>
      {#if inspectorError}<div class="error">{inspectorError}</div>{/if}
      <table><thead><tr><th>Contract</th><th>Address</th><th>Bytes / EIP-170</th></tr></thead><tbody>
        {#each contracts as contract}<tr><td>{contract.name}</td><td><code title={contract.address}>{contract.address}</code></td><td class:over={(contract.bytes ?? 0) > 24_576}>{contract.bytes === null ? '—' : `${contract.bytes.toLocaleString()} / 24,576`}</td></tr>{/each}
      </tbody></table>
    </section>
    <details><summary>Raw J-Machine state</summary><pre>{rawState}</pre></details>
  {/if}
</section>

<style>
  .inspector { height:100%; overflow:auto; box-sizing:border-box; padding:16px; background:#080d12; color:#e4edf3; } header,.section-head { display:flex; justify-content:space-between; align-items:center; gap:12px; } h2 { margin:3px 0 0; font-size:18px; } h3 { margin:0; font-size:14px; } small { color:#7890a3; }
  select,button { border:1px solid #274156; border-radius:6px; background:#0d1922; color:#d8e8f2; padding:7px 9px; }
  .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin:12px 0; } .metrics article { display:grid; gap:6px; padding:11px; border:1px solid #182c3a; border-radius:7px; background:#0b141c; }
  .contracts { border:1px solid #182c3a; border-radius:7px; padding:11px; } table { width:100%; border-collapse:collapse; margin-top:8px; font-size:12px; } th,td { padding:7px; border-top:1px solid #172834; text-align:left; } code { display:block; max-width:260px; overflow:hidden; text-overflow:ellipsis; } .over,.error { color:#ff8fa2; }
  details { margin-top:12px; border:1px solid #182c3a; border-radius:7px; padding:10px; } pre { overflow:auto; max-height:460px; white-space:pre-wrap; font:11px/1.45 ui-monospace,monospace; color:#9fc0d4; } .message { padding:18px; color:#7890a3; }
  @media(max-width:800px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr));}}
</style>
