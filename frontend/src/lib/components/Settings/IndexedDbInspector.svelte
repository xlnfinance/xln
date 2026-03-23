<script lang="ts">
  import { onMount } from 'svelte';

  type DbKindFilter = 'all' | 'core' | 'infra';

  type DecodedBlob = {
    label: string;
    preview: string;
    pretty: string | null;
    byteLength: number;
  };

  type DbEntryView = {
    index: number;
    key: DecodedBlob;
    value: DecodedBlob;
  };

  type IndexedDbMeta = {
    name: string;
    version?: number;
  };

  export let databaseNames: string[] = [];
  export let databaseNamePrefixes: string[] = ['level-js-db-'];
  export let pageSize = 50;

  const textDecoder = new TextDecoder();
  const indexedDbWithListing = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string; version?: number }>>;
  };

  let loadingDatabases = false;
  let loadingEntries = false;
  let inspectorError = '';
  let discoveredDatabases: IndexedDbMeta[] = [];
  let selectedKind: DbKindFilter = 'all';
  let selectedDatabaseName = '';
  let objectStoreNames: string[] = [];
  let selectedObjectStore = '';
  let entries: DbEntryView[] = [];
  let loadedCount = 0;
  let hasMoreEntries = false;

  const normalizeName = (value: string): string => value.trim();

  const bytesToHex = (bytes: Uint8Array, maxBytes = 64): string => {
    const slice = bytes.slice(0, maxBytes);
    const hex = Array.from(slice, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return bytes.length > maxBytes ? `${hex}...` : hex;
  };

  const isPrintableText = (text: string): boolean => {
    if (!text) return false;
    let printable = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 && code <= 126) ||
        code >= 160
      ) {
        printable += 1;
      }
    }
    return printable / text.length > 0.9;
  };

  const tryPrettyJson = (text: string): string | null => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) {
      return null;
    }
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return null;
    }
  };

  const asUint8Array = (value: unknown): Uint8Array | null => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  };

  const decodeBlob = (value: unknown): DecodedBlob => {
    if (typeof value === 'string') {
      const pretty = tryPrettyJson(value);
      return {
        label: value.length > 160 ? `${value.slice(0, 160)}...` : value,
        preview: value,
        pretty,
        byteLength: value.length,
      };
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
      const text = String(value);
      return {
        label: text,
        preview: text,
        pretty: null,
        byteLength: text.length,
      };
    }
    const bytes = asUint8Array(value);
    if (!bytes) {
      const text = JSON.stringify(value, null, 2);
      return {
        label: text.length > 160 ? `${text.slice(0, 160)}...` : text,
        preview: text,
        pretty: text,
        byteLength: text.length,
      };
    }
    const decodedText = textDecoder.decode(bytes);
    if (isPrintableText(decodedText)) {
      const pretty = tryPrettyJson(decodedText);
      const label = pretty ? 'json' : (decodedText.length > 160 ? `${decodedText.slice(0, 160)}...` : decodedText);
      return {
        label,
        preview: decodedText,
        pretty,
        byteLength: bytes.byteLength,
      };
    }
    const hex = bytesToHex(bytes);
    return {
      label: `binary ${bytes.byteLength}b`,
      preview: hex,
      pretty: null,
      byteLength: bytes.byteLength,
    };
  };

  const formatDatabaseKind = (name: string): 'core' | 'infra' => (
    name.endsWith('-infra') ? 'infra' : 'core'
  );

  const matchesPrefix = (name: string): boolean => (
    databaseNamePrefixes.length === 0 || databaseNamePrefixes.some((prefix) => name.startsWith(prefix))
  );

  const openDatabase = (name: string): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error || new Error(`Failed to open IndexedDB ${name}`));
    request.onsuccess = () => resolve(request.result);
  });

  const listIndexedDatabases = async (): Promise<IndexedDbMeta[]> => {
    const provided = databaseNames
      .map(normalizeName)
      .filter(Boolean)
      .map((name) => ({ name }));
    const discovered = indexedDbWithListing.databases
      ? (await indexedDbWithListing.databases())
          .filter((entry): entry is { name: string; version?: number } => typeof entry.name === 'string' && !!entry.name)
          .map((entry) => ({ name: entry.name, version: entry.version }))
      : [];
    const merged = new Map<string, IndexedDbMeta>();
    for (const entry of [...provided, ...discovered]) {
      if (!matchesPrefix(entry.name)) continue;
      merged.set(entry.name, entry);
    }
    return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
  };

  async function refreshDatabaseList(): Promise<void> {
    loadingDatabases = true;
    inspectorError = '';
    try {
      discoveredDatabases = await listIndexedDatabases();
      if (!selectedDatabaseName || !discoveredDatabases.some((db) => db.name === selectedDatabaseName)) {
        selectedDatabaseName = filteredDatabases[0]?.name || '';
      }
    } catch (error) {
      inspectorError = error instanceof Error ? error.message : String(error);
      discoveredDatabases = [];
      selectedDatabaseName = '';
    } finally {
      loadingDatabases = false;
    }
  }

  async function loadObjectStores(databaseName: string): Promise<void> {
    if (!databaseName) {
      objectStoreNames = [];
      selectedObjectStore = '';
      return;
    }
    const db = await openDatabase(databaseName);
    try {
      objectStoreNames = Array.from(db.objectStoreNames).sort((a, b) => a.localeCompare(b));
      if (!selectedObjectStore || !objectStoreNames.includes(selectedObjectStore)) {
        selectedObjectStore = objectStoreNames[0] || '';
      }
    } finally {
      db.close();
    }
  }

  async function loadEntries(reset = false): Promise<void> {
    if (!selectedDatabaseName || !selectedObjectStore) {
      entries = [];
      loadedCount = 0;
      hasMoreEntries = false;
      return;
    }
    loadingEntries = true;
    inspectorError = '';
    const startIndex = reset ? 0 : loadedCount;
    try {
      const db = await openDatabase(selectedDatabaseName);
      try {
        const transaction = db.transaction(selectedObjectStore, 'readonly');
        const store = transaction.objectStore(selectedObjectStore);
        const request = store.openCursor();
        const pageEntries: DbEntryView[] = [];
        let cursorIndex = 0;

        await new Promise<void>((resolve, reject) => {
          request.onerror = () => reject(request.error || new Error('Failed to read IndexedDB entries'));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve();
              return;
            }
            if (cursorIndex >= startIndex && pageEntries.length < pageSize) {
              pageEntries.push({
                index: cursorIndex,
                key: decodeBlob(cursor.key),
                value: decodeBlob(cursor.value),
              });
            }
            cursorIndex += 1;
            if (pageEntries.length >= pageSize) {
              hasMoreEntries = true;
              resolve();
              return;
            }
            cursor.continue();
          };
        });

        if (reset) {
          entries = pageEntries;
        } else {
          entries = [...entries, ...pageEntries];
        }
        loadedCount = startIndex + pageEntries.length;
        if (pageEntries.length < pageSize) {
          hasMoreEntries = false;
        }
      } finally {
        db.close();
      }
    } catch (error) {
      inspectorError = error instanceof Error ? error.message : String(error);
      if (reset) {
        entries = [];
        loadedCount = 0;
      }
      hasMoreEntries = false;
    } finally {
      loadingEntries = false;
    }
  }

  $: filteredDatabases = discoveredDatabases.filter((db) => (
    selectedKind === 'all' || formatDatabaseKind(db.name) === selectedKind
  ));

  $: if (selectedDatabaseName && !filteredDatabases.some((db) => db.name === selectedDatabaseName)) {
    selectedDatabaseName = filteredDatabases[0]?.name || '';
  }

  $: if (selectedDatabaseName) {
    void loadObjectStores(selectedDatabaseName);
  } else {
    objectStoreNames = [];
    selectedObjectStore = '';
    entries = [];
    loadedCount = 0;
    hasMoreEntries = false;
  }

  $: if (selectedDatabaseName && selectedObjectStore) {
    void loadEntries(true);
  }

  onMount(() => {
    void refreshDatabaseList();
  });
</script>

<div class="db-inspector">
  <div class="toolbar">
    <div class="filter-group">
      <button class:selected={selectedKind === 'all'} on:click={() => selectedKind = 'all'}>All</button>
      <button class:selected={selectedKind === 'core'} on:click={() => selectedKind = 'core'}>Core</button>
      <button class:selected={selectedKind === 'infra'} on:click={() => selectedKind = 'infra'}>Infra</button>
    </div>
    <button class="refresh-btn" on:click={() => void refreshDatabaseList()} disabled={loadingDatabases}>
      {loadingDatabases ? 'Refreshing...' : 'Refresh DBs'}
    </button>
  </div>

  {#if inspectorError}
    <p class="error-text">{inspectorError}</p>
  {/if}

  <div class="inspector-grid">
    <div class="db-list">
      <h4>Databases</h4>
      {#if filteredDatabases.length === 0}
        <p class="muted">No matching IndexedDB databases found.</p>
      {:else}
        {#each filteredDatabases as database}
          <button
            class="db-item"
            class:active={database.name === selectedDatabaseName}
            on:click={() => selectedDatabaseName = database.name}
          >
            <span class="db-name">{database.name}</span>
            <span class="db-kind">{formatDatabaseKind(database.name)}</span>
          </button>
        {/each}
      {/if}
    </div>

    <div class="db-content">
      {#if !selectedDatabaseName}
        <div class="empty-state">Select a database to inspect.</div>
      {:else}
        <div class="db-header">
          <div>
            <h4>{selectedDatabaseName}</h4>
            <p class="muted">Object stores are read lazily. Large values stay collapsed until expanded.</p>
          </div>
          <label class="store-select">
            <span>Store</span>
            <select bind:value={selectedObjectStore} disabled={objectStoreNames.length === 0}>
              {#each objectStoreNames as storeName}
                <option value={storeName}>{storeName}</option>
              {/each}
            </select>
          </label>
        </div>

        {#if loadingEntries && entries.length === 0}
          <div class="empty-state">Loading entries...</div>
        {:else if entries.length === 0}
          <div class="empty-state">No entries in this object store.</div>
        {:else}
          <div class="entry-list">
            {#each entries as entry}
              <details class="entry-card">
                <summary>
                  <span class="entry-index">#{entry.index}</span>
                  <span class="entry-key">{entry.key.label}</span>
                  <span class="entry-bytes">{entry.value.byteLength}b</span>
                </summary>
                <div class="entry-body">
                  <div class="entry-block">
                    <h5>Key</h5>
                    <pre>{entry.key.pretty || entry.key.preview}</pre>
                  </div>
                  <div class="entry-block">
                    <h5>Value</h5>
                    <pre>{entry.value.pretty || entry.value.preview}</pre>
                  </div>
                </div>
              </details>
            {/each}
          </div>

          {#if hasMoreEntries}
            <button class="load-more-btn" on:click={() => void loadEntries(false)} disabled={loadingEntries}>
              {loadingEntries ? 'Loading...' : `Load ${pageSize} more`}
            </button>
          {/if}
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .db-inspector {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .filter-group {
    display: flex;
    gap: 8px;
  }

  .filter-group button,
  .refresh-btn,
  .load-more-btn,
  .db-item {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.82);
    border-radius: 8px;
    cursor: pointer;
  }

  .filter-group button,
  .refresh-btn,
  .load-more-btn {
    padding: 8px 12px;
    font-size: 12px;
  }

  .filter-group button.selected,
  .db-item.active {
    border-color: rgba(255, 200, 100, 0.5);
    background: rgba(255, 200, 100, 0.12);
    color: rgba(255, 220, 170, 0.98);
  }

  .inspector-grid {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 16px;
  }

  .db-list,
  .db-content {
    min-height: 240px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.025);
    padding: 12px;
  }

  .db-list h4,
  .db-content h4,
  .entry-block h5 {
    margin: 0;
    color: rgba(255, 255, 255, 0.92);
  }

  .db-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .db-item {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 10px 12px;
    text-align: left;
  }

  .db-name {
    font-size: 12px;
    line-height: 1.4;
    word-break: break-word;
  }

  .db-kind,
  .muted {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.48);
  }

  .db-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .store-select {
    min-width: 180px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.56);
  }

  .store-select select {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.24);
    color: rgba(255, 255, 255, 0.9);
  }

  .entry-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .entry-card {
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.2);
    overflow: hidden;
  }

  .entry-card summary {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    list-style: none;
    cursor: pointer;
    padding: 10px 12px;
  }

  .entry-card summary::-webkit-details-marker {
    display: none;
  }

  .entry-index,
  .entry-bytes {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.55);
  }

  .entry-key {
    min-width: 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.88);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 0 12px 12px;
  }

  .entry-block {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .entry-block pre {
    margin: 0;
    padding: 10px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.84);
    font-size: 11px;
    line-height: 1.5;
    overflow: auto;
    max-height: 320px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .empty-state,
  .error-text {
    padding: 12px;
    border-radius: 10px;
    font-size: 12px;
  }

  .empty-state {
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.56);
  }

  .error-text {
    background: rgba(255, 90, 90, 0.12);
    color: rgba(255, 160, 160, 0.94);
  }

  @media (max-width: 900px) {
    .inspector-grid {
      grid-template-columns: 1fr;
    }

    .db-header,
    .entry-body,
    .toolbar {
      grid-template-columns: 1fr;
      flex-direction: column;
      align-items: stretch;
    }

    .store-select {
      min-width: 0;
    }
  }
</style>
