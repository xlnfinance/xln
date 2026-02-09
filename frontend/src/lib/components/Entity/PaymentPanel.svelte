<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Writable } from 'svelte/store';
  import { getXLN, xlnEnvironment, replicas, xlnFunctions, enqueueEntityInputs } from '../../stores/xlnStore';
  import { routePreview } from '../../stores/routePreviewStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { toasts } from '$lib/stores/toastStore';
  import { safeStringify } from '$lib/utils/safeStringify';
  import { keccak256, AbiCoder, hexlify } from 'ethers';
  import EntityInput from '../shared/EntityInput.svelte';
  import TokenSelect from '../shared/TokenSelect.svelte';
  import EntityIdentity from '../shared/EntityIdentity.svelte';

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
    senderAmount: bigint;
    recipientAmount: bigint;
    probability: number;
    obfuscationScore: number;
  };
  let routes: RouteOption[] = [];
  let selectedRouteIndex = -1;
  let preflightError: string | null = null;
  let repeatIntervalMs = 0;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  let profileExpanded = false;
  const REPEAT_OPTIONS = [
    { value: 0, label: 'No repeat' },
    { value: 1_000, label: 'Repeat 1s' },
    { value: 10_000, label: 'Repeat 10s' },
    { value: 60_000, label: 'Repeat 1m' },
  ];
  const MAX_ROUTES = 100;
  const MAX_PATH_HOPS = 6;
  const MIN_SELF_INTERMEDIATES = 2;

  type GossipAccount = {
    counterpartyId: string;
  };

  type GossipProfileView = {
    entityId: string;
    metadata?: {
      name?: string;
      cryptoPublicKey?: string;
      encryptionPubKey?: string;
      [key: string]: unknown;
    };
    accounts?: GossipAccount[];
    [key: string]: unknown;
  };

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

  $: selectedTargetProfile = (() => {
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    return profiles.find((profile: GossipProfileView) => profile?.entityId === targetEntityId) as GossipProfileView | undefined;
  })();

  $: selectedTargetProfileJson = selectedTargetProfile
    ? safeStringify(selectedTargetProfile, 2)
    : null;

  const clearRepeatTimer = () => {
    if (repeatTimer) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  };

  const restartRepeatTimer = () => {
    clearRepeatTimer();
    if (repeatIntervalMs <= 0 || selectedRouteIndex < 0 || !routes[selectedRouteIndex]) return;
    repeatTimer = setInterval(() => {
      void sendPayment(false);
    }, repeatIntervalMs);
  };

  $: if (repeatIntervalMs === 0) {
    clearRepeatTimer();
  }

  onDestroy(() => {
    clearRepeatTimer();
  });

  function getEntityName(id: string): string {
    if (!id) return 'Unknown';
    if (id === entityId) return 'Self';
    const contact = selectorContacts.find((c) => c.entityId === id);
    if (contact?.name) return contact.name;
    const profile = (currentEnv?.gossip?.getProfiles?.() || [])
      .find((p: GossipProfileView) => p?.entityId === id);
    const metaName = profile?.metadata?.name;
    return typeof metaName === 'string' && metaName.trim() ? metaName.trim() : id;
  }

  function formatToken(value: bigint): string {
    try {
      if (activeXlnFunctions?.formatTokenAmount) return activeXlnFunctions.formatTokenAmount(tokenId, value);
    } catch {
      // best effort formatting
    }
    return value.toString();
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

    // Source 2: Gossip profiles (network-wide account graph)
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

  function sanitizeFeePPM(raw: unknown, fallback = 10): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    const v = Math.floor(n);
    if (v < 0) return 0;
    if (v > 1_000_000) return 1_000_000;
    return v;
  }

  function sanitizeBigInt(raw: unknown): bigint {
    if (typeof raw === 'bigint') return raw < 0n ? 0n : raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const v = BigInt(Math.floor(raw));
      return v < 0n ? 0n : v;
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const trimmed = raw.trim();
      const parsed = trimmed.startsWith('BigInt(') && trimmed.endsWith(')')
        ? trimmed.slice(7, -1)
        : trimmed;
      try {
        const v = BigInt(parsed);
        return v < 0n ? 0n : v;
      } catch {
        return 0n;
      }
    }
    return 0n;
  }

  function directionalFeePPM(basePPM: number, outCapacity: bigint, inCapacity: bigint): number {
    const PPM_DENOM = 1_000_000n;
    const UTIL_STEP = 50_000n; // 5%
    const UTIL_CAP = 500_000n; // +50%
    const total = outCapacity + inCapacity;
    if (total <= 0n) return sanitizeFeePPM(basePPM, 10);
    let util = ((total - outCapacity) * PPM_DENOM) / total;
    if (util > UTIL_CAP) util = UTIL_CAP;
    util = (util / UTIL_STEP) * UTIL_STEP;
    const base = BigInt(sanitizeFeePPM(basePPM, 10));
    return Number(base + (base * util) / PPM_DENOM);
  }

  function quoteHopFee(from: string, to: string, token: number, amountIn: bigint): { fee: bigint; feePPM: number } {
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: any) => p?.entityId === from);
    const basePpm = sanitizeFeePPM(profile?.metadata?.routingFeePPM ?? 10, 10);
    const baseFee = sanitizeBigInt(profile?.metadata?.baseFee ?? 0n);
    const account = Array.isArray(profile?.accounts)
      ? profile.accounts.find((a: any) => String(a?.counterpartyId || '') === String(to))
      : null;
    const caps = account?.tokenCapacities;
    const tokenCap = caps
      ? (caps.get?.(token)
        ?? caps[String(token)]
        ?? caps[token])
      : null;
    const outCap = sanitizeBigInt(tokenCap?.outCapacity ?? 0n);
    const inCap = sanitizeBigInt(tokenCap?.inCapacity ?? 0n);
    const feePPM = directionalFeePPM(basePpm, outCap, inCap);
    const ppmFee = (amountIn * BigInt(feePPM)) / 1_000_000n;
    return { fee: baseFee + ppmFee, feePPM };
  }

  function quoteRequiredInboundForForward(desiredForward: bigint, feePPM: number, baseFee: bigint): bigint {
    if (desiredForward <= 0n) {
      throw new Error(`Invalid desired forward amount: ${desiredForward}`);
    }
    let low = desiredForward + baseFee;
    let high = low;
    const forwardOut = (amountIn: bigint) => {
      const ppmFee = (amountIn * BigInt(Math.max(0, Math.floor(feePPM)))) / 1_000_000n;
      const totalFee = baseFee + ppmFee;
      if (totalFee >= amountIn) throw new Error(`Fee too high for amount ${amountIn}`);
      return amountIn - totalFee;
    };
    while (forwardOut(high) < desiredForward) high *= 2n;
    while (low < high) {
      const mid = (low + high) / 2n;
      if (forwardOut(mid) >= desiredForward) high = mid;
      else low = mid + 1n;
    }
    return low;
  }

  function extractEntityCryptoKey(entity: string): string | null {
    if (!entity) return null;
    if (currentReplicas) {
      for (const [replicaKey, replica] of currentReplicas.entries()) {
        const [replicaEntityId] = replicaKey.split(':');
        if (replicaEntityId !== entity) continue;
        const localKey = replica?.state?.cryptoPublicKey;
        if (typeof localKey === 'string' && localKey.length > 0) {
          return localKey;
        }
      }
    }
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: GossipProfileView) => p?.entityId === entity) as GossipProfileView | undefined;
    if (!profile?.metadata) return null;
    const gossipKey = profile.metadata.cryptoPublicKey || profile.metadata.encryptionPubKey;
    return typeof gossipKey === 'string' && gossipKey.length > 0 ? gossipKey : null;
  }

  function emitUiDebugEvent(code: string, message: string, details: Record<string, unknown> = {}) {
    const payload = {
      source: 'PaymentPanel',
      code,
      message,
      entityId,
      targetEntityId,
      timestamp: Date.now(),
      details,
    };
    try {
      currentEnv?.p2p?.sendDebugEvent?.(payload);
    } catch {
      // Best effort only; never block UI on debug forwarding.
    }
  }

  function assertRecipientProfileReady() {
    if (!targetEntityId || targetEntityId === entityId) return;
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    const targetProfile = profiles.find((p: GossipProfileView) => p?.entityId === targetEntityId) as GossipProfileView | undefined;
    if (!targetProfile) {
      const msg = `Recipient ${targetEntityId} has no downloaded gossip profile`;
      emitUiDebugEvent('PAYMENT_PREFLIGHT_PROFILE_MISSING', msg);
      throw new Error(`${msg}. Refresh gossip/hubs and retry.`);
    }
    if (!extractEntityCryptoKey(targetEntityId)) {
      const msg = `Recipient ${targetEntityId} profile has no encryption key`;
      emitUiDebugEvent('PAYMENT_PREFLIGHT_KEY_MISSING', msg, { targetProfile });
      throw new Error(`${msg}. Cannot build encrypted HTLC route.`);
    }
  }

  function assertRouteKeyCoverage(path: string[]) {
    const missing: string[] = [];
    for (const hopEntity of path.slice(1)) {
      if (!extractEntityCryptoKey(hopEntity)) {
        missing.push(hopEntity);
      }
    }
    if (missing.length > 0) {
      const missingShort = missing;
      const msg = `Missing encryption keys for route hops: ${missingShort.join(', ')}`;
      emitUiDebugEvent('PAYMENT_PREFLIGHT_ROUTE_KEYS_MISSING', msg, {
        route: path,
        missingEntities: missing,
      });
      throw new Error(msg);
    }
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

  function isValidRoutePath(path: string[], startId: string, targetId: string): boolean {
    if (!Array.isArray(path) || path.length < 2) return false;
    if (path[0] !== startId) return false;
    if (path[path.length - 1] !== targetId) return false;

    // Interior hops must be unique and must never include sender.
    const interior = path.slice(1, -1);
    if (interior.some((hop) => hop === startId)) return false;
    if (new Set(interior).size !== interior.length) return false;

    // Self routes must include enough obfuscating intermediaries.
    if (startId === targetId) {
      if (interior.length < MIN_SELF_INTERMEDIATES) return false;
      if (new Set(interior).size < MIN_SELF_INTERMEDIATES) return false;
    }

    return true;
  }

  async function findRoutes() {
    if (!targetEntityId || !amount) return;

    findingRoutes = true;
    routes = [];
    selectedRouteIndex = -1;
    preflightError = null;
    clearRepeatTimer();

    try {
      await getXLN();
      const env = currentEnv;
      if (!env) throw new Error('Environment not ready');
      assertRecipientProfileReady();

      const amountInSmallestUnit = parseAmountToWei(amount, 18);
      if (amountInSmallestUnit <= 0n) {
        throw new Error('Amount must be greater than zero');
      }

      if (!currentReplicas) throw new Error('Replicas not available');
      const adjacency = buildNetworkAdjacency(env, currentReplicas);
      const foundPaths = findPathsFromGraph(adjacency, entityId, targetEntityId)
        .filter((path) => isValidRoutePath(path, entityId, targetEntityId));

      if (foundPaths.length === 0) {
        if (targetEntityId === entityId) {
          throw new Error('No self-route found with at least 2 different intermediates');
        }
        throw new Error(`No route found to ${targetEntityId}`);
      }

      routes = foundPaths.map((path) => {
        const intermediaries = path.slice(1, -1);
        let downstreamAmount = amountInSmallestUnit;
        const intermediaryFeeByEntity = new Map<string, { fee: bigint; feePPM: number }>();
        for (let i = intermediaries.length - 1; i >= 0; i -= 1) {
          const intermediary = intermediaries[i]!;
          const nextHop = path[i + 2]!;
          const { fee, feePPM } = quoteHopFee(intermediary, nextHop, tokenId, downstreamAmount);
          const baseFee = fee - ((downstreamAmount * BigInt(feePPM)) / 1_000_000n);
          const requiredInbound = quoteRequiredInboundForForward(downstreamAmount, feePPM, baseFee);
          intermediaryFeeByEntity.set(intermediary, {
            fee: requiredInbound - downstreamAmount,
            feePPM,
          });
          downstreamAmount = requiredInbound;
        }
        const senderAmount = downstreamAmount;
        const hops = path.slice(0, -1).map((from, i) => {
          const feeInfo = intermediaryFeeByEntity.get(from) || { fee: 0n, feePPM: 0 };
          return {
            from,
            to: path[i + 1]!,
            fee: feeInfo.fee,
            feePPM: feeInfo.feePPM,
          };
        });
        const hopCount = hops.length;
        const totalFee = senderAmount - amountInSmallestUnit;
        const obfuscationScore = Math.max(0, path.length - 2);
        const probability = Math.max(0.01, 1 / (hopCount + 1));

        return {
          path,
          hops,
          totalFee,
          senderAmount,
          recipientAmount: amountInSmallestUnit,
          probability,
          obfuscationScore,
        };
      }).sort((a, b) => {
        if (a.totalFee !== b.totalFee) return a.totalFee < b.totalFee ? -1 : 1;
        if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
        return b.probability - a.probability;
      });

      for (const route of routes) {
        assertRouteKeyCoverage(route.path);
      }

      if (routes.length > 0) selectedRouteIndex = 0;
    } catch (error) {
      console.error('[Send] Route finding failed:', error);
      preflightError = (error as Error)?.message || 'Unknown route preflight error';
      toasts.error(`Route finding failed: ${preflightError}`);
    } finally {
      findingRoutes = false;
    }
  }

  async function sendPayment(manual = true) {
    if (selectedRouteIndex < 0 || !routes[selectedRouteIndex]) return;
    if (sendingPayment) return;

    sendingPayment = true;
    try {
      await getXLN();
      const env = currentEnv;
      if (!env) throw new Error('Environment not ready');
      preflightError = null;
      assertRecipientProfileReady();

      const route = routes[selectedRouteIndex];
      if (!route) throw new Error('Selected route is no longer available');
      assertRouteKeyCoverage(route.path);

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
              amount: route.recipientAmount,
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
              amount: route.recipientAmount,
              route: route.path,
              description: description || undefined,
            },
          }],
        };
      }

      await enqueueEntityInputs(env, [paymentInput]);
      console.log(`[Send] ${useHtlc ? 'HTLC' : 'Direct'} payment sent via:`, route.path.join(' -> '));

      if (repeatIntervalMs <= 0) {
        routes = [];
        selectedRouteIndex = -1;
      }
    } catch (error) {
      console.error('[Send] Payment failed:', error);
      preflightError = (error as Error)?.message || 'Unknown send error';
      toasts.error(`Payment failed: ${preflightError}`);
    } finally {
      sendingPayment = false;
      if (manual) {
        restartRepeatTimer();
      }
    }
  }

  function handleTargetChange(e: CustomEvent) {
    targetEntityId = e.detail.value;
    preflightError = null;
    routes = [];
    selectedRouteIndex = -1;
    clearRepeatTimer();
  }

  function handleTokenChange(e: CustomEvent) {
    tokenId = e.detail.value;
  }

  function handleRepeatChange(event: Event) {
    const target = event.target as HTMLSelectElement | null;
    repeatIntervalMs = target ? Number(target.value) : 0;
    restartRepeatTimer();
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

  {#if preflightError}
    <div class="profile-preflight-error">{preflightError}</div>
  {/if}

  {#if targetEntityId}
    <div class="profile-preview">
      <button class="profile-preview-header" on:click={() => profileExpanded = !profileExpanded}>
        <span class="profile-toggle">{profileExpanded ? '▾' : '▸'} Recipient Gossip Profile</span>
        <div class="profile-header-right">
          {#if targetEntityId === entityId}
            <span class="profile-status ok">self</span>
          {:else if selectedTargetProfile}
            {#if extractEntityCryptoKey(targetEntityId)}
              <span class="profile-status ok">key ready</span>
            {:else}
              <span class="profile-status fail">missing key</span>
            {/if}
          {:else}
            <span class="profile-status fail">not downloaded</span>
          {/if}
        </div>
      </button>
      {#if profileExpanded}
        {#if selectedTargetProfileJson}
          <pre>{selectedTargetProfileJson}</pre>
        {:else if targetEntityId === entityId}
          <pre>{safeStringify({ entityId, note: 'Self recipient uses local entity state' }, 2)}</pre>
        {:else}
          <pre>{safeStringify({ entityId: targetEntityId, error: 'No gossip profile in local cache' }, 2)}</pre>
        {/if}
      {/if}
    </div>
  {/if}

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
      <div class="routes-scroll">
        {#each routes as route, index}
          <label class="route-option" class:selected={selectedRouteIndex === index}>
            <input
              type="radio"
              bind:group={selectedRouteIndex}
              value={index}
              disabled={sendingPayment}
            />
            <div class="route-info">
              <div class="route-cards">
                {#each route.path as hopId, hopIndex}
                  <div class="hop-card">
                    <EntityIdentity
                      entityId={hopId}
                      name={getEntityName(hopId)}
                      compact={true}
                      clickable={false}
                      copyable={false}
                      showAddress={true}
                      size={24}
                    />
                  </div>
                  {#if hopIndex < route.path.length - 1}
                    <span class="hop-arrow">→</span>
                  {/if}
                {/each}
              </div>
              <span class="route-meta">
                {route.hops.length} hop{route.hops.length !== 1 ? 's' : ''} | obfuscation {route.obfuscationScore} | {(route.probability * 100).toFixed(0)}% success
              </span>
              <span class="route-meta">
                fee {formatToken(route.totalFee)}
              </span>
            </div>
          </label>
        {/each}
      </div>
    </div>
    <div class="send-controls">
      <button
        class="btn-send"
        on:click={() => sendPayment(true)}
        disabled={selectedRouteIndex < 0 || sendingPayment}
      >
        {sendingPayment ? 'Sending...' : 'Send Payment'}
      </button>
      <label class="repeat-control">
        <span>Repeat</span>
        <select value={repeatIntervalMs} on:change={handleRepeatChange} disabled={sendingPayment}>
          {#each REPEAT_OPTIONS as option}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>
    </div>
    {#if repeatIntervalMs > 0}
      <div class="repeat-status">
        Auto-send every {repeatIntervalMs >= 60000 ? `${Math.floor(repeatIntervalMs / 60000)}m` : `${Math.floor(repeatIntervalMs / 1000)}s`}
      </div>
    {/if}
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
    grid-template-columns: 1fr 1fr;
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

  .send-controls {
    margin-top: 12px;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    align-items: end;
  }

  .repeat-control {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 11px;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .repeat-control select {
    min-width: 140px;
    height: 44px;
    padding: 0 10px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    color: #e7e5e4;
    font-size: 13px;
    font-family: inherit;
  }

  .repeat-status {
    margin-top: 6px;
    font-size: 12px;
    color: #a3e635;
  }

  .routes-scroll {
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

  .route-cards {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .hop-card {
    padding: 6px 8px;
    border-radius: 8px;
    border: 1px solid #2a2623;
    background: #171311;
    min-width: 0;
  }

  .hop-arrow {
    color: #7c7168;
    font-size: 13px;
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

  .profile-preview {
    border: 1px solid #292524;
    border-radius: 8px;
    background: #11100f;
    overflow: hidden;
  }

  .profile-preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    color: #a8a29e;
    font-size: 11px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    width: 100%;
    background: none;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: color 0.15s;
  }

  .profile-preview-header:hover {
    color: #d6d3d1;
  }

  .profile-toggle {
    font-family: 'JetBrains Mono', monospace;
  }

  .profile-header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .profile-status {
    font-size: 10px;
    border-radius: 999px;
    padding: 2px 8px;
    border: 1px solid transparent;
  }

  .profile-status.ok {
    color: #86efac;
    border-color: #166534;
    background: #052e16;
  }

  .profile-status.fail {
    color: #fca5a5;
    border-color: #7f1d1d;
    background: #450a0a;
  }

  .profile-preview pre {
    margin: 0;
    max-height: 220px;
    overflow: auto;
    padding: 12px;
    border-top: 1px solid #292524;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    line-height: 1.45;
    color: #d6d3d1;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .profile-preflight-error {
    border: 1px solid #7f1d1d;
    background: #450a0a;
    color: #fecaca;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 12px;
  }
</style>
