<script lang="ts">
  import type { Writable } from 'svelte/store';
  import { getXLN, xlnEnvironment, replicas, xlnFunctions, processWithDelay } from '../../stores/xlnStore';
  import { routePreview } from '../../stores/routePreviewStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';

  export let entityId: string;

  // Optional isolated mode props (legacy - for backward compatibility)
  export let isolatedEnv: Writable<any> | undefined = undefined;
  export let isolatedReplicas: Writable<Map<string, any>> | undefined = undefined;

  // Get environment from context (for /view route) or use global stores (for / route)
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;

  // Extract the stores from entityEnv (or use props/global stores as fallback)
  const contextReplicas = entityEnv?.replicas;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextEnv = entityEnv?.env;

  // Payment form state
  let targetEntityId = '';
  let amount = '';
  let tokenId = 1; // Default to first token (ETH)
  let description = '';
  let findingRoutes = false;
  let sendingPayment = false;
  let routes: any[] = [];
  let selectedRouteIndex = -1;

  // Reactive: Use context stores first, then props, then global stores
  $: currentReplicas = contextReplicas ? $contextReplicas : (isolatedReplicas ? $isolatedReplicas : $replicas);
  $: currentEnv = contextEnv ? $contextEnv : (isolatedEnv ? $isolatedEnv : $xlnEnvironment);
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;

  // Auto-select first available token from entity's reserves
  $: {
    const replica = currentReplicas?.get(`${entityId}:s1`) || currentReplicas?.get(`${entityId}:s2`);
    if (replica?.state?.reserves) {
      const availableTokens = Array.from(replica.state.reserves.keys());
      if (availableTokens.length > 0 && !availableTokens.includes(tokenId)) {
        const firstToken = availableTokens[0];
        if (firstToken !== undefined) {
          tokenId = firstToken as number; // Use first available
        }
      }
    }
  }

  // Auto-calculate routes when target and amount change
  $: if (targetEntityId && amount && !findingRoutes) {
    findRoutes();
  }

  // Show route preview when route selected
  $: if (selectedRouteIndex >= 0 && routes[selectedRouteIndex]) {
    routePreview.showRoute(routes[selectedRouteIndex].path);
  } else {
    routePreview.clear();
  }

  // Get all entities for dropdown - guaranteed non-null entity IDs
  $: allEntities = currentReplicas ? Array.from(currentReplicas.keys() as IterableIterator<string>)
    .map((key: string) => {
      const entityId = key.split(':')[0];
      if (!entityId) throw new Error(`Invalid replica key format: ${key}`);
      return entityId;
    })
    .filter((id: string, index: number, self: string[]) =>
      self.indexOf(id) === index && id !== entityId
    )
    .sort() : [];

  /**
   * Find paths through the network using actual account connections (BFS)
   * Replaces gossip-based pathfinding with ground truth from entity states
   */
  function findPathsThroughAccounts(replicas: Map<string, any>, startId: string, targetId: string): Array<{ path: string[], probability: number }> {
    // Build adjacency map from actual accounts
    const adjacency = new Map<string, Set<string>>();

    for (const [replicaKey, replica] of replicas.entries()) {
      const [entityId] = replicaKey.split(':');
      if (!entityId || !replica.state?.accounts) continue;

      if (!adjacency.has(entityId)) {
        adjacency.set(entityId, new Set());
      }

      // Add all counterparties this entity has accounts with
      for (const counterpartyId of replica.state.accounts.keys()) {
        adjacency.get(entityId)!.add(String(counterpartyId));
      }
    }

    // BFS to find all paths (up to max depth 5)
    const maxDepth = 5;
    const foundPaths: Array<{ path: string[], probability: number }> = [];
    const queue: Array<{ current: string, path: string[], depth: number }> = [
      { current: startId, path: [startId], depth: 0 }
    ];
    const visited = new Set<string>();

    while (queue.length > 0 && foundPaths.length < 5) {
      const { current, path, depth } = queue.shift()!;

      if (depth > maxDepth) continue;
      if (current === targetId) {
        foundPaths.push({
          path: path,
          probability: 1.0 / (path.length - 1), // Shorter path = higher probability
        });
        continue;
      }

      const visitKey = `${current}-${depth}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      const neighbors = adjacency.get(current);
      if (!neighbors) continue;

      for (const neighbor of neighbors) {
        if (!path.includes(neighbor)) {
          queue.push({
            current: neighbor,
            path: [...path, neighbor],
            depth: depth + 1,
          });
        }
      }
    }

    // Sort by path length (shortest first)
    return foundPaths.sort((a, b) => a.path.length - b.path.length);
  }

  async function findRoutes() {
    if (!targetEntityId || !amount) return;

    findingRoutes = true;
    routes = [];
    selectedRouteIndex = -1;

    try {
      await getXLN();
      const env = currentEnv;
      if (!env) throw new Error('Environment not ready');

      // Convert decimal amount to smallest unit (wei/cents)
      // Assuming 18 decimals for most tokens
      const decimals = 18;
      const amountStr = String(amount); // Ensure it's a string
      const amountParts = amountStr.split('.');
      const wholePart = BigInt(amountParts[0] || 0);
      const decimalPart = amountParts[1] || '';
      const paddedDecimal = decimalPart.padEnd(decimals, '0').slice(0, decimals);
      const amountInSmallestUnit = wholePart * BigInt(10 ** decimals) + BigInt(paddedDecimal || 0);

      // Use account-based pathfinding (replaces gossip)
      // Use time-aware replicas from context/props (currentReplicas already handles priority)
      if (!currentReplicas) throw new Error('Replicas not available');
      const foundPaths = findPathsThroughAccounts(currentReplicas, entityId, targetEntityId);

      if (foundPaths.length === 0) {
        throw new Error(`No route found from ${entityId.slice(0, 10)}... to ${targetEntityId.slice(0, 10)}...`);
      }

      // Convert found paths to route objects
      routes = foundPaths.map((pathInfo) => {
        const hops = [];
        let totalFeePPM = 0;

        for (let i = 0; i < pathInfo.path.length - 1; i++) {
          const from = pathInfo.path[i]!;
          const to = pathInfo.path[i + 1]!;
          const feePPM = 0; // No fees for now (can be added later from account settings)

          hops.push({
            from,
            to,
            fee: 0n,
            feePPM,
          });

          totalFeePPM += feePPM;
        }

        // Estimate total fee (zero for now)
        const estimatedTotalFee = 0n;

        return {
          path: pathInfo.path,
          hops,
          totalFee: estimatedTotalFee,
          totalAmount: amountInSmallestUnit + estimatedTotalFee,
          probability: pathInfo.probability,
        };
      });

      if (routes.length > 0) {
        selectedRouteIndex = 0; // Auto-select first route
      }
    } catch (error) {
      console.error('❌ Failed to find routes - Full error:', error);
      console.error('❌ Error message:', (error as Error)?.message || 'Unknown error');
      console.error('❌ Stack:', (error as Error)?.stack);
      alert(`Failed to find routes: ${(error as Error)?.message || 'Unknown error'}`);
    } finally {
      findingRoutes = false;
    }
  }

  async function sendPayment() {
    if (selectedRouteIndex < 0 || !routes[selectedRouteIndex]) return;

    sendingPayment = true;
    try {
      await getXLN(); // Ensure initialized
      const env = currentEnv;
      if (!env) throw new Error('Environment not ready');

      const route = routes[selectedRouteIndex];

      // Find the correct signer ID for this entity
      // Use time-aware replicas from context/props (currentReplicas already handles priority)
      let signerId = 's1'; // default
      if (!currentReplicas) throw new Error('Replicas not available');
      for (const key of currentReplicas.keys()) {
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

      await processWithDelay(env, [paymentInput]);
      console.log(`✅ Payment sent via route: ${route.path.join(' → ')}`);

      // Don't reset form - allow easy repeat payments
      // User can manually clear if needed
      routes = [];
      selectedRouteIndex = -1;
    } catch (error) {
      console.error('❌ Failed to send payment - Full error:', error);
      console.error('❌ Error message:', (error as Error)?.message || 'Unknown error');
      console.error('❌ Stack:', (error as Error)?.stack);
      alert(`Failed to send payment: ${(error as Error)?.message || 'Unknown error'}`);
    } finally {
      sendingPayment = false;
    }
  }

  function formatRoute(route: any): string {
    return route.path.map((id: string) => `E${activeXlnFunctions!.getEntityShortId(id)}`).join(' → ');
  }

  function formatFee(feePPM: number): string {
    return `${(feePPM / 10000).toFixed(2)}%`;
  }
</script>

<div class="payment-panel">
  <h3>Send Payment</h3>

  <div class="form-group">
    <label for="target">Target Entity</label>
    <div class="entity-select-row">
      <select
        id="target"
        bind:value={targetEntityId}
        disabled={findingRoutes || sendingPayment}
      >
        <option value="">Select entity...</option>
        {#each allEntities as id}
          <option value={id}>Entity {activeXlnFunctions?.formatEntityId(id)}</option>
        {/each}
      </select>
      <button
        class="btn-reverse"
        on:click={() => {
          // Show target entity info (for reverse payment, user clicks target entity in graph)
          if (targetEntityId && activeXlnFunctions) {
            const targetDisplay = activeXlnFunctions.formatEntityId(targetEntityId);
            alert(`To send reverse payment: Click Entity ${targetDisplay} in the graph`);
          }
        }}
        disabled={!targetEntityId || findingRoutes || sendingPayment}
        title="Reverse payment direction"
      >
        ⇄
      </button>
    </div>
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
        <option value={2}>USDC</option>
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

  .entity-select-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .entity-select-row select {
    flex: 1;
  }

  .btn-reverse {
    padding: 8px 12px;
    background: rgba(100, 100, 110, 0.3);
    border: 1px solid rgba(150, 150, 160, 0.4);
    border-radius: 4px;
    color: #e0e0e0;
    font-size: 18px;
    cursor: pointer;
    transition: all 0.2s;
    min-width: 40px;
  }

  .btn-reverse:hover:not(:disabled) {
    background: rgba(150, 150, 160, 0.5);
    transform: scale(1.1);
  }

  .btn-reverse:disabled {
    opacity: 0.3;
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
