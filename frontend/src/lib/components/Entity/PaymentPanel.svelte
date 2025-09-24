<script lang="ts">
  import { getXLN, xlnEnvironment, replicas, xlnFunctions } from '../../stores/xlnStore';
  // Functions now accessed through $xlnEnvironment.xln from server.ts

  export let entityId: string;

  // Payment form state
  let targetEntityId = '';
  let amount = '';
  let tokenId = 2; // Default to USDT
  let description = '';
  let findingRoutes = false;
  let sendingPayment = false;
  let routes: any[] = [];
  let selectedRouteIndex = -1;

  // Get all entities for dropdown
  $: allEntities = $replicas ? Array.from($replicas.keys() as IterableIterator<string>)
    .map((key: string) => key.split(':')[0])
    .filter((id, index, self) => self.indexOf(id) === index && id !== entityId)
    .sort() : [];

  async function findRoutes() {
    if (!targetEntityId || !amount) return;

    findingRoutes = true;
    routes = [];
    selectedRouteIndex = -1;

    try {
      // For now, create a simple direct route if account exists
      // TODO: Implement proper Dijkstra pathfinding using gossip profiles

      await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('Environment not ready');

      // Check if we have a direct account with target
      // Find the correct replica key for this entity
      let ourReplica = null;
      for (const [key, replica] of env.replicas.entries()) {
        if (key.startsWith(entityId + ':')) {
          ourReplica = replica;
          break;
        }
      }
      const hasDirectAccount = ourReplica?.state?.accounts?.has(targetEntityId);

      // Convert decimal amount to smallest unit (wei/cents)
      // Assuming 18 decimals for most tokens
      const decimals = 18;
      const amountStr = String(amount); // Ensure it's a string
      const amountParts = amountStr.split('.');
      const wholePart = BigInt(amountParts[0] || 0);
      const decimalPart = amountParts[1] || '';
      const paddedDecimal = decimalPart.padEnd(decimals, '0').slice(0, decimals);
      const amountInSmallestUnit = wholePart * BigInt(10 ** decimals) + BigInt(paddedDecimal || 0);

      if (hasDirectAccount) {
        // Simple direct route
        routes = [{
          path: [entityId, targetEntityId],
          hops: [{
            from: entityId,
            to: targetEntityId,
            fee: 0n,
            feePPM: 0,
          }],
          totalFee: 0n,
          totalAmount: amountInSmallestUnit,
          probability: 1.0,
        }];
      } else {
        // Try to find intermediate hops (simplified for now)
        // TODO: Use actual routing module
        routes = [{
          path: [entityId, targetEntityId],
          hops: [{
            from: entityId,
            to: targetEntityId,
            fee: 0n,
            feePPM: 100,
          }],
          totalFee: 0n,
          totalAmount: amountInSmallestUnit,
          probability: 0.5,
          warning: 'No direct account - payment may fail',
        }];
      }

      if (routes.length > 0) {
        selectedRouteIndex = 0; // Auto-select first route
      }
    } catch (error) {
      console.error('Failed to find routes:', error);
      alert(`Failed to find routes: ${(error as Error)?.message || 'Unknown error'}`);
    } finally {
      findingRoutes = false;
    }
  }

  async function sendPayment() {
    if (selectedRouteIndex < 0 || !routes[selectedRouteIndex]) return;

    sendingPayment = true;
    try {
      const xln = await getXLN();
      const env = $xlnEnvironment;
      if (!env) throw new Error('Environment not ready');

      const route = routes[selectedRouteIndex];

      // Find the correct signer ID for this entity
      let signerId = 's1'; // default
      for (const key of env.replicas.keys()) {
        if (key.startsWith(entityId + ':')) {
          signerId = key.split(':')[1];
          break;
        }
      }

      // Create DirectPayment EntityTx
      const paymentInput = {
        entityId,
        signerId,
        entityTxs: [{
          type: 'directPayment' as const,
          data: {
            targetEntityId,
            tokenId,
            amount: route.totalAmount, // Use the converted amount from route
            route: route.path,
            description: description || undefined,
          },
        }],
      };

      await xln.processUntilEmpty(env, [paymentInput]);
      console.log(`✅ Payment sent via route: ${route.path.join(' → ')}`);

      // Don't reset form - allow easy repeat payments
      // User can manually clear if needed
      routes = [];
      selectedRouteIndex = -1;
    } catch (error) {
      console.error('Failed to send payment:', error);
      alert(`Failed to send payment: ${(error as Error)?.message || 'Unknown error'}`);
    } finally {
      sendingPayment = false;
    }
  }

  function formatRoute(route: any): string {
    return route.path.map((id: string) => `E${$xlnFunctions?.getEntityNumber(id) || '?'}`).join(' → ');
  }

  function formatFee(feePPM: number): string {
    return `${(feePPM / 10000).toFixed(2)}%`;
  }
</script>

<div class="payment-panel">
  <h3>Send Payment</h3>

  <div class="form-group">
    <label for="target">Target Entity</label>
    <select
      id="target"
      bind:value={targetEntityId}
      disabled={findingRoutes || sendingPayment}
    >
      <option value="">Select entity...</option>
      {#each allEntities as id}
        <option value={id}>Entity #{$xlnFunctions?.getEntityNumber(id) || '?'}</option>
      {/each}
    </select>
  </div>

  <div class="form-row">
    <div class="form-group">
      <label for="amount">Amount</label>
      <input
        id="amount"
        type="number"
        bind:value={amount}
        placeholder="0.00"
        min="0"
        step="0.01"
        disabled={findingRoutes || sendingPayment}
      />
    </div>

    <div class="form-group">
      <label for="token">Token</label>
      <select
        id="token"
        bind:value={tokenId}
        disabled={findingRoutes || sendingPayment}
      >
        <option value={1}>ETH</option>
        <option value={2}>USDT</option>
        <option value={3}>USDC</option>
      </select>
    </div>
  </div>

  <div class="form-group">
    <label for="description">Description (optional)</label>
    <input
      id="description"
      type="text"
      bind:value={description}
      placeholder="Payment for..."
      disabled={findingRoutes || sendingPayment}
    />
  </div>

  <button
    class="btn-primary"
    on:click={findRoutes}
    disabled={!targetEntityId || !amount || findingRoutes || sendingPayment}
  >
    {#if findingRoutes}
      Finding Routes...
    {:else}
      Find Routes
    {/if}
  </button>

  {#if routes.length > 0}
    <div class="routes-section">
      <h4>Available Routes ({routes.length})</h4>
      <div class="routes-list">
        {#each routes as route, index}
          <label class="route-option">
            <input
              type="radio"
              bind:group={selectedRouteIndex}
              value={index}
              disabled={sendingPayment}
            />
            <div class="route-details">
              <div class="route-path">{formatRoute(route)}</div>
              <div class="route-info">
                <span class="hops">{route.hops.length} hop{route.hops.length !== 1 ? 's' : ''}</span>
                <span class="fee">Fee: {formatFee(route.hops[0]?.feePPM || 0)}</span>
                <span class="probability">Success: {(route.probability * 100).toFixed(0)}%</span>
              </div>
              {#if route.warning}
                <div class="route-warning">⚠️ {route.warning}</div>
              {/if}
            </div>
          </label>
        {/each}
      </div>

      <button
        class="btn-send"
        on:click={sendPayment}
        disabled={selectedRouteIndex < 0 || sendingPayment}
      >
        {#if sendingPayment}
          Sending Payment...
        {:else}
          Send Payment
        {/if}
      </button>
    </div>
  {/if}
</div>

<style>
  .payment-panel {
    padding: 16px;
    background: #1e1e1e;
    border-radius: 4px;
  }

  h3 {
    margin: 0 0 16px 0;
    color: #007acc;
    font-size: 1.1em;
  }

  h4 {
    margin: 16px 0 8px 0;
    color: #007acc;
    font-size: 0.95em;
  }

  .form-group {
    margin-bottom: 12px;
  }

  .form-row {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 12px;
  }

  label {
    display: block;
    margin-bottom: 4px;
    color: #9d9d9d;
    font-size: 0.85em;
  }

  input, select {
    width: 100%;
    padding: 6px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    color: #d4d4d4;
    font-size: 0.9em;
  }

  input:focus, select:focus {
    outline: none;
    border-color: #007acc;
  }

  input:disabled, select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary, .btn-send {
    width: 100%;
    padding: 8px;
    background: #007acc;
    border: none;
    border-radius: 4px;
    color: white;
    font-size: 0.9em;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-primary:hover:not(:disabled), .btn-send:hover:not(:disabled) {
    background: #0086e6;
  }

  .btn-primary:disabled, .btn-send:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-send {
    background: #10b981;
    margin-top: 12px;
  }

  .btn-send:hover:not(:disabled) {
    background: #059669;
  }

  .routes-section {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid #3e3e3e;
  }

  .routes-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }

  .route-option {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .route-option:hover {
    background: #333;
    border-color: #007acc;
  }

  input[type="radio"] {
    width: auto;
    margin-top: 2px;
  }

  .route-details {
    flex: 1;
  }

  .route-path {
    font-family: monospace;
    color: #d4d4d4;
    margin-bottom: 4px;
  }

  .route-info {
    display: flex;
    gap: 12px;
    font-size: 0.8em;
    color: #9d9d9d;
  }

  .hops {
    color: #007acc;
  }

  .fee {
    color: #fbbf24;
  }

  .probability {
    color: #10b981;
  }

  .route-warning {
    margin-top: 4px;
    padding: 4px;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: 2px;
    color: #fbbf24;
    font-size: 0.8em;
  }
</style>