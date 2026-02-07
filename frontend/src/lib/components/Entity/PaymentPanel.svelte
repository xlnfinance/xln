<script lang="ts">
  import type { Writable } from 'svelte/store';
  import { getXLN, xlnEnvironment, replicas, xlnFunctions, processWithDelay } from '../../stores/xlnStore';
  import { routePreview } from '../../stores/routePreviewStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { toasts } from '$lib/stores/toastStore';
  import { keccak256, AbiCoder, hexlify } from 'ethers';
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
  let useHtlc = true; // HTLC by default (atomic), toggle for direct
  let findingRoutes = false;
  let sendingPayment = false;
  type RouteOption = {
    path: string[];
    hops: Array<{ from: string; to: string; fee: bigint; feePPM: number }>;
    totalFee: bigint;
    totalAmount: bigint;
    probability: number;
    obfuscationScore: number;
  };
  let routes: RouteOption[] = [];
  let selectedRouteIndex = -1;
  const MAX_ROUTES = 100;
  const MAX_PATH_HOPS = 6;
  const MIN_SELF_INTERMEDIATES = 2;

  // Reactive stores
  $: currentReplicas = contextReplicas ? $contextReplicas : (isolatedReplicas ? $isolatedReplicas : $replicas);
  $: currentEnv = contextEnv ? $contextEnv : (isolatedEnv ? $isolatedEnv : $xlnEnvironment);
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;

  // All entities for dropdown (local + gossip network)
  $: allEntities = (() => {
    const ids = new Set<string>();
    if (entityId) ids.add(entityId);
    if (currentReplicas) {
      for (const key of currentReplicas.keys() as IterableIterator<string>) {
        const localEntityId = key.split(':')[0];
        if (localEntityId) ids.add(localEntityId);
      }
    }
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      if (profile?.entityId) ids.add(String(profile.entityId));
    }
    return Array.from(ids).sort();
  })();

  // Contacts for selector: self first, then known names from gossip, then parent-provided contacts.
  $: selectorContacts = (() => {
    const byEntity = new Map<string, { name: string; entityId: string }>();
    if (entityId) byEntity.set(entityId, { name: 'Self', entityId });
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      const id = profile?.entityId;
      if (!id || byEntity.has(id)) continue;
      const name = profile?.metadata?.name?.trim?.();
      if (name) byEntity.set(id, { name, entityId: id });
    }
    for (const contact of contacts) {
      if (!contact?.entityId || byEntity.has(contact.entityId)) continue;
      byEntity.set(contact.entityId, contact);
    }
    const self = entityId ? byEntity.get(entityId) : null;
    const rest = Array.from(byEntity.values())
      .filter((c) => c.entityId !== entityId)
      .sort((a, b) => a.name.localeCompare(b.name));
    return self ? [self, ...rest] : rest;
  })();

  // Default recipient to self for obfuscated self-route flows.
  $: if (!targetEntityId && entityId) {
    targetEntityId = entityId;
  }

  // Format short ID — show first 6 + last 4 chars
  function formatShortId(id: string): string {
    if (!id || id.length < 14) return id || '';
    return id.slice(0, 6) + '...' + id.slice(-4);
  }

  // Generate HTLC secret/hashlock pair (browser-side, outside consensus)
  function generateSecretHashlock(): { secret: string; hashlock: string } {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const secret = hexlify(bytes);
    const abiCoder = AbiCoder.defaultAbiCoder();
    const hashlock = keccak256(abiCoder.encode(['bytes32'], [secret]));
    return { secret, hashlock };
  }

  // Build bidirectional adjacency from all available sources
  function buildNetworkAdjacency(env: any, replicas: Map<string, any>): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();

    const addEdge = (a: string, b: string) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a)!.add(b);
      adjacency.get(b)!.add(a); // Bidirectional: if A↔B exists, both can route through it
    };

    // Source 1: Local replicas (our own entities' accounts)
    for (const [replicaKey, replica] of replicas.entries()) {
      const [entId] = replicaKey.split(':');
      if (!entId || !replica.state?.accounts) continue;
      for (const counterpartyId of replica.state.accounts.keys()) {
        addEdge(entId, String(counterpartyId));
      }
    }

    // Source 2: Gossip profiles (network-wide channel graph)
    const profiles = env?.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      if (!profile.entityId || !profile.accounts) continue;
      for (const account of profile.accounts) {
        addEdge(profile.entityId, account.counterpartyId);
      }
    }

    return adjacency;
  }

  function parseAmountToWei(input: string, decimals = 18): bigint {
    const normalized = input.trim();
    if (!/^\d+(\.\d+)?$/.test(normalized)) {
      throw new Error('Amount must be a positive decimal number');
    }
    const [wholeRaw = '0', fracRaw = ''] = normalized.split('.');
    const whole = BigInt(wholeRaw);
    const frac = fracRaw.slice(0, decimals).padEnd(decimals, '0');
    const fracValue = frac.length > 0 ? BigInt(frac) : 0n;
    return whole * (10n ** BigInt(decimals)) + fracValue;
  }

  function quoteHopFee(from: string, amountIn: bigint): { fee: bigint; feePPM: number } {
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: any) => p?.entityId === from);
    const rawPpm = Number(profile?.metadata?.routingFeePPM ?? 100);
    const feePPM = Number.isFinite(rawPpm) && rawPpm >= 0 ? Math.floor(rawPpm) : 100;
    const rawBaseFee = profile?.metadata?.baseFee;
    const baseFee = typeof rawBaseFee === 'bigint'
      ? rawBaseFee
      : (typeof rawBaseFee === 'number' && Number.isFinite(rawBaseFee) ? BigInt(Math.max(0, Math.floor(rawBaseFee))) : 0n);
    const ppmFee = (amountIn * BigInt(feePPM)) / 1_000_000n;
    return { fee: baseFee + ppmFee, feePPM };
  }

  // Enumerate simple paths up to a hop cap; for self-pay enumerate cycles back to self.
  function findPathsFromGraph(adjacency: Map<string, Set<string>>, startId: string, targetId: string): string[][] {
    const results: string[][] = [];
    const seen = new Set<string>();
    const isSelfTarget = startId === targetId;

    const scorePath = (path: string[]) => {
      const hops = path.length - 1;
      const intermediates = Math.max(0, path.length - 2);
      const distinct = new Set(path).size;
      // Prefer more obfuscation but keep deterministic ordering.
      return (intermediates * 1000) + (distinct * 10) - hops;
    };

    const pushPath = (path: string[]) => {
      const key = path.join('>');
      if (seen.has(key)) return;
      seen.add(key);
      results.push(path);
    };

    const dfs = (current: string, path: string[], used: Set<string>) => {
      if (results.length >= MAX_ROUTES) return;
      const hops = path.length - 1;
      if (hops > MAX_PATH_HOPS) return;

      const neighbors = adjacency.get(current);
      if (!neighbors || neighbors.size === 0) return;

      for (const next of neighbors) {
        if (results.length >= MAX_ROUTES) break;
        const nextHops = hops + 1;
        if (nextHops > MAX_PATH_HOPS) continue;

        if (isSelfTarget) {
          if (next === startId) {
            const intermediateCount = path.length - 1;
            if (nextHops >= MIN_SELF_INTERMEDIATES + 1 && intermediateCount >= MIN_SELF_INTERMEDIATES) {
              pushPath([...path, startId]);
            }
            continue;
          }
          if (used.has(next)) continue;
          used.add(next);
          path.push(next);
          dfs(next, path, used);
          path.pop();
          used.delete(next);
          continue;
        }

        if (next === targetId) {
          pushPath([...path, targetId]);
          continue;
        }
        if (used.has(next) || next === startId) continue;
        used.add(next);
        path.push(next);
        dfs(next, path, used);
        path.pop();
        used.delete(next);
      }
    };

    dfs(startId, [startId], new Set([startId]));

    return results
      .sort((a, b) => scorePath(b) - scorePath(a))
      .slice(0, MAX_ROUTES);
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

      const amountInSmallestUnit = parseAmountToWei(amount, 18);
      if (amountInSmallestUnit <= 0n) {
        throw new Error('Amount must be greater than zero');
      }

      if (!currentReplicas) throw new Error('Replicas not available');
      const adjacency = buildNetworkAdjacency(env, currentReplicas);
      const foundPaths = findPathsFromGraph(adjacency, entityId, targetEntityId);

      if (foundPaths.length === 0) {
        if (targetEntityId === entityId) {
          throw new Error('No self-route found with at least 2 different intermediates');
        }
        throw new Error(`No route found to ${formatShortId(targetEntityId)}`);
      }

      routes = foundPaths.map((path) => {
        const hops = path.slice(0, -1).map((from, i) => {
          const { fee, feePPM } = quoteHopFee(from, amountInSmallestUnit);
          return {
            from,
            to: path[i + 1]!,
            fee,
            feePPM,
          };
        });
        const hopCount = hops.length;
        const totalFee = hops.reduce((sum, hop) => sum + hop.fee, 0n);
        const obfuscationScore = Math.max(0, path.length - 2);
        const probability = Math.max(0.01, 1 / (hopCount + 1));

        return {
          path,
          hops,
          totalFee,
          totalAmount: amountInSmallestUnit + totalFee,
          probability,
          obfuscationScore,
        };
      });

      if (routes.length > 0) selectedRouteIndex = 0;
    } catch (error) {
      console.error('[Send] Route finding failed:', error);
      toasts.error(`Route finding failed: ${(error as Error)?.message || 'Unknown error'}`);
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
      if (!route) throw new Error('Selected route is no longer available');

      // Find signer
      let signerId = '1';
      if (!currentReplicas) throw new Error('Replicas not available');
      for (const key of currentReplicas.keys()) {
        if (key.startsWith(entityId + ':')) {
          signerId = key.split(':')[1]!;
          break;
        }
      }

      let paymentInput: any;

      if (useHtlc) {
        // HTLC: atomic multi-hop with hashlock
        const { secret, hashlock } = generateSecretHashlock();
        console.log(`[Send] HTLC secret=${secret.slice(0,16)}... hashlock=${hashlock.slice(0,16)}...`);
        paymentInput = {
          entityId,
          signerId,
          entityTxs: [{
            type: 'htlcPayment' as const,
            data: {
              targetEntityId, tokenId,
              amount: route.totalAmount,
              route: route.path,
              description: description || undefined,
              secret, hashlock,
            },
          }],
        };
      } else {
        // Direct: simple non-atomic payment
        paymentInput = {
          entityId,
          signerId,
          entityTxs: [{
            type: 'directPayment' as const,
            data: {
              targetEntityId, tokenId,
              amount: route.totalAmount,
              route: route.path,
              description: description || undefined,
            },
          }],
        };
      }

      await processWithDelay(env, [paymentInput]);
      console.log(`[Send] ${useHtlc ? 'HTLC' : 'Direct'} payment sent via:`, route.path.map(formatShortId).join(' -> '));

      routes = [];
      selectedRouteIndex = -1;
    } catch (error) {
      console.error('[Send] Payment failed:', error);
      toasts.error(`Payment failed: ${(error as Error)?.message || 'Unknown error'}`);
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
    contacts={selectorContacts}
    excludeId=""
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

  <div class="mode-toggle">
    <label class="toggle-label">
      <input type="checkbox" bind:checked={useHtlc} disabled={findingRoutes || sendingPayment} />
      <span class="toggle-text">{useHtlc ? 'HTLC (atomic)' : 'Direct (simple)'}</span>
    </label>
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
              {route.hops.length} hop{route.hops.length !== 1 ? 's' : ''} | obfuscation {route.obfuscationScore} | {(route.probability * 100).toFixed(0)}% success
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
    max-height: 360px;
    overflow-y: auto;
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

  .mode-toggle {
    display: flex;
    align-items: center;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 12px;
    text-transform: none;
    color: #a8a29e;
  }

  .toggle-label input[type="checkbox"] {
    width: 16px;
    padding: 0;
    accent-color: #fbbf24;
  }

  .toggle-text {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #d6d3d1;
  }
</style>
