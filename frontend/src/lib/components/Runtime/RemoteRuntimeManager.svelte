<script lang="ts">
  import {
    describeRemoteRuntimeImportError,
    normalizeRemoteRuntimeWsUrl,
    parseRemoteRuntimeImportText,
    type RemoteRuntimeImportAccess,
    type RemoteRuntimeImportEntry,
  } from '$lib/utils/remoteRuntimeImport';
  import { importRemoteRuntimeEntries } from '$lib/utils/remoteRuntimeImportFlow';

  type Row = RemoteRuntimeImportEntry & { index: number; status: string; detail: string };
  let mode: 'single' | 'bulk' = 'single';
  let label = '';
  let access: RemoteRuntimeImportAccess = 'read';
  let wsUrl = '';
  let token = '';
  let bulkText = '';
  let rows: Row[] = [];
  let failed: RemoteRuntimeImportEntry[] = [];
  let status = '';
  let error = '';
  let working = false;

  const buildSingle = (): RemoteRuntimeImportEntry => {
    const normalizedUrl = normalizeRemoteRuntimeWsUrl(wsUrl);
    const normalizedToken = token.trim();
    if (!normalizedToken.startsWith('xlnra1.')) throw new Error('REMOTE_RUNTIME_IMPORT_TOKEN_INVALID:1');
    return { label: label.trim() || new URL(normalizedUrl).host, access, wsUrl: normalizedUrl, token: normalizedToken };
  };
  const resetRows = (entries: RemoteRuntimeImportEntry[]): void => {
    rows = entries.map((entry, index) => ({ ...entry, index, status: 'pending', detail: 'waiting' }));
  };
  const setRow = (index: number, patch: Partial<Row>): void => {
    rows = rows.map((row) => row.index === index ? { ...row, ...patch } : row);
  };

  async function importEntries(entries: RemoteRuntimeImportEntry[]): Promise<void> {
    if (working) return;
    working = true;
    error = '';
    failed = [];
    resetRows(entries);
    status = `Validating ${entries.length} runtime${entries.length === 1 ? '' : 's'}…`;
    try {
      const result = await importRemoteRuntimeEntries(entries, {
        activateFirst: true,
        onProgress: (progress) => setRow(progress.index, { status: progress.status, detail: progress.detail }),
      });
      failed = result.failed.map((item) => item.entry);
      error = result.failed.map((item) => item.reason).join('\n');
      status = `Attached ${result.validated.length}/${entries.length}`;
    } catch (cause) {
      error = describeRemoteRuntimeImportError(cause, entries[0]);
      status = 'Attach failed';
    } finally {
      working = false;
    }
  }

  async function submit(): Promise<void> {
    try {
      const entries = mode === 'single' ? [buildSingle()] : parseRemoteRuntimeImportText(bulkText);
      await importEntries(entries);
    } catch (cause) {
      error = describeRemoteRuntimeImportError(cause);
    }
  }
</script>

<section class="manager" data-testid="remote-runtime-manager">
  <header><div><small>Browser → remote radapter</small><h2>Runtime Manager</h2></div><div class="tabs"><button class:active={mode === 'single'} on:click={() => mode = 'single'}>Attach</button><button class:active={mode === 'bulk'} on:click={() => mode = 'bulk'}>Bulk</button></div></header>
  {#if mode === 'single'}
    <div class="form">
      <input bind:value={label} placeholder="Label" />
      <select bind:value={access}><option value="read">inspect</option><option value="admin">admin</option></select>
      <input class="wide" bind:value={wsUrl} placeholder="ws://localhost:8080/rpc" />
      <input class="wide" bind:value={token} type="password" placeholder="xlnra1 capability token" />
    </div>
  {:else}
    <textarea bind:value={bulkText} spellcheck="false" placeholder="Hub | read | ws://localhost:8080/rpc | xlnra1…"></textarea>
  {/if}
  <button class="primary" disabled={working} on:click={() => void submit()}>{working ? 'Validating…' : 'Validate & attach'}</button>
  {#if failed.length > 0 && !working}<button class="retry" on:click={() => void importEntries(failed)}>Retry failed ({failed.length})</button>{/if}
  {#if status}<div class="status">{status}</div>{/if}
  {#if error}<pre class="error">{error}</pre>{/if}
  {#if rows.length > 0}
    <div class="rows">
      {#each rows as row}
        <article class:bad={row.status === 'error'}><span class="dot {row.status}"></span><strong>{row.label}</strong><code>{row.access}</code><small title={row.wsUrl}>{row.detail}</small></article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .manager { height:100%; overflow:auto; box-sizing:border-box; padding:16px; background:#080d12; color:#e5edf3; }
  header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; } h2 { margin:3px 0 0; font-size:18px; } small { color:#7890a3; }
  .tabs { display:flex; gap:4px; } button, input, select, textarea { border:1px solid #243b4c; border-radius:6px; background:#0c1720; color:#dcebf4; }
  button { padding:7px 10px; cursor:pointer; } button.active, button.primary { border-color:#2887b5; background:#123248; } button:disabled { opacity:.5; cursor:wait; }
  .form { display:grid; grid-template-columns:1fr 110px; gap:7px; } input, select { height:34px; padding:0 9px; box-sizing:border-box; } .wide { grid-column:1/-1; }
  textarea { width:100%; min-height:130px; padding:9px; box-sizing:border-box; resize:vertical; font:12px/1.4 ui-monospace,monospace; }
  .primary { width:100%; margin-top:8px; } .retry { margin-top:8px; color:#ffb8c3; border-color:#63313b; }
  .status { margin-top:10px; color:#8cdcff; } .error { padding:9px; white-space:pre-wrap; color:#ff8fa2; background:#1b0d12; border:1px solid #5c2933; }
  .rows { display:grid; gap:5px; margin-top:12px; } .rows article { display:grid; grid-template-columns:auto minmax(0,1fr) auto minmax(100px,1fr); gap:7px; align-items:center; padding:7px; background:#0b141c; border-radius:5px; }
  .dot { width:7px; height:7px; border-radius:50%; background:#667; } .dot.connected { background:#40d98b; } .dot.checking { background:#47b9ff; } .dot.error { background:#ff647c; } .bad { color:#ffb3be; }
</style>
