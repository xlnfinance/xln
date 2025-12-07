<script lang="ts">
  import { onMount } from 'svelte';

  export let jurisdictionName: string;
  export let rpcUrl: string;
  export let depositoryAddress: string;
  export let entityProviderAddress: string;

  interface ContractInfo {
    name: string;
    address: string;
    bytecodeSize: number;
    deployable: boolean;
  }

  interface ReserveRow {
    entity: string;
    tokenId: number;
    amount: string;
    debts: number;
    insurance: number;
  }

  interface CollateralRow {
    left: string;
    right: string;
    tokenId: number;
    collateral: string;
    ondelta: string;
  }

  let contracts: ContractInfo[] = [];
  let reserves: ReserveRow[] = [];
  let collaterals: CollateralRow[] = [];

  let sortColumn = 'entity';
  let sortDirection: 'asc' | 'desc' = 'asc';
  let loading = false;

  async function fetchContractSize(address: string): Promise<number> {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getCode',
          params: [address, 'latest'],
          id: 1
        })
      });

      const data = await response.json();
      if (data.result && data.result !== '0x') {
        // Bytecode includes 0x prefix, each byte = 2 hex chars
        return (data.result.length - 2) / 2;
      }
      return 0;
    } catch (error) {
      console.error('Failed to fetch contract size:', error);
      return 0;
    }
  }

  async function loadContractInfo() {
    loading = true;

    // Fetch contract sizes
    const [epSize, depSize] = await Promise.all([
      fetchContractSize(entityProviderAddress),
      fetchContractSize(depositoryAddress)
    ]);

    contracts = [
      {
        name: 'EntityProvider',
        address: entityProviderAddress,
        bytecodeSize: epSize,
        deployable: epSize <= 24576 && epSize > 0
      },
      {
        name: 'Depository',
        address: depositoryAddress,
        bytecodeSize: depSize,
        deployable: depSize <= 24576 && depSize > 0
      }
    ];

    loading = false;
  }

  async function loadStorageState() {
    // TODO: Query Depository contract for:
    // - All entities with non-zero reserves
    // - All active debts
    // - All collaterals
    // - All insurance lines

    // Mock data for now (replace with actual contract calls)
    reserves = [
      {
        entity: '0x0000000000000000000000000000000000000000000000000000000000000002',
        tokenId: 1,
        amount: '1,000.00',
        debts: 0,
        insurance: 1
      },
      {
        entity: '0x0000000000000000000000000000000000000000000000000000000000000003',
        tokenId: 1,
        amount: '500.50',
        debts: 2,
        insurance: 0
      }
    ];

    collaterals = [
      {
        left: '0x...0002',
        right: '0x...0003',
        tokenId: 1,
        collateral: '250.00',
        ondelta: '100.00'
      }
    ];
  }

  function sortTable(column: string) {
    if (sortColumn === column) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = column;
      sortDirection = 'asc';
    }

    reserves.sort((a, b) => {
      let aVal = a[column as keyof ReserveRow];
      let bVal = b[column as keyof ReserveRow];

      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    reserves = [...reserves]; // Trigger reactivity
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return 'Not deployed';
    return `${bytes.toLocaleString()} bytes (${((bytes / 24576) * 100).toFixed(0)}%)`;
  }

  function formatAddress(addr: string): string {
    if (addr.length === 66) {
      return `${addr.slice(0, 10)}...${addr.slice(-8)}`;
    }
    return addr;
  }

  onMount(() => {
    loadContractInfo();
    loadStorageState();
  });
</script>

<div class="storage-inspector">
  <h4>🔍 J-Machine Introspection</h4>

  <!-- Contract Info Section -->
  <div class="section">
    <h5>📜 Deployed Contracts</h5>
    <table class="contracts-table">
      <thead>
        <tr>
          <th>Contract</th>
          <th>Address</th>
          <th>Size</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {#each contracts as contract}
          <tr>
            <td class="contract-name">{contract.name}</td>
            <td class="mono">{formatAddress(contract.address)}</td>
            <td class:over-limit={!contract.deployable && contract.bytecodeSize > 0}>
              {formatBytes(contract.bytecodeSize)}
            </td>
            <td>
              {#if contract.bytecodeSize === 0}
                ⚪ Not deployed
              {:else if contract.deployable}
                ✅ Deployable
              {:else}
                ❌ TOO LARGE
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <!-- Reserves Table -->
  <div class="section">
    <h5>💰 Entity Reserves (Sortable)</h5>
    <div class="table-container">
      <table class="storage-table sortable">
        <thead>
          <tr>
            <th on:click={() => sortTable('entity')}>
              Entity {sortColumn === 'entity' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
            </th>
            <th on:click={() => sortTable('tokenId')}>
              Token {sortColumn === 'tokenId' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
            </th>
            <th on:click={() => sortTable('amount')}>
              Amount {sortColumn === 'amount' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
            </th>
            <th on:click={() => sortTable('debts')}>
              Debts {sortColumn === 'debts' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
            </th>
            <th on:click={() => sortTable('insurance')}>
              Insurance {sortColumn === 'insurance' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
            </th>
          </tr>
        </thead>
        <tbody>
          {#if loading}
            <tr><td colspan="5" class="loading">Loading storage...</td></tr>
          {:else if reserves.length === 0}
            <tr><td colspan="5" class="empty">No reserves found</td></tr>
          {:else}
            {#each reserves as row}
              <tr>
                <td class="mono">{formatAddress(row.entity)}</td>
                <td>{row.tokenId}</td>
                <td class="amount">{row.amount}</td>
                <td class:warn={row.debts > 0}>
                  {row.debts > 0 ? `🔴 ${row.debts}` : '✅'}
                </td>
                <td>
                  {row.insurance > 0 ? `🛡️ ${row.insurance}` : '-'}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </div>

  <!-- Collaterals Table -->
  <div class="section">
    <h5>🔒 Account Collaterals</h5>
    <div class="table-container">
      <table class="storage-table">
        <thead>
          <tr>
            <th>Left Entity</th>
            <th>Right Entity</th>
            <th>Token</th>
            <th>Collateral</th>
            <th>Ondelta</th>
          </tr>
        </thead>
        <tbody>
          {#if collaterals.length === 0}
            <tr><td colspan="5" class="empty">No active collaterals</td></tr>
          {:else}
            {#each collaterals as row}
              <tr>
                <td class="mono">{row.left}</td>
                <td class="mono">{row.right}</td>
                <td>{row.tokenId}</td>
                <td class="amount">{row.collateral}</td>
                <td class="amount" class:negative={Number(row.ondelta) < 0}>
                  {row.ondelta}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </div>

  <!-- Raw Storage Access -->
  <details class="raw-storage">
    <summary>🔬 Raw Storage Mappings</summary>
    <div class="raw-view">
      <pre>_reserves[entity][tokenId]: {JSON.stringify(reserves, null, 2)}</pre>
      <pre>_collaterals[accountKey][tokenId]: {JSON.stringify(collaterals, null, 2)}</pre>
    </div>
  </details>
</div>

<style>
  .storage-inspector {
    margin-top: 20px;
    padding: 15px;
    background: #1a1a1a;
    border: 1px solid #3e3e3e;
    border-radius: 8px;
  }

  .storage-inspector h4 {
    margin: 0 0 15px 0;
    color: #d4d4d4;
    font-size: 16px;
  }

  .storage-inspector h5 {
    margin: 10px 0 8px 0;
    color: #b4b4b4;
    font-size: 14px;
  }

  .section {
    margin-bottom: 20px;
  }

  /* Contract Info Table */
  .contracts-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    background: #2a2a2a;
    border-radius: 6px;
    overflow: hidden;
  }

  .contracts-table th {
    background: #333;
    color: #d4d4d4;
    padding: 8px;
    text-align: left;
    font-weight: 600;
  }

  .contracts-table td {
    padding: 8px;
    border-top: 1px solid #3e3e3e;
    color: #b4b4b4;
  }

  .contract-name {
    font-weight: 600;
    color: #d4d4d4;
  }

  .over-limit {
    color: #ff6b6b !important;
    font-weight: bold;
  }

  /* Storage Tables */
  .table-container {
    overflow-x: auto;
    background: #2a2a2a;
    border-radius: 6px;
  }

  .storage-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .storage-table th {
    background: #333;
    color: #d4d4d4;
    padding: 10px;
    text-align: left;
    font-weight: 600;
    position: sticky;
    top: 0;
    cursor: pointer;
    user-select: none;
  }

  .storage-table th:hover {
    background: #3a3a3a;
  }

  .storage-table td {
    padding: 8px 10px;
    border-top: 1px solid #3e3e3e;
    color: #b4b4b4;
  }

  .storage-table tbody tr:hover {
    background: #252525;
  }

  .mono {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 11px;
  }

  .amount {
    text-align: right;
    font-family: 'JetBrains Mono', monospace;
    color: #4ade80;
  }

  .warn {
    color: #ff6b6b;
  }

  .negative {
    color: #ff6b6b;
  }

  .loading, .empty {
    text-align: center;
    padding: 20px;
    color: #6c757d;
    font-style: italic;
  }

  /* Raw Storage Section */
  .raw-storage {
    margin-top: 15px;
    background: #1e1e1e;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    padding: 10px;
  }

  .raw-storage summary {
    cursor: pointer;
    color: #d4d4d4;
    font-weight: 600;
    user-select: none;
  }

  .raw-storage summary:hover {
    color: #fff;
  }

  .raw-view {
    margin-top: 10px;
    max-height: 400px;
    overflow-y: auto;
  }

  .raw-view pre {
    background: #0d1117;
    color: #c9d1d9;
    padding: 12px;
    border-radius: 6px;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    overflow-x: auto;
    margin: 8px 0;
  }
</style>
