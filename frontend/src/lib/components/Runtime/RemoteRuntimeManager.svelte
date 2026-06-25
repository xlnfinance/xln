<script lang="ts">
  import { onMount } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { Check, Link, Upload } from 'lucide-svelte';
  import { runtimeOperations } from '$lib/stores/runtimeStore';
  import {
    MAX_REMOTE_RUNTIME_IMPORTS,
    REMOTE_RUNTIME_IMPORT_HASH_PARAM,
    REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY,
    REMOTE_RUNTIME_IMPORT_SOURCE_HASH_PARAM,
    formatRemoteRuntimeImportLines,
    normalizeRemoteRuntimeWsUrl,
    parseRemoteRuntimeImportPayload,
    parseRemoteRuntimeImportSourcePayload,
    parseRemoteRuntimeImportText,
    type RemoteRuntimeImportAccess,
    type RemoteRuntimeImportEntry,
    type StoredRemoteRuntimeImportEntry,
  } from '$lib/utils/remoteRuntimeImport';
  import { validateRemoteRuntimeEntry } from '$lib/utils/remoteRuntimeValidation';

  type ImportMode = 'single' | 'bulk';

  type ImportRow = {
    index: number;
    label: string;
    access: RemoteRuntimeImportAccess;
    wsUrl: string;
    status: 'pending' | 'checking' | 'connected' | 'error';
    detail: string;
  };

  const dispatch = createEventDispatcher<{ imported: { runtimeId: string; count: number } }>();

  let mode: ImportMode = 'bulk';
  let label = '';
  let access: RemoteRuntimeImportAccess = 'read';
  let wsUrl = '';
  let token = '';
  let bulkText = '';
  let rows: ImportRow[] = [];
  let status = '';
  let error = '';
  let working = false;

  const errorMessage = (value: unknown): string => value instanceof Error ? value.message : String(value || 'Remote runtime import failed');

  const buildSingleEntry = (): RemoteRuntimeImportEntry => {
    const normalizedWsUrl = normalizeRemoteRuntimeWsUrl(wsUrl);
    const normalizedToken = token.trim();
    if (!normalizedToken.startsWith('xlnra1.')) throw new Error('REMOTE_RUNTIME_IMPORT_TOKEN_INVALID:1');
    return {
      label: label.trim() || new URL(normalizedWsUrl).host,
      access,
      wsUrl: normalizedWsUrl,
      token: normalizedToken,
    };
  };

  const setRow = (index: number, patch: Partial<ImportRow>): void => {
    rows = rows.map((row) => row.index === index ? { ...row, ...patch } : row);
  };

  const resetRows = (entries: RemoteRuntimeImportEntry[]): void => {
    rows = entries.map((entry, index) => ({
      index,
      label: entry.label,
      access: entry.access,
      wsUrl: entry.wsUrl,
      status: 'pending',
      detail: 'waiting',
    }));
  };

  const readImportPayloadFromHash = (): string => {
    if (typeof window === 'undefined') return '';
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (!hash.trim()) return '';
    const params = new URLSearchParams(hash);
    return String(
      params.get(REMOTE_RUNTIME_IMPORT_HASH_PARAM) ||
      params.get('runtimeList') ||
      params.get('runtime-list') ||
      params.get('runtimeImport') ||
      params.get('runtimes') ||
      params.get('remote-runtimes') ||
      params.get('xlnRemoteRuntimes') ||
      '',
    ).trim();
  };

  const readImportSourceFromHash = (): string => {
    if (typeof window === 'undefined') return '';
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (!hash.trim()) return '';
    const params = new URLSearchParams(hash);
    return String(params.get(REMOTE_RUNTIME_IMPORT_SOURCE_HASH_PARAM) || '').trim();
  };

  const fetchImportSource = async (source: string): Promise<RemoteRuntimeImportEntry[]> => {
    const url = new URL(source, window.location.href);
    if (url.origin !== window.location.origin) {
      throw new Error(`REMOTE_RUNTIME_IMPORT_SOURCE_ORIGIN_INVALID:${url.origin}`);
    }
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`REMOTE_RUNTIME_IMPORT_SOURCE_FAILED:${response.status}`);
    return parseRemoteRuntimeImportSourcePayload(await response.json());
  };

  const scrubImportHash = (): void => {
    if (typeof window === 'undefined' || !window.location.hash) return;
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  };

  const writeImportSummary = (
    validated: StoredRemoteRuntimeImportEntry[],
    total: number,
    importedAt: number,
  ): void => {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY, JSON.stringify({
      ok: true,
      importedAt,
      count: validated.length,
      total,
      entries: validated.map(entry => ({
        label: entry.label,
        access: entry.access,
        wsUrl: entry.wsUrl,
        runtimeId: entry.runtimeId,
        height: entry.height,
        entityCount: entry.entityCount,
      })),
    }));
  };

  const prefillFromHash = async (): Promise<void> => {
    const payload = readImportPayloadFromHash();
    const source = readImportSourceFromHash();
    if (!payload && !source) return;
    mode = 'bulk';
    try {
      status = source ? 'Loading import list' : status;
      const entries = source
        ? await fetchImportSource(source)
        : parseRemoteRuntimeImportPayload(payload);
      bulkText = formatRemoteRuntimeImportLines(entries);
      resetRows(entries);
      status = `Ready to import ${entries.length} remote runtime${entries.length === 1 ? '' : 's'}`;
      error = '';
    } catch (err) {
      bulkText = payload;
      rows = [];
      status = 'Import list needs review';
      error = errorMessage(err);
    } finally {
      scrubImportHash();
    }
  };

  const importEntries = async (entries: RemoteRuntimeImportEntry[]): Promise<void> => {
    if (working) return;
    working = true;
    error = '';
    status = `Checking ${entries.length} remote runtime${entries.length === 1 ? '' : 's'}`;
    resetRows(entries);
    try {
      const importedAt = Date.now();
      const validated: StoredRemoteRuntimeImportEntry[] = [];
      for (const [index, entry] of entries.entries()) {
        status = `Checking ${entry.label || entry.wsUrl}`;
        validated.push(await validateRemoteRuntimeEntry(entry, {
          index,
          importedAt,
          onProgress: (progress) => setRow(progress.index, {
            status: progress.status,
            detail: progress.detail,
          }),
        }));
      }
      if (validated.length === 0) throw new Error('REMOTE_RUNTIME_IMPORT_EMPTY');
      const persisted = runtimeOperations.upsertRemoteRuntimeImports(validated);
      writeImportSummary(validated, persisted.length, importedAt);
      status = `Imported ${validated.length} remote runtime${validated.length === 1 ? '' : 's'}`;
      const first = validated[0]!;
      dispatch('imported', { runtimeId: first.runtimeId, count: validated.length });
      runtimeOperations.activateRemoteRuntime(first.runtimeId, { href: '/app' });
    } catch (err) {
      error = errorMessage(err);
      status = 'Import failed';
    } finally {
      working = false;
    }
  };

  async function importSingle(): Promise<void> {
    await importEntries([buildSingleEntry()]);
  }

  async function importBulk(): Promise<void> {
    await importEntries(parseRemoteRuntimeImportText(bulkText));
  }

  onMount(() => {
    void prefillFromHash();
  });
</script>

<section class="manager" data-testid="remote-runtime-manager">
  <div class="mode-tabs" role="tablist" aria-label="Remote runtime import mode">
    <button type="button" class:active={mode === 'single'} on:click={() => mode = 'single'}>
      <Link size={13} />
      <span>Attach</span>
    </button>
    <button type="button" class:active={mode === 'bulk'} on:click={() => mode = 'bulk'}>
      <Upload size={13} />
      <span>Bulk</span>
    </button>
  </div>

  {#if mode === 'single'}
    <div class="single-grid">
      <input data-testid="remote-runtime-label" bind:value={label} placeholder="Label" autocomplete="off" />
      <select data-testid="remote-runtime-access" bind:value={access}>
        <option value="read">read</option>
        <option value="admin">admin</option>
      </select>
      <input data-testid="remote-runtime-ws" bind:value={wsUrl} placeholder="ws://localhost:8080/rpc" autocomplete="off" />
      <input data-testid="remote-runtime-token" bind:value={token} placeholder="xlnra1..." autocomplete="off" type="password" />
      <button data-testid="remote-runtime-attach" type="button" disabled={working} on:click={() => void importSingle()}>
        <Check size={14} />
        <span>{working ? 'Checking' : 'Attach'}</span>
      </button>
    </div>
  {:else}
    <textarea
      data-testid="remote-runtime-bulk-textarea"
      bind:value={bulkText}
      spellcheck="false"
      placeholder="H1 | read | ws://localhost:8080/rpc | xlnra1..."
    ></textarea>
    <button class="bulk-button" data-testid="remote-runtime-bulk-confirm" type="button" disabled={working} on:click={() => void importBulk()}>
      <Check size={14} />
      <span>{working ? 'Checking' : `Import up to ${MAX_REMOTE_RUNTIME_IMPORTS}`}</span>
    </button>
  {/if}

  {#if status}
    <div class="manager-status" data-testid="remote-runtime-manager-status">{status}</div>
  {/if}
  {#if error}
    <div class="manager-error" data-testid="remote-runtime-manager-error">{error}</div>
  {/if}

  {#if rows.length > 0}
    <div class="row-list" data-testid="remote-runtime-manager-rows">
      {#each rows as row (row.index)}
        <div class="row" class:error={row.status === 'error'} class:connected={row.status === 'connected'}>
          <span class="row-dot {row.status}"></span>
          <span class="row-label" title={row.wsUrl}>{row.label}</span>
          <span class="row-access">{row.access}</span>
          <span class="row-detail">{row.detail}</span>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .manager {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .mode-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
  }

  .mode-tabs button,
  .single-grid button,
  .bulk-button {
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid rgba(122, 168, 255, 0.24);
    border-radius: 6px;
    background: rgba(122, 168, 255, 0.08);
    color: #dbeafe;
    font-size: 12px;
    cursor: pointer;
  }

  .mode-tabs button.active {
    background: rgba(122, 168, 255, 0.18);
    border-color: rgba(122, 168, 255, 0.48);
    color: #fff;
  }

  .single-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 86px;
    gap: 6px;
  }

  .single-grid input,
  .single-grid select,
  textarea {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.22);
    color: #e5e7eb;
    font-size: 12px;
    outline: none;
  }

  .single-grid input,
  .single-grid select {
    height: 30px;
    padding: 0 8px;
  }

  .single-grid input:nth-of-type(2) {
    grid-column: 1 / -1;
  }

  .single-grid input:nth-of-type(3) {
    grid-column: 1 / -1;
  }

  .single-grid button {
    grid-column: 1 / -1;
  }

  textarea {
    min-height: 112px;
    resize: vertical;
    padding: 8px;
    font-family: "SF Mono", ui-monospace, monospace;
    line-height: 1.35;
  }

  .bulk-button {
    width: 100%;
  }

  button:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  .manager-status,
  .manager-error {
    font-size: 11px;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  .manager-status {
    color: #93c5fd;
  }

  .manager-error {
    color: #fca5a5;
  }

  .row-list {
    max-height: 160px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto minmax(96px, 1.4fr);
    gap: 6px;
    align-items: center;
    padding: 5px 6px;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.035);
    color: #a1a1aa;
    font-size: 11px;
  }

  .row.connected {
    color: #bbf7d0;
  }

  .row.error {
    color: #fecaca;
  }

  .row-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #52525b;
  }

  .row-dot.checking {
    background: #60a5fa;
  }

  .row-dot.connected {
    background: #4ade80;
  }

  .row-dot.error {
    background: #ef4444;
  }

  .row-label,
  .row-detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-access {
    color: #7aa8ff;
    font-family: "SF Mono", ui-monospace, monospace;
  }
</style>
