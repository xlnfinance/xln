<script lang="ts">
  import type { Writable } from 'svelte/store';
  import { getXLN, xlnEnvironment, replicas, xlnFunctions, processWithDelay } from '../../stores/xlnStore';
  import { routePreview } from '../../stores/routePreviewStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import EntityInput from '../shared/EntityInput.svelte';
  import TokenSelect from '../shared/TokenSelect.svelte';

  export let entityId: string;
  export let contacts: Array<{ name: string; entityId: string }> = [];

  // Optional isolated mode props (legacy)
  export let isolatedEnv: Writable<any> | undefined = undefined;
  export let isolatedReplicas: Writable<Map<string, any>> | undefined = undefined;

  // Context
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextReplicas = entityEnv?.eReplicas;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextEnv = entityEnv?.env;

  // Form state
  let targetEntityId = '';
  let amount = '';
  let tokenId = 1;
  let description = '';
  let findingRoutes = false;
  let sendingPayment = false;
  let routes: any[] = [];
  let selectedRouteIndex = -1;

  // Reactive stores
  $: currentReplicas = contextReplicas ? $contextReplicas : (isolatedReplicas ? $isolatedReplicas : $replicas);
  $: currentEnv = contextEnv ? $contextEnv : (isolatedEnv ? $isolatedEnv : $xlnEnvironment);
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;

  // All entities for dropdown
  $: allEntities = currentReplicas ? Array.from(currentReplicas.keys() as IterableIterator<string>)
    .map((key: string) => key.split(':')[0]!)
    .filter((id: string, index: number, self: string[]) => self.indexOf(id) === index)
    .sort() : [];

  // Format short ID
  function formatShortId(id: string): string {
    if (!id) return '';
    if (activeXlnFunctions?.getEntityShortId) {
      return '#' + activeXlnFunctions.getEntityShortId(id);
    }
    return '#' + (id.startsWith('0x') ? id.slice(2, 6) : id.slice(0, 4)).toUpperCase();
  }

  // Find paths through accounts (BFS)
  function findPathsThroughAccounts(replicas: Map<string, any>, startId: string, targetId: string): Array<{ path: string[], probability: number }> {
    const adjacency = new Map<string, Set<string>>();

    for (const [replicaKey, replica] of replicas.entries()) {
      const [entId] = replicaKey.split(':');
      if (!entId || !replica.state?.accounts) continue;

      if (!adjacency.has(entId)) adjacency.set(entId, new Set());

      for (const counterpartyId of replica.state.accounts.keys()) {
        adjacency.get(entId)!.add(String(counterpartyId));
      }
    }

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
        foundPaths.push({ path, probability: 1.0 / (path.length - 1) });
        continue;
      }

      const visitKey = `${current}-${depth}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      const neighbors = adjacency.get(current);
      if (!neighbors) continue;

      for (const neighbor of neighbors) {
        if (!path.includes(neighbor)) {
          queue.push({ current: neighbor, path: [...path, neighbor], depth: depth + 1 });
        }
      }
    }

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

      // Parse amount
      const decimals = 18;
      const amountParts = String(amount).split('.');
      const wholePart = BigInt(amountParts[0] || 0);
      const decimalPart = (amountParts[1] || '').padEnd(decimals, '0').slice(0, decimals);
      const amountInSmallestUnit = wholePart * BigInt(10 ** decimals) + BigInt(decimalPart || 0);

      if (!currentReplicas) throw new Error('Replicas not available');
      const foundPaths = findPathsThroughAccounts(currentReplicas, entityId, targetEntityId);

      if (foundPaths.length === 0) {
        throw new Error(`No route found to ${formatShortId(targetEntityId)}`);
      }

      routes = foundPaths.map((pathInfo) => {
        const hops = pathInfo.path.slice(0, -1).map((from, i) => ({
          from,
          to: pathInfo.path[i + 1]!,
          fee: 0n,
          feePPM: 0,
        }));

        return {
          path: pathInfo.path,
          hops,
          totalFee: 0n,
          totalAmount: amountInSmallestUnit,
          probability: pathInfo.probability,
        };
      });

      if (routes.length > 0) selectedRouteIndex = 0;
    } catch (error) {
      console.error('[Send] Route finding failed:', error);
      alert(`Failed: ${(error as Error)?.message}`);
    } finally {
      findingRoutes = false;
    }
  }

  async function sendPayment() {
    if (selectedRouteIndex < 0 || !routes[selectedRouteIndex]) return;

    sendingPayment = true;
    try {
      await getXLN();
      const env = currentEnv;
      if (!env) throw new Error('Environment not ready');

      const route = routes[selectedRouteIndex];

      // Find signer
      let signerId = '1';
      if (!currentReplicas) throw new Error('Replicas not available');
      for (const key of currentReplicas.keys()) {
        if (key.startsWith(entityId + ':')) {
          signerId = key.split(':')[1]!;
          break;
        }
      }

      const paymentInput = {
        entityId,
        signerId,
        entityTxs: [{
          type: 'directPayment' as const,
          data: {
            targetEntityId,
            tokenId,
            amount: route.totalAmount,
            route: route.path,
            description: description || undefined,
          },
        }],
      };

      await processWithDelay(env, [paymentInput]);
      console.log('[Send] Payment sent via:', route.path.map(formatShortId).join(' -> '));

      routes = [];
      selectedRouteIndex = -1;
    } catch (error) {
      console.error('[Send] Payment failed:', error);
      alert(`Failed: ${(error as Error)?.message}`);
    } finally {
      sendingPayment = false;
    }
  }

  function handleTargetChange(e: CustomEvent) {
    targetEntityId = e.detail.value;
  }

  function handleTokenChange(e: CustomEvent) {
    tokenId = e.detail.value;
  }
</script>

<div class="payment-panel">
  <EntityInput
    label="Recipient"
    value={targetEntityId}
    entities={allEntities}
    {contacts}
    excludeId={entityId}
    placeholder="Select recipient..."
    disabled={findingRoutes || sendingPayment}
    on:change={handleTargetChange}
  />

  <div class="row">
    <div class="amount-field">
      <label>Amount</label>
      <input
        type="text"
        bind:value={amount}
        placeholder="0.00"
        disabled={findingRoutes || sendingPayment}
      />
    </div>
    <TokenSelect
      label="Token"
      value={tokenId}
      disabled={findingRoutes || sendingPayment}
      on:change={handleTokenChange}
    />
  </div>

  <div class="field">
    <label>Description (optional)</label>
    <input
      type="text"
      bind:value={description}
      placeholder="Payment for..."
      disabled={findingRoutes || sendingPayment}
    />
  </div>

  <button
    class="btn-find"
    on:click={findRoutes}
    disabled={!targetEntityId || !amount || findingRoutes || sendingPayment}
  >
    {findingRoutes ? 'Finding Routes...' : 'Find Routes'}
  </button>

  {#if routes.length > 0}
    <div class="routes">
      <h4>Routes ({routes.length})</h4>
      {#each routes as route, index}
        <label class="route-option" class:selected={selectedRouteIndex === index}>
          <input
            type="radio"
            bind:group={selectedRouteIndex}
            value={index}
            disabled={sendingPayment}
          />
          <div class="route-info">
            <span class="route-path">
              {route.path.map(formatShortId).join(' -> ')}
            </span>
            <span class="route-meta">
              {route.hops.length} hop{route.hops.length !== 1 ? 's' : ''} | {(route.probability * 100).toFixed(0)}% success
            </span>
          </div>
        </label>
      {/each}

      <button
        class="btn-send"
        on:click={sendPayment}
        disabled={selectedRouteIndex < 0 || sendingPayment}
      >
        {sendingPayment ? 'Sending...' : 'Send Payment'}
      </button>
    </div>
  {/if}
</div>

<style>
  .payment-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    align-items: end;
  }

  .field, .amount-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  label {
    font-size: 11px;
    font-weight: 500;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  input {
    padding: 12px 14px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    color: #e7e5e4;
    font-size: 14px;
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
  }

  input:focus {
    outline: none;
    border-color: #fbbf24;
  }

  input::placeholder {
    color: #57534e;
  }

  input:disabled {
    opacity: 0.5;
  }

  .btn-find, .btn-send {
    padding: 14px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-find {
    background: #1c1917;
    border: 1px solid #292524;
    color: #a8a29e;
  }

  .btn-find:hover:not(:disabled) {
    border-color: #fbbf24;
    color: #fbbf24;
  }

  .btn-find:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-send {
    background: linear-gradient(135deg, #15803d, #166534);
    color: #dcfce7;
    margin-top: 12px;
  }

  .btn-send:hover:not(:disabled) {
    background: linear-gradient(135deg, #16a34a, #15803d);
  }

  .btn-send:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .routes {
    padding-top: 16px;
    border-top: 1px solid #292524;
  }

  .routes h4 {
    font-size: 12px;
    font-weight: 500;
    color: #78716c;
    margin: 0 0 12px 0;
  }

  .route-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: 8px;
  }

  .route-option:hover {
    border-color: #44403c;
  }

  .route-option.selected {
    border-color: #fbbf24;
    background: #422006;
  }

  .route-option input[type="radio"] {
    width: auto;
    margin-top: 2px;
  }

  .route-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .route-path {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #e7e5e4;
  }

  .route-meta {
    font-size: 11px;
    color: #78716c;
  }
</style>
