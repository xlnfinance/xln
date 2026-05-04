<script lang="ts">
  import { onMount } from 'svelte';
  import { compareStableText } from '$lib/utils/stableSort';

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

  const formatBytes = (byteLength: number): string => {
    if (!Number.isFinite(byteLength) || byteLength < 0) return '-';
    if (byteLength < 1024) return `${byteLength}b`;
    if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)}KB`;
    return `${(byteLength / (1024 * 1024)).toFixed(2)}MB`;
  };

  const bytesToHex = (bytes: Uint8Array, maxBytes = 64): string => {
    const slice = bytes.slice(0, maxBytes);
    const hex = Array.from(slice, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return bytes.length > maxBytes ? `${hex}...` : hex;
  };

  const bytesToFullHex = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  const readU64 = (bytes: Uint8Array, offset = 1): number | null => {
    if (bytes.byteLength < offset + 8) return null;
    return Number(new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, false));
  };

  const readEntityId = (bytes: Uint8Array, offset: number): string | null => {
    if (bytes.byteLength < offset + 32) return null;
    return `0x${bytesToFullHex(bytes.slice(offset, offset + 32))}`;
  };

  const readTextAt = (bytes: Uint8Array, offset: number): string | null => {
    if (bytes.byteLength < offset + 2) return null;
    const len = new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false);
    if (bytes.byteLength < offset + 2 + len) return null;
    return textDecoder.decode(bytes.slice(offset + 2, offset + 2 + len));
  };

  const decodeStorageKey = (bytes: Uint8Array): string | null => {
    const tag = bytes[0];
    const height = readU64(bytes, 1);
    if (tag === 0x20 && bytes.byteLength === 1) return 'head';
    if (tag === 0x10 && height !== null) return `frame/${height}`;
    if (tag === 0x11 && height !== null) return `diff/${height}`;
    if (tag === 0x12 && height !== null && bytes.byteLength === 9) return `snapshot/manifest/${height}`;
    if (tag === 0x21) return `live/entity/${readEntityId(bytes, 1) ?? bytesToFullHex(bytes)}`;
    if (tag === 0x22) {
      const entityId = readEntityId(bytes, 1);
      const counterpartyId = readEntityId(bytes, 33);
      if (entityId && counterpartyId) return `live/account/${entityId}/${counterpartyId}`;
    }
    if (tag === 0x23) {
      const entityId = readEntityId(bytes, 1);
      const pairId = readTextAt(bytes, 33);
      if (entityId && pairId) return `live/book/${entityId}/${pairId}`;
    }
    if (tag === 0x26) return `live/replica-meta/${readEntityId(bytes, 1) ?? bytesToFullHex(bytes)}`;
    if (tag === 0x27 || tag === 0x28 || tag === 0x29) {
      const family = tag === 0x27 ? 'merkle/root' : tag === 0x28 ? 'merkle/branch' : 'merkle/leaf';
      const entityId = readEntityId(bytes, 1);
      const namespace = readTextAt(bytes, 33);
      if (entityId && namespace) return `${family}/${entityId}/${namespace}`;
    }
    if (tag === 0x31 || tag === 0x32 || tag === 0x33) {
      const family = tag === 0x31 ? 'snapshot/entity' : tag === 0x32 ? 'snapshot/account' : 'snapshot/book';
      const entityId = readEntityId(bytes, 9);
      if (height !== null && entityId) return `${family}/${height}/${entityId}`;
    }
    if (tag === 0x00 && bytes.byteLength === 1) return 'frame-db/head';
    if (tag === 0x01 && bytes.byteLength >= 73) {
      return `frame-db/account/${readEntityId(bytes, 1)}/${readEntityId(bytes, 33)}/${readU64(bytes, 65) ?? '?'}`;
    }
    if (tag === 0x02 && height !== null) return `frame-db/runtime-activity/${height}`;
    if (tag === 0x03 && bytes.byteLength >= 41) {
      return `frame-db/entity-activity/${readEntityId(bytes, 1)}/${readU64(bytes, 33) ?? '?'}`;
    }
    if (tag === 0x04 && bytes.byteLength >= 81) {
      return `frame-db/account-by-runtime/${height ?? '?'}/${readEntityId(bytes, 9)}/${readEntityId(bytes, 41)}/${readU64(bytes, 73) ?? '?'}`;
    }
    if (tag === 0x05 && bytes.byteLength >= 41) {
      return `frame-db/orderbook/${height ?? '?'}/${readEntityId(bytes, 9)}/${readTextAt(bytes, 41) ?? '?'}`;
    }
    return null;
  };

  const compactValuePreview = (blob: DecodedBlob): string => {
    const text = blob.pretty || blob.preview;
    return text.length > 900 ? `${text.slice(0, 900)}...` : text;
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

  const decodeKeyBlob = (value: unknown): DecodedBlob => {
    const bytes = asUint8Array(value);
    if (bytes) {
      const decoded = decodeStorageKey(bytes);
      const hex = bytesToFullHex(bytes);
      return {
        label: decoded ? `${decoded} [${hex}]` : hex,
        preview: hex,
        pretty: null,
        byteLength: bytes.byteLength,
      };
    }
    const decoded = decodeBlob(value);
    return {
      ...decoded,
      label: decoded.preview,
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
    return Array.from(merged.values()).sort((a, b) => compareStableText(a.name, b.name));
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
      objectStoreNames = Array.from(db.objectStoreNames).sort(compareStableText);
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
                key: decodeKeyBlob(cursor.key),
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
              <article class="entry-card">
                <div class="entry-row">
                  <span class="entry-index">#{entry.index}</span>
                  <code class="entry-key">{entry.key.label}</code>
                  <span class="entry-bytes">({formatBytes(entry.value.byteLength)})</span>
                </div>
                <pre class="entry-preview">{compactValuePreview(entry.value)}</pre>
                <details class="entry-expand">
                  <summary>Expand value</summary>
                  <pre>{entry.value.pretty || entry.value.preview}</pre>
                </details>
              </article>
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
  .db-content h4 {
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
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.2);
    overflow: hidden;
  }

  .entry-row {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
    padding: 10px 12px;
  }

  .entry-index,
  .entry-bytes {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.55);
    white-space: nowrap;
  }

  .entry-key {
    min-width: 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.88);
    white-space: normal;
    word-break: break-all;
  }

  .entry-preview,
  .entry-expand pre {
    margin: 0;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.84);
    font-size: 11px;
    line-height: 1.5;
    overflow: auto;
    max-height: 320px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .entry-preview {
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    max-height: 160px;
  }

  .entry-expand {
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .entry-expand summary {
    padding: 8px 12px;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.62);
    font-size: 11px;
  }

  .entry-expand pre {
    max-height: none;
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
