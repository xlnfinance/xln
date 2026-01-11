<script lang="ts">
  /**
   * Jurisdiction Panel - Time-travel aware J-Machine viewer
   * Shows jurisdiction data from the CURRENT FRAME (respects time machine)
   * Features: dropdown selector, entity reserves, collaterals
   */

  import type { Writable } from 'svelte/store';
  import { get } from 'svelte/store';
  import { panelBridge } from '../utils/panelBridge';
  import { activeVault, allVaults } from '$lib/stores/vaultStore';
  import { xlnFunctions, xlnInstance } from '$lib/stores/xlnStore';

  // Props
  interface Props {
    isolatedEnv: Writable<any>;
    isolatedHistory?: Writable<any[]> | undefined;
    isolatedTimeIndex?: Writable<number> | undefined;
    selectedJurisdiction?: string | null;
    hideSelector?: boolean;
  }

  let {
    isolatedEnv,
    isolatedHistory = undefined,
    isolatedTimeIndex = undefined,
    selectedJurisdiction = $bindable<string | null>(null),
    hideSelector = false,
  }: Props = $props();

  // Tab state
  let activeTab = $state<'overview' | 'balances'>('balances'); // Start with Balances

  type TokenOption = {
    tokenId: number;
    symbol: string;
    decimals: number;
    address: string | undefined;
    name: string | undefined;
  };

  type SignerRef = {
    address: string;
    label: string;
    vaultId: string;
    signerName: string;
  };

  let selectedTokenIdText = $state('');
  let browserVmTokens = $state<TokenOption[]>([]);
  let externalBalances = $state<Array<{ address: string; label: string; balance: bigint }>>([]);
  let externalBalancesLoading = $state(false);
  let externalBalancesError = $state<string | null>(null);
  let balanceRequestId = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  //          TIME-TRAVEL AWARE DATA DERIVATION
  // ═══════════════════════════════════════════════════════════════════════════

  // Get current frame based on timeIndex
  function getCurrentFrame(): any {
    const timeIndex = isolatedTimeIndex ? get(isolatedTimeIndex) : -1;
    const history = isolatedHistory ? get(isolatedHistory) : [];
    const env = get(isolatedEnv);

    if (timeIndex >= 0 && history && history.length > 0) {
      const idx = Math.min(timeIndex, history.length - 1);
      return history[idx];
    }
    return env; // Live mode - return env directly
  }

  let isLive = $derived.by(() => {
    const timeIndex = isolatedTimeIndex ? ($isolatedTimeIndex ?? -1) : -1;
    return timeIndex < 0;
  });

  // Get jurisdictions from current frame
  let jurisdictions = $derived.by(() => {
    const timeIndex = isolatedTimeIndex ? ($isolatedTimeIndex ?? -1) : -1;
    const history = isolatedHistory ? $isolatedHistory : [];
    const env = $isolatedEnv;

    // From historical frame
    if (timeIndex >= 0 && history && history.length > 0) {
      const idx = Math.min(timeIndex as number, history.length - 1);
      const frame = history[idx];
      // EnvSnapshot has jReplicas as array
      return frame?.jReplicas || [];
    }

    // From live env (jReplicas is a Map)
    if (env?.jReplicas) {
      if (env.jReplicas instanceof Map) {
        return Array.from(env.jReplicas.values());
      }
      return env.jReplicas;
    }

    return [];
  });

  // Auto-select first jurisdiction when available
  $effect(() => {
    if (jurisdictions.length > 0 && !selectedJurisdiction) {
      selectedJurisdiction = jurisdictions[0].name;
      console.log(`[J-Panel] Auto-selected jurisdiction: ${selectedJurisdiction}`);
    }
    // Reset selection if current selection no longer exists
    if (selectedJurisdiction && !jurisdictions.find((j: any) => j.name === selectedJurisdiction)) {
      selectedJurisdiction = jurisdictions.length > 0 ? jurisdictions[0].name : null;
    }
  });

  // Get selected jurisdiction data
  let selectedJurisdictionData = $derived.by(() => {
    if (!selectedJurisdiction) return null;
    return jurisdictions.find((j: any) => j.name === selectedJurisdiction) || null;
  });

  // Get entity names from current frame
  function getEntityNames(): Map<string, string> {
    const names = new Map<string, string>();
    const timeIndex = isolatedTimeIndex ? ($isolatedTimeIndex ?? -1) : -1;
    const history = isolatedHistory ? $isolatedHistory : [];
    const env = $isolatedEnv;

    let eReplicas: Map<string, any> | null = null;

    if (timeIndex >= 0 && history && history.length > 0) {
      const idx = Math.min(timeIndex as number, history.length - 1);
      eReplicas = history[idx]?.eReplicas;
    } else {
      eReplicas = env?.eReplicas;
    }

    if (eReplicas) {
      const entries = eReplicas instanceof Map ? Array.from(eReplicas.entries()) : Object.entries(eReplicas);
      for (const [key, replica] of entries) {
        const entityId = key.split(':')[0];
        if (entityId && !names.has(entityId)) {
          names.set(entityId, (replica as any)?.name || `E${entityId.slice(-4)}`);
        }
      }
    }

    return names;
  }

  let entityNames = $derived(getEntityNames());

  // Get reserves from selected jurisdiction
  let reserves = $derived.by(() => {
    if (!selectedJurisdictionData?.reserves) return [];
    const result: Array<{ entityId: string; name: string; tokenId: number; amount: bigint }> = [];

    const reservesMap = selectedJurisdictionData.reserves instanceof Map
      ? selectedJurisdictionData.reserves
      : new Map(Object.entries(selectedJurisdictionData.reserves || {}));

    for (const [entityId, tokenMap] of reservesMap.entries()) {
      const tokens = tokenMap instanceof Map ? tokenMap : new Map(Object.entries(tokenMap || {}));
      for (const [tokenId, amount] of tokens.entries()) {
        if (amount > 0n) {
          result.push({
            entityId,
            name: entityNames.get(entityId) || `E${entityId.slice(-4)}`,
            tokenId: Number(tokenId),
            amount: BigInt(amount),
          });
        }
      }
    }

    return result;
  });

  // Get collaterals from selected jurisdiction
  let collaterals = $derived.by(() => {
    if (!selectedJurisdictionData?.collaterals) return [];
    const result: Array<{ channelKey: string; tokenId: number; collateral: bigint; ondelta: bigint }> = [];

    const collMap = selectedJurisdictionData.collaterals instanceof Map
      ? selectedJurisdictionData.collaterals
      : new Map(Object.entries(selectedJurisdictionData.collaterals || {}));

    for (const [channelKey, tokenMap] of collMap.entries()) {
      const tokens = tokenMap instanceof Map ? tokenMap : new Map(Object.entries(tokenMap || {}));
      for (const [tokenId, data] of tokens.entries()) {
        if (data && (data.collateral > 0n || data.ondelta !== 0n)) {
          result.push({
            channelKey,
            tokenId: Number(tokenId),
            collateral: BigInt(data.collateral || 0),
            ondelta: BigInt(data.ondelta || 0),
          });
        }
      }
    }

    return result;
  });

  // Get mempool from selected jurisdiction
  let mempool = $derived.by(() => {
    if (!selectedJurisdictionData?.mempool) return [];
    return selectedJurisdictionData.mempool;
  });

  $effect(() => {
    const xln = $xlnInstance;
    if (!xln?.getBrowserVMInstance) {
      browserVmTokens = [];
      return;
    }
    const browserVM = xln.getBrowserVMInstance();
    if (!browserVM?.getTokenRegistry) {
      browserVmTokens = [];
      return;
    }
    const registry = browserVM.getTokenRegistry();
    browserVmTokens = Array.isArray(registry) ? registry : [];
  });

  let tokenOptions = $derived.by(() => {
    const options = new Map<number, TokenOption>();

    for (const token of browserVmTokens) {
      if (options.has(token.tokenId)) continue;
      options.set(token.tokenId, {
        tokenId: token.tokenId,
        symbol: token.symbol,
        decimals: token.decimals ?? 18,
        address: token.address,
        name: token.name
      });
    }

    const addTokenId = (tokenId: number) => {
      if (options.has(tokenId)) return;
      const info = $xlnFunctions.getTokenInfo(tokenId);
      options.set(tokenId, {
        tokenId,
        symbol: info?.symbol || `T${tokenId}`,
        decimals: info?.decimals ?? 18,
        address: undefined,
        name: info?.name
      });
    };

    for (const entry of reserves) addTokenId(entry.tokenId);
    for (const entry of collaterals) addTokenId(entry.tokenId);

    return Array.from(options.values()).sort((a, b) => a.tokenId - b.tokenId);
  });

  $effect(() => {
    const ids = tokenOptions.map(option => String(option.tokenId));
    if (ids.length === 0) {
      if (selectedTokenIdText !== '') {
        selectedTokenIdText = '';
      }
      return;
    }
    if (!ids.includes(selectedTokenIdText)) {
      selectedTokenIdText = ids.includes('1') ? '1' : ids[0];
    }
  });

  let selectedTokenId = $derived.by(() => {
    if (!selectedTokenIdText) return null;
    const parsed = Number(selectedTokenIdText);
    return Number.isNaN(parsed) ? null : parsed;
  });

  let selectedTokenMeta = $derived.by(() => {
    if (selectedTokenId === null) return null;
    const option = tokenOptions.find(opt => opt.tokenId === selectedTokenId);
    if (option) return option;
    const info = $xlnFunctions.getTokenInfo(selectedTokenId);
    return {
      tokenId: selectedTokenId,
      symbol: info?.symbol || `T${selectedTokenId}`,
      decimals: info?.decimals ?? 18,
      address: undefined,
      name: info?.name
    };
  });

  let filteredReserves = $derived.by(() => {
    if (selectedTokenId === null) return reserves;
    return reserves.filter(entry => entry.tokenId === selectedTokenId);
  });

  let filteredCollaterals = $derived.by(() => {
    if (selectedTokenId === null) return collaterals;
    return collaterals.filter(entry => entry.tokenId === selectedTokenId);
  });

  let signerRefs = $derived.by(() => {
    const vault = $activeVault;
    const vaults = $allVaults;
    const scope = vault ? [vault] : vaults;
    const seen = new Map<string, SignerRef>();

    for (const currentVault of scope) {
      for (const signer of currentVault.signers || []) {
        if (!signer.address) continue;
        if (seen.has(signer.address)) continue;
        const label = vault ? signer.name : `${currentVault.id} · ${signer.name}`;
        seen.set(signer.address, {
          address: signer.address,
          label,
          vaultId: currentVault.id,
          signerName: signer.name
        });
      }
    }

    return Array.from(seen.values());
  });

  $effect(() => {
    const tokenMeta = selectedTokenMeta;
    const signers = signerRefs;
    const xln = $xlnInstance;

    if (!isLive || !tokenMeta?.address || signers.length === 0 || !xln?.getBrowserVMInstance) {
      externalBalances = [];
      externalBalancesLoading = false;
      externalBalancesError = null;
      return;
    }

    const browserVM = xln.getBrowserVMInstance();
    if (!browserVM?.getErc20Balance) {
      externalBalances = [];
      externalBalancesLoading = false;
      externalBalancesError = null;
      return;
    }

    const requestId = ++balanceRequestId;
    externalBalancesLoading = true;
    externalBalancesError = null;

    (async () => {
      try {
        const nextBalances: Array<{ address: string; label: string; balance: bigint }> = [];
        for (const signer of signers) {
          const balance = await browserVM.getErc20Balance(tokenMeta.address, signer.address);
          if (balance > 0n) {
            nextBalances.push({
              address: signer.address,
              label: signer.label,
              balance
            });
          }
        }
        if (requestId !== balanceRequestId) return;
        externalBalances = nextBalances;
      } catch (err) {
        if (requestId !== balanceRequestId) return;
        externalBalancesError = err instanceof Error ? err.message : String(err);
      } finally {
        if (requestId === balanceRequestId) {
          externalBalancesLoading = false;
        }
      }
    })();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //                              HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function formatEntityId(entityId: string): string {
    if (!entityId) return 'N/A';
    if (entityId.startsWith('0x') && entityId.length > 10) {
      return entityId.slice(0, 6) + '...' + entityId.slice(-4);
    }
    return entityId;
  }

  function formatStateRoot(stateRoot: Uint8Array | undefined): string {
    if (!stateRoot || stateRoot.length === 0) return '0x0';
    const hex = Array.from(stateRoot).map(b => b.toString(16).padStart(2, '0')).join('');
    return '0x' + hex;
  }

  function formatBalance(balance: bigint): string {
    const num = Number(balance) / 1e18;
    if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `$${(num / 1_000).toFixed(0)}K`;
    return `$${num.toFixed(0)}`;
  }

  function getTokenInfoFor(tokenId: number): { symbol: string; decimals: number } {
    const info = $xlnFunctions.getTokenInfo(tokenId);
    return {
      symbol: info?.symbol || `T${tokenId}`,
      decimals: info?.decimals ?? 18
    };
  }

  function getTokenSymbol(tokenId: number): string {
    return getTokenInfoFor(tokenId).symbol;
  }

  function formatTokenAmountFor(amount: bigint, tokenId: number): string {
    const info = getTokenInfoFor(tokenId);
    const absAmount = amount < 0n ? -amount : amount;
    const formatted = $xlnFunctions.formatTokenAmount(absAmount, info.decimals);
    return `${amount < 0n ? '-' : ''}${formatted} ${info.symbol}`;
  }

  function formatChannelKey(key: string): string {
    if (!key) return 'N/A';
    if (key.length > 20) {
      return key.slice(0, 10) + '...' + key.slice(-6);
    }
    return key;
  }

  function handleEntityClick(entityId: string) {
    panelBridge.emit('entity:selected', { entityId });
  }

  function handleEntityExpand(entityId: string, name: string) {
    panelBridge.emit('openEntityOperations', { entityId, entityName: name || formatEntityId(entityId) });
  }
</script>

<div class="jurisdiction-panel">
  <!-- Header with dropdown -->
  <div class="header">
    <h3>J-Machine</h3>
    <div class="selectors">
      {#if !hideSelector}
        <div class="j-selector">
          <select bind:value={selectedJurisdiction} disabled={jurisdictions.length === 0}>
            {#if jurisdictions.length === 0}
              <option value="">No jurisdictions</option>
            {:else}
              {#each jurisdictions as j}
                <option value={j.name}>{j.name}</option>
              {/each}
            {/if}
          </select>
        </div>
      {/if}
      <div class="token-selector">
        <select bind:value={selectedTokenIdText} disabled={tokenOptions.length === 0}>
          {#if tokenOptions.length === 0}
            <option value="">No tokens</option>
          {:else}
            {#each tokenOptions as token}
              <option value={token.tokenId}>{token.symbol} · {token.tokenId}</option>
            {/each}
          {/if}
        </select>
      </div>
    </div>
    <div class="meta">
      {#if selectedJurisdictionData}
        <span class="block-badge" title="Block Height">
          #{selectedJurisdictionData.blockNumber?.toString() || '0'}
        </span>
      {/if}
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab" class:active={activeTab === 'balances'} onclick={() => activeTab = 'balances'}>
      💰 Balances ({filteredReserves.length + filteredCollaterals.length + mempool.length})
    </button>
    <button class="tab" class:active={activeTab === 'overview'} onclick={() => activeTab = 'overview'}>
      Overview
    </button>
  </div>

  <!-- Content -->
  <div class="content">
    {#if !selectedJurisdictionData}
      <div class="empty">No jurisdiction selected</div>
    {:else if activeTab === 'overview'}
      <!-- Overview tab -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Jurisdiction Info</span>
        </div>
        <div class="info-grid">
          <div class="info-row">
            <span class="info-label">Name</span>
            <span class="info-value">{selectedJurisdictionData?.name}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Block</span>
            <span class="info-value">#{selectedJurisdictionData?.blockNumber?.toString() || '0'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">State Root</span>
            <span class="info-value mono state-root" title={formatStateRoot(selectedJurisdictionData?.stateRoot)}>
              {formatStateRoot(selectedJurisdictionData?.stateRoot)}
            </span>
          </div>
          <div class="info-row">
            <span class="info-label">Block Delay</span>
            <span class="info-value">{selectedJurisdictionData?.blockDelayMs || 300}ms</span>
          </div>
          {#if selectedJurisdictionData?.contracts?.depository}
            <div class="info-row">
              <span class="info-label">Depository</span>
              <span class="info-value mono">{selectedJurisdictionData.contracts.depository}</span>
            </div>
          {/if}
          {#if selectedJurisdictionData?.contracts?.entityProvider}
            <div class="info-row">
              <span class="info-label">EntityProvider</span>
              <span class="info-value mono">{selectedJurisdictionData.contracts.entityProvider}</span>
            </div>
          {/if}
          <div class="info-row mempool-section">
            <span class="info-label">Mempool ({mempool.length})</span>
            {#if mempool.length === 0}
              <span class="info-value empty-val">empty</span>
            {:else}
              <div class="mempool-inline">
                {#each mempool as tx, i}
                  <div class="mempool-tx-row">
                    <span class="tx-idx">#{i + 1}</span>
                    <span class="tx-type">{tx.type || tx.kind || 'tx'}</span>
                    {#if tx.from || tx.entityId}
                      <span class="tx-entity">{formatEntityId(tx.from || tx.entityId)}</span>
                    {/if}
                    {#if tx.to || tx.targetEntityId}
                      <span class="tx-arrow">→</span>
                      <span class="tx-entity">{formatEntityId(tx.to || tx.targetEntityId)}</span>
                    {/if}
                    {#if tx.amount}
                      <span class="tx-amt">{formatBalance(BigInt(tx.amount))}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
          <div class="info-row">
            <span class="info-label">Position</span>
            <span class="info-value mono">
              ({selectedJurisdictionData?.position?.x || 0}, {selectedJurisdictionData?.position?.y || 0}, {selectedJurisdictionData?.position?.z || 0})
            </span>
          </div>
        </div>
      </div>

    {:else if activeTab === 'balances'}
      <!-- Balances tab - Mempool (pending) + Reserves + Collaterals -->

      <!-- Mempool Section (Pending - will be processed soon) -->
      <div class="section mempool-section">
        <div class="section-header">
          <span class="section-title">⏳ Mempool (Pending Execution)</span>
          <span class="count pending">{mempool.length}</span>
        </div>
        {#if mempool.length === 0}
          <div class="empty">No pending transactions</div>
        {:else}
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Type</th>
                <th>From</th>
                <th>To</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {#each mempool as tx, i}
                <tr class="mempool-tx">
                  <td class="tx-index">#{i + 1}</td>
                  <td class="tx-type-cell">{tx.type || tx.kind || 'tx'}</td>
                  <td class="mono">{tx.from || tx.entityId ? formatEntityId(tx.from || tx.entityId) : '-'}</td>
                  <td class="mono">{tx.to || tx.targetEntityId ? formatEntityId(tx.to || tx.targetEntityId) : '-'}</td>
                  <td>{tx.amount ? formatBalance(BigInt(tx.amount)) : '-'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <!-- Reserves Section (R2C: Reserve-to-Collateral) -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Reserves (R2C source){selectedTokenMeta ? ` · ${selectedTokenMeta.symbol}` : ''}</span>
          <span class="count">{filteredReserves.length}</span>
        </div>
        {#if filteredReserves.length === 0}
          <div class="empty">No reserves</div>
        {:else}
          <div class="storage-table">
            {#each filteredReserves as r}
              <div
                class="storage-row clickable"
                onclick={() => handleEntityClick(r.entityId)}
                ondblclick={() => handleEntityExpand(r.entityId, r.name)}
                role="button"
                tabindex="0"
              >
                <span class="entity-label">{r.name}</span>
                <span class="key">[{formatEntityId(r.entityId)}][{getTokenSymbol(r.tokenId)}]</span>
                <span class="value">{formatTokenAmountFor(r.amount, r.tokenId)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Collaterals Section (C2R: Collateral-to-Reserve) -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Collaterals (C2R source){selectedTokenMeta ? ` · ${selectedTokenMeta.symbol}` : ''}</span>
          <span class="count">{filteredCollaterals.length}</span>
        </div>
        {#if filteredCollaterals.length === 0}
          <div class="empty">No collaterals</div>
        {:else}
          <table class="accounts-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Token</th>
                <th class="right">Collateral</th>
                <th class="right">Ondelta</th>
              </tr>
            </thead>
            <tbody>
              {#each filteredCollaterals as c}
                {@const parts = c.channelKey.split('-')}
                {@const leftId = parts[0] || '??'}
                {@const rightId = parts[1] || '??'}
                {@const leftKey = Array.from(entityNames.keys()).find(k => k.endsWith(leftId))}
                {@const rightKey = Array.from(entityNames.keys()).find(k => k.endsWith(rightId))}
                {@const leftName = (leftKey ? entityNames.get(leftKey) : null) || leftId}
                {@const rightName = (rightKey ? entityNames.get(rightKey) : null) || rightId}
                <tr>
                  <td class="account-cell">
                    <span class="entity-left">{leftName}</span>
                    <span class="sep">↔</span>
                    <span class="entity-right">{rightName}</span>
                  </td>
                  <td class="token-cell">{getTokenSymbol(c.tokenId)}</td>
                  <td class="value-cell right">{formatTokenAmountFor(c.collateral, c.tokenId)}</td>
                  <td class="value-cell right" class:positive={c.ondelta > 0n} class:negative={c.ondelta < 0n}>
                    {c.ondelta > 0n ? '+' : ''}{formatTokenAmountFor(c.ondelta, c.tokenId)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <!-- External balances (BrowserVM ERC20) -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">External Balances{selectedTokenMeta ? ` · ${selectedTokenMeta.symbol}` : ''}</span>
          <span class="count">{externalBalances.length}</span>
        </div>
        {#if !isLive}
          <div class="empty">External balances are available in live mode only</div>
        {:else if !selectedTokenMeta}
          <div class="empty">Select a token to view external balances</div>
        {:else if !selectedTokenMeta.address}
          <div class="empty">No external token mapping for this token</div>
        {:else if signerRefs.length === 0}
          <div class="empty">No signers available</div>
        {:else if externalBalancesLoading}
          <div class="empty">Loading external balances…</div>
        {:else if externalBalancesError}
          <div class="empty error">{externalBalancesError}</div>
        {:else if externalBalances.length === 0}
          <div class="empty">No external balances</div>
        {:else}
          <table class="accounts-table external-balances-table">
            <thead>
              <tr>
                <th>Signer</th>
                <th>Address</th>
                <th class="right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {#each externalBalances as entry}
                {@const tokenId = selectedTokenMeta?.tokenId ?? 0}
                <tr>
                  <td class="signer-cell">{entry.label}</td>
                  <td class="mono" title={entry.address}>{formatEntityId(entry.address)}</td>
                  <td class="value-cell right">{formatTokenAmountFor(entry.balance, tokenId)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <!-- Disputes Section -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Active Disputes</span>
          <span class="count">0</span>
        </div>
        <div class="empty">No active disputes</div>
      </div>
    {/if}
  </div>
</div>

<style>
  .jurisdiction-panel {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #0d1117;
    color: #c9d1d9;
    overflow: hidden;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 11px;
  }

  .header {
    padding: 8px 12px;
    border-bottom: 1px solid #21262d;
    display: flex;
    align-items: center;
    gap: 8px;
    background: #161b22;
  }

  .header h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: #7ee787;
  }

  .selectors {
    flex: 1;
    display: flex;
    gap: 8px;
  }

  .j-selector {
    flex: 1;
  }

  .token-selector {
    flex: 0 0 140px;
  }

  .j-selector select,
  .token-selector select {
    width: 100%;
    padding: 4px 8px;
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 4px;
    color: #c9d1d9;
    font-size: 11px;
    cursor: pointer;
  }

  .j-selector select:hover,
  .token-selector select:hover {
    border-color: #58a6ff;
  }

  .j-selector select:focus,
  .token-selector select:focus {
    outline: none;
    border-color: #58a6ff;
    box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.2);
  }

  .meta {
    display: flex;
    gap: 6px;
  }

  .block-badge {
    font-size: 9px;
    padding: 2px 5px;
    background: #21262d;
    border-radius: 3px;
    color: #8b949e;
  }

  .tabs {
    display: flex;
    background: #161b22;
    border-bottom: 1px solid #21262d;
  }

  .tab {
    flex: 1;
    padding: 6px 8px;
    background: transparent;
    border: none;
    color: #8b949e;
    cursor: pointer;
    font-size: 10px;
    border-bottom: 2px solid transparent;
  }

  .tab:hover {
    color: #c9d1d9;
  }

  .tab.active {
    color: #58a6ff;
    border-bottom-color: #58a6ff;
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .section {
    margin-bottom: 12px;
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 4px;
    overflow: hidden;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    background: #0d1117;
    border-bottom: 1px solid #21262d;
  }

  .section-title {
    font-size: 9px;
    color: #d29922;
  }

  .count {
    font-size: 9px;
    color: #8b949e;
    padding: 1px 4px;
    background: #21262d;
    border-radius: 3px;
  }

  .empty {
    padding: 12px;
    text-align: center;
    color: #484f58;
    font-size: 10px;
    font-style: italic;
  }

  .empty.error {
    color: #f85149;
    font-style: normal;
  }

  .info-grid {
    padding: 8px;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    border-bottom: 1px solid #21262d;
  }

  .info-row:last-child {
    border-bottom: none;
  }

  .info-label {
    color: #8b949e;
    font-size: 10px;
  }

  .info-value {
    color: #c9d1d9;
    font-size: 10px;
  }

  .info-value.mono {
    font-family: 'Monaco', 'Menlo', monospace;
    color: #58a6ff;
  }

  .info-value.state-root {
    word-break: break-all;
    font-size: 9px;
    line-height: 1.3;
    max-width: 200px;
  }

  /* Mempool section - visually distinct as "pending" */
  .mempool-section {
    background: rgba(255, 193, 7, 0.05);
    border: 1px solid rgba(255, 193, 7, 0.3);
    margin-bottom: 16px; /* Space before Reserves section */
  }

  .mempool-section .section-header {
    background: rgba(255, 193, 7, 0.1);
  }

  .count.pending {
    background: rgba(255, 193, 7, 0.3);
    color: #ffd700;
  }

  .mempool-tx {
    background: rgba(255, 193, 7, 0.03);
  }

  .tx-index {
    color: #888;
    font-size: 10px;
  }

  .tx-type-cell {
    font-family: 'Consolas', monospace;
    font-size: 11px;
    color: #ffd700;
  }

  /* Legacy mempool-section (keep for overview tab inline mempool) */
  .info-row.mempool-section {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .mempool-inline {
    width: 100%;
    padding-left: 4px;
  }

  .mempool-tx-row {
    display: flex;
    gap: 6px;
    font-size: 9px;
    padding: 2px 0;
    color: #8b949e;
  }

  .mempool-tx-row .tx-idx {
    color: #6e7681;
    min-width: 20px;
  }

  .mempool-tx-row .tx-type {
    color: #d29922;
    text-transform: uppercase;
    font-weight: 500;
    min-width: 32px;
  }

  .mempool-tx-row .tx-entity {
    color: #58a6ff;
  }

  .mempool-tx-row .tx-arrow {
    color: #6e7681;
  }

  .mempool-tx-row .tx-amt {
    color: #7ee787;
    font-weight: 500;
  }

  .empty-val {
    color: #6e7681;
    font-style: italic;
  }

  .storage-table {
    padding: 4px 0;
  }

  .storage-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 8px;
    border-bottom: 1px solid #21262d;
    gap: 8px;
  }

  .storage-row:last-child {
    border-bottom: none;
  }

  .clickable {
    cursor: pointer;
    transition: background 0.15s;
  }

  .clickable:hover {
    background: #1c2128;
  }

  .entity-label {
    color: #58a6ff;
    font-weight: 500;
    min-width: 50px;
  }

  .key {
    color: #8b949e;
    flex: 1;
    font-size: 9px;
  }

  .value {
    color: #7ee787;
    font-weight: 600;
    font-size: 12px;
  }

  .channel-key {
    color: #d29922;
    font-size: 9px;
    min-width: 80px;
  }

  .token-id {
    color: #8b949e;
    font-size: 9px;
    min-width: 30px;
  }

  .collateral-value {
    color: #7ee787;
    font-weight: 600;
    min-width: 60px;
    text-align: right;
  }

  .ondelta-value {
    color: #8b949e;
    min-width: 60px;
    text-align: right;
  }

  .ondelta-value.positive {
    color: #7ee787;
  }

  .ondelta-value.negative {
    color: #f85149;
  }

  /* Accounts table styles */
  .accounts-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10px;
  }

  .accounts-table th {
    text-align: left;
    color: #8b949e;
    font-weight: 500;
    padding: 6px 8px;
    border-bottom: 1px solid #21262d;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .accounts-table th.right {
    text-align: right;
  }

  .accounts-table td {
    padding: 6px 8px;
    border-bottom: 1px solid #21262d;
  }

  .accounts-table tr:hover {
    background: #161b22;
  }

  .account-cell {
    white-space: nowrap;
  }

  .account-cell .entity-left {
    color: #58a6ff;
    font-weight: 600;
  }

  .account-cell .sep {
    color: #484f58;
    margin: 0 4px;
  }

  .account-cell .entity-right {
    color: #f0883e;
    font-weight: 600;
  }

  .token-cell {
    color: #7ee787;
    font-size: 9px;
  }

  .signer-cell {
    color: #c9d1d9;
    font-weight: 600;
  }

  .value-cell {
    font-family: 'SF Mono', monospace;
    color: #c9d1d9;
  }

  .value-cell.right {
    text-align: right;
  }

  .value-cell.positive {
    color: #7ee787;
  }

  .value-cell.negative {
    color: #f85149;
  }

  /* Mempool styles */
  .mempool-tx {
    gap: 6px;
    align-items: center;
  }

  .tx-index {
    color: #484f58;
    font-size: 9px;
    min-width: 20px;
  }

  .tx-type {
    color: #d29922;
    font-size: 10px;
    font-weight: 500;
    min-width: 70px;
  }

  .tx-from, .tx-to {
    color: #58a6ff;
    font-size: 9px;
  }

  .tx-arrow {
    color: #8b949e;
    font-size: 10px;
  }

  .tx-amount {
    color: #7ee787;
    font-weight: 600;
    margin-left: auto;
  }
</style>
