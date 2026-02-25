<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { Writable } from 'svelte/store';
  import { getXLN, xlnEnvironment, replicas, xlnFunctions, enqueueEntityInputs } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import { routePreview } from '../../stores/routePreviewStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
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
  const contextIsLive = entityEnv?.isLive;

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
  };
  let routes: RouteOption[] = [];
  let selectedRouteIndex = -1;
  let preflightError: string | null = null;
  let repeatIntervalMs = 0;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  let routeSortMode: 'fee' | 'hops' = 'fee';
  let showFullEntityId = false;
  let profileExpanded = false;
  let serverEntityNames = new Map<string, string>();
  const REPEAT_OPTIONS = [
    { value: 0, label: 'No repeat' },
    { value: 1_000, label: 'Repeat 1s' },
    { value: 10_000, label: 'Repeat 10s' },
    { value: 60_000, label: 'Repeat 1m' },
  ];
  const ROUTE_SORT_OPTIONS: Array<{ value: 'fee' | 'hops'; label: string }> = [
    { value: 'fee', label: 'Fee (lowest first)' },
    { value: 'hops', label: 'Hops (fewest first)' },
  ];
  // If a hop does not publish fee metadata, use a conservative default so
  // unknown peers cannot appear artificially cheaper than known hubs.
  const DEFAULT_UNKNOWN_HOP_FEE_PPM = 10_000;
  const MAX_ROUTES = 100;
  const MAX_CANDIDATE_PATHS = 500;
  const MAX_PATH_HOPS = 6;
  const MIN_SELF_CYCLE_INTERMEDIATES = 2;
  const GOSSIP_REFRESH_ATTEMPTS = 4;
  const GOSSIP_REFRESH_WAIT_MS = 250;

  type GossipAccount = {
    counterpartyId: string;
    tokenCapacities?: unknown;
  };

  type GossipProfileView = {
    entityId: string;
    metadata?: {
      name?: string;
      cryptoPublicKey?: string;
      encryptionPublicKey?: string;
      [key: string]: unknown;
    };
    accounts?: GossipAccount[];
    [key: string]: unknown;
  };

  // Reactive stores
  $: currentReplicas = contextReplicas ? $contextReplicas : (isolatedReplicas ? $isolatedReplicas : $replicas);
  $: currentEnv = contextEnv ? $contextEnv : (isolatedEnv ? $isolatedEnv : $xlnEnvironment);
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeIsLive = contextIsLive ? $contextIsLive : $globalIsLive;

  const normalizeEntityId = (id: string | null | undefined): string => String(id || '').trim().toLowerCase();

  // All entities for dropdown (local + gossip network)
  $: allEntities = (() => {
    const ids = new Map<string, string>();
    const add = (raw: string | null | undefined) => {
      const canonical = String(raw || '').trim();
      const norm = normalizeEntityId(canonical);
      if (!norm) return;
      if (!ids.has(norm)) ids.set(norm, canonical);
    };
    add(entityId);
    if (currentReplicas) {
      for (const key of currentReplicas.keys() as IterableIterator<string>) {
        const localEntityId = key.split(':')[0];
        add(localEntityId);
      }
    }
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      add(profile?.entityId);
    }
    return Array.from(ids.values()).sort();
  })();

  // Contacts for selector: self first, then known names from gossip, then parent-provided contacts.
  $: selectorContacts = (() => {
    const byEntity = new Map<string, { name: string; entityId: string }>();
    const put = (rawEntityId: string, name: string) => {
      const canonical = String(rawEntityId || '').trim();
      const norm = normalizeEntityId(canonical);
      if (!norm || byEntity.has(norm)) return;
      byEntity.set(norm, { name, entityId: canonical });
    };
    if (entityId) put(entityId, 'Self');
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      const id = String(profile?.entityId || '').trim();
      if (!id) continue;
      const name = profile?.metadata?.name?.trim?.();
      if (name) put(id, name);
    }
    for (const contact of contacts) {
      if (!contact?.entityId) continue;
      put(contact.entityId, contact.name);
    }
    const self = entityId ? byEntity.get(normalizeEntityId(entityId)) : null;
    const rest = Array.from(byEntity.values())
      .filter((c) => normalizeEntityId(c.entityId) !== normalizeEntityId(entityId))
      .sort((a, b) => a.name.localeCompare(b.name));
    return self ? [self, ...rest] : rest;
  })();

  // Default recipient to self for loopback routing flows.
  $: if (!targetEntityId && entityId) {
    targetEntityId = entityId;
  }

  $: selectedTargetProfile = (() => {
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    const targetNorm = normalizeEntityId(targetEntityId);
    return profiles.find((profile: GossipProfileView) => normalizeEntityId(profile?.entityId) === targetNorm) as GossipProfileView | undefined;
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
    const norm = normalizeEntityId(id);
    if (norm === normalizeEntityId(entityId)) return 'Self';
    const contact = selectorContacts.find((c) => normalizeEntityId(c.entityId) === norm);
    if (contact?.name) return contact.name;
    const serverName = serverEntityNames.get(norm);
    if (serverName) return serverName;
    const profile = (currentEnv?.gossip?.getProfiles?.() || [])
      .find((p: GossipProfileView) => normalizeEntityId(p?.entityId) === norm);
    const metaName = profile?.metadata?.name;
    return typeof metaName === 'string' && metaName.trim() ? metaName.trim() : id;
  }

  function getGossipProfileByEntityId(id: string): GossipProfileView | undefined {
    const norm = normalizeEntityId(id);
    if (!norm) return undefined;
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    return profiles.find((p: GossipProfileView) => normalizeEntityId(p?.entityId) === norm) as GossipProfileView | undefined;
  }

  function isRouteableIntermediary(entity: string): boolean {
    // Routeability is a transport/security property, not a display-metadata property.
    // A hop is routeable iff we can encrypt for it and it is hub-like when profile exists.
    if (!extractEntityCryptoKey(entity)) return false;
    const profile = getGossipProfileByEntityId(entity);
    if (!profile) return true; // allow local+gossip mixed discovery; key coverage is enforced above
    const metadata = (profile.metadata || {}) as Record<string, unknown>;
    const capabilities = Array.isArray((profile as any).capabilities) ? ((profile as any).capabilities as string[]) : [];
    return metadata['isHub'] === true || capabilities.includes('hub') || capabilities.includes('routing');
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

  type AdjacencyBuildResult = {
    adjacency: Map<string, Set<string>>;
    canonicalIds: Map<string, string>;
  };

  // Build bidirectional adjacency from all available sources
  function buildNetworkAdjacency(env: any, replicas: Map<string, any>): AdjacencyBuildResult {
    const adjacency = new Map<string, Set<string>>();
    const canonicalIds = new Map<string, string>();

    const toNorm = (raw: string | null | undefined): string => normalizeEntityId(raw);
    const rememberCanonical = (raw: string | null | undefined) => {
      const canonical = String(raw || '').trim();
      const norm = toNorm(canonical);
      if (!norm) return;
      if (!canonicalIds.has(norm)) canonicalIds.set(norm, canonical);
    };

    const addEdge = (a: string, b: string) => {
      const na = toNorm(a);
      const nb = toNorm(b);
      if (!na || !nb || na === nb) return;
      rememberCanonical(a);
      rememberCanonical(b);
      if (!adjacency.has(na)) adjacency.set(na, new Set());
      if (!adjacency.has(nb)) adjacency.set(nb, new Set());
      adjacency.get(na)!.add(nb);
      adjacency.get(nb)!.add(na); // Bidirectional: if A↔B exists, both can route through it
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
      rememberCanonical(profile?.entityId);
      if (!profile.entityId || !profile.accounts) continue;
      for (const account of profile.accounts) {
        addEdge(profile.entityId, account.counterpartyId);
      }
    }

    return { adjacency, canonicalIds };
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

  function getTokenDecimals(tokenIdValue: number): number {
    const tokenInfo = activeXlnFunctions?.getTokenInfo?.(tokenIdValue);
    const decimals = Number(tokenInfo?.decimals);
    return Number.isFinite(decimals) && decimals >= 0 ? decimals : 18;
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

  function getTokenCapacitySnapshot(tokenCapacities: unknown, token: number): { outCapacity: bigint; inCapacity: bigint } | null {
    if (!tokenCapacities) return null;
    const mapLike = tokenCapacities as { get?: (key: number | string) => any; [key: string]: any };
    const tokenCap = mapLike.get?.(token)
      ?? mapLike.get?.(String(token))
      ?? mapLike[String(token)]
      ?? mapLike[token];
    if (!tokenCap) return null;
    const outCapacity = sanitizeBigInt(tokenCap?.outCapacity ?? 0n);
    const inCapacity = sanitizeBigInt(tokenCap?.inCapacity ?? 0n);
    if (outCapacity <= 0n && inCapacity <= 0n) return null;
    return { outCapacity, inCapacity };
  }

  function getGossipAccountCapacity(owner: string, counterparty: string, token: number): { outCapacity: bigint; inCapacity: bigint } | null {
    const ownerNorm = normalizeEntityId(owner);
    const cpNorm = normalizeEntityId(counterparty);
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: any) => normalizeEntityId(p?.entityId) === ownerNorm);
    if (!profile || !Array.isArray(profile.accounts)) return null;
    const account = profile.accounts.find((a: any) => normalizeEntityId(String(a?.counterpartyId || '')) === cpNorm);
    return getTokenCapacitySnapshot(account?.tokenCapacities, token);
  }

  function getDirectionalEdgeCapacity(from: string, to: string, token: number): bigint {
    // A -> B is valid if sender side can send (A.out) and receiver side can accept (B.in).
    // Use both local+gossip, then take conservative min when both sides are known.
    const fromLocal = getLocalAccountCapacity(from, to, token);
    const toLocal = getLocalAccountCapacity(to, from, token);
    const fromGossip = getGossipAccountCapacity(from, to, token);
    const toGossip = getGossipAccountCapacity(to, from, token);

    const fromOut = [
      fromLocal?.outCapacity ?? 0n,
      fromGossip?.outCapacity ?? 0n,
    ].reduce((m, v) => (v > m ? v : m), 0n);

    const toIn = [
      toLocal?.inCapacity ?? 0n,
      toGossip?.inCapacity ?? 0n,
    ].reduce((m, v) => (v > m ? v : m), 0n);

    if (fromOut > 0n && toIn > 0n) return fromOut < toIn ? fromOut : toIn;
    return fromOut > toIn ? fromOut : toIn;
  }

  function hasOutboundCapacity(from: string, to: string, token: number): boolean {
    return getDirectionalEdgeCapacity(from, to, token) > 0n;
  }

  function getLocalAccountCapacity(from: string, to: string, token: number): { outCapacity: bigint; inCapacity: bigint } | null {
    if (!currentReplicas || !activeXlnFunctions?.deriveDelta) return null;
    const fromNorm = normalizeEntityId(from);
    const toNorm = normalizeEntityId(to);
    for (const [key, replica] of currentReplicas.entries()) {
      const [replicaEntityId] = key.split(':');
      if (normalizeEntityId(replicaEntityId) !== fromNorm) continue;
      const accounts: Map<string, any> | undefined = replica?.state?.accounts;
      if (!accounts || typeof accounts.entries !== 'function') continue;
      for (const [counterpartyId, account] of accounts.entries()) {
        if (normalizeEntityId(counterpartyId) !== toNorm) continue;
        const deltas = account?.deltas;
        const delta = deltas?.get?.(token) ?? deltas?.get?.(String(token));
        if (!delta) return null;
        const leftEntity = String(account?.leftEntity || '');
        const rightEntity = String(account?.rightEntity || '');
        const isLeft = leftEntity
          ? normalizeEntityId(leftEntity) === fromNorm
          : (rightEntity ? normalizeEntityId(rightEntity) !== fromNorm : fromNorm < toNorm);
        const derived = activeXlnFunctions.deriveDelta(delta, isLeft);
        const outCapacity = sanitizeBigInt((derived as any)?.outCapacity ?? 0n);
        const inCapacity = sanitizeBigInt((derived as any)?.inCapacity ?? 0n);
        if (outCapacity <= 0n && inCapacity <= 0n) return null;
        return { outCapacity, inCapacity };
      }
    }
    return null;
  }

  function quoteHop(
    from: string,
    to: string,
    token: number,
    amountIn: bigint
  ): { fee: bigint; feePPM: number; baseFee: bigint; outCap: bigint; inCap: bigint } | null {
    const fromNorm = normalizeEntityId(from);
    const toNorm = normalizeEntityId(to);
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: any) => normalizeEntityId(p?.entityId) === fromNorm);
    const basePpm = sanitizeFeePPM(
      profile?.metadata?.routingFeePPM ?? DEFAULT_UNKNOWN_HOP_FEE_PPM,
      DEFAULT_UNKNOWN_HOP_FEE_PPM
    );
    const baseFee = sanitizeBigInt(profile?.metadata?.baseFee ?? 0n);
    const account = Array.isArray(profile?.accounts)
      ? profile.accounts.find((a: any) => normalizeEntityId(String(a?.counterpartyId || '')) === toNorm)
      : null;
    const tokenCapacity =
      getTokenCapacitySnapshot(account?.tokenCapacities, token)
      ?? getLocalAccountCapacity(from, to, token);
    const directionalOutCap = getDirectionalEdgeCapacity(from, to, token);
    if (directionalOutCap <= 0n) return null;
    const pricingOut = sanitizeBigInt(tokenCapacity?.outCapacity ?? directionalOutCap);
    const pricingIn = sanitizeBigInt(tokenCapacity?.inCapacity ?? 0n);
    const outCap = directionalOutCap;
    const inCap = pricingIn;
    // Keep routing quotes deterministic: use advertised per-hop fee directly.
    const feePPM = sanitizeFeePPM(basePpm, 10);
    const ppmFee = (amountIn * BigInt(feePPM)) / 1_000_000n;
    return { fee: baseFee + ppmFee, feePPM, baseFee, outCap, inCap };
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

  function normalizeEnvelopeKey(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
    if (/^0x[0-9a-fA-F]{64}$/.test(prefixed)) return prefixed.toLowerCase();
    if (trimmed.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return trimmed;
    return null;
  }

  function extractEntityCryptoKey(entity: string): string | null {
    if (!entity) return null;
    const entityNorm = normalizeEntityId(entity);
    if (currentReplicas) {
      for (const [replicaKey, replica] of currentReplicas.entries()) {
        const [replicaEntityId] = replicaKey.split(':');
        if (normalizeEntityId(replicaEntityId) !== entityNorm) continue;
        const localCandidates = [
          replica?.state?.cryptoPublicKey,
          replica?.state?.encryptionPublicKey,
        ];
        for (const candidate of localCandidates) {
          const normalized = normalizeEnvelopeKey(candidate);
          if (normalized) return normalized;
        }
      }
    }
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p: GossipProfileView) => normalizeEntityId(p?.entityId) === entityNorm) as GossipProfileView | undefined;
    if (!profile) return null;
    const gossipCandidates = [
      profile?.metadata?.cryptoPublicKey,
      profile?.metadata?.encryptionPublicKey,
      (profile as any)?.cryptoPublicKey,
      (profile as any)?.encryptionPublicKey,
    ];
    for (const candidate of gossipCandidates) {
      const normalized = normalizeEnvelopeKey(candidate);
      if (normalized) return normalized;
    }
    return null;
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

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function getRecipientProfileIssue(): { code: string; message: string; details?: Record<string, unknown> } | null {
    if (!targetEntityId || normalizeEntityId(targetEntityId) === normalizeEntityId(entityId)) return null;
    const profiles = currentEnv?.gossip?.getProfiles?.() || [];
    const targetNorm = normalizeEntityId(targetEntityId);
    const targetProfile = profiles.find((p: GossipProfileView) => normalizeEntityId(p?.entityId) === targetNorm) as GossipProfileView | undefined;
    if (!targetProfile) {
      const msg = `Recipient ${targetEntityId} has no downloaded gossip profile`;
      return { code: 'PAYMENT_PREFLIGHT_PROFILE_MISSING', message: msg };
    }
    if (!extractEntityCryptoKey(targetEntityId)) {
      const msg = `Recipient ${targetEntityId} profile has no encryption key`;
      return { code: 'PAYMENT_PREFLIGHT_KEY_MISSING', message: msg, details: { targetProfile } };
    }
    return null;
  }

  function getMissingRouteKeys(path: string[]): string[] {
    const missingSet = new Set<string>();
    for (const hopEntity of path.slice(1)) {
      if (!extractEntityCryptoKey(hopEntity)) {
        missingSet.add(hopEntity);
      }
    }
    return Array.from(missingSet);
  }

  async function refreshGossipOnDemand(reason: string, targetEntities: string[]): Promise<void> {
    const env = currentEnv;
    if (!env) return;
    const xln = await getXLN();
    for (let attempt = 1; attempt <= GOSSIP_REFRESH_ATTEMPTS; attempt += 1) {
      emitUiDebugEvent('PAYMENT_PREFLIGHT_GOSSIP_REFRESH', `Refreshing gossip (${reason})`, {
        attempt,
        targetEntities,
      });
      try {
        xln.refreshGossip?.(env);
      } catch {
        // best effort only
      }
      try {
        env.runtimeState?.p2p?.refreshGossip?.();
      } catch {
        // best effort only
      }
      await sleep(GOSSIP_REFRESH_WAIT_MS * attempt);
    }
  }

  async function ensureRecipientProfileReady() {
    let issue = getRecipientProfileIssue();
    if (!issue) return;
    await refreshGossipOnDemand('recipient-profile', [targetEntityId]);
    issue = getRecipientProfileIssue();
    if (!issue) return;
    emitUiDebugEvent(issue.code, issue.message, issue.details || {});
    if (issue.code === 'PAYMENT_PREFLIGHT_KEY_MISSING') {
      throw new Error(`${issue.message}. Cannot build encrypted HTLC route.`);
    }
    throw new Error(`${issue.message}. Refresh gossip/hubs and retry.`);
  }

  async function ensureRouteKeyCoverage(path: string[]) {
    let missing = getMissingRouteKeys(path);
    if (missing.length === 0) return;
    await refreshGossipOnDemand('route-hop-keys', missing);
    missing = getMissingRouteKeys(path);
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

  async function refreshServerEntityNames() {
    if (typeof fetch === 'undefined') return;
    try {
      const response = await fetch('/api/health');
      if (!response.ok) return;
      const payload = await response.json();
      const hubs = Array.isArray(payload?.hubs) ? payload.hubs : [];
      const next = new Map<string, string>();
      for (const hub of hubs) {
        const id = String(hub?.entityId || '').trim();
        const name = String(hub?.name || '').trim();
        if (!id || !name) continue;
        next.set(normalizeEntityId(id), name);
      }
      if (next.size > 0) {
        serverEntityNames = next;
      }
    } catch {
      // best effort only
    }
  }

  // Enumerate simple paths up to a hop cap; for self-pay enumerate cycles back to self.
  function findPathsFromGraph(
    adjacency: Map<string, Set<string>>,
    startId: string,
    targetId: string,
    _token: number,
    maxCandidates: number = MAX_CANDIDATE_PATHS
  ): string[][] {
    const results: string[][] = [];
    const seen = new Set<string>();
    const isSelfTarget = startId === targetId;

    const pushPath = (path: string[]) => {
      const key = path.join('>');
      if (seen.has(key)) return;
      seen.add(key);
      results.push(path);
    };

    const dfs = (current: string, path: string[], used: Set<string>) => {
      if (results.length >= maxCandidates) return;
      const hops = path.length - 1;
      if (hops > MAX_PATH_HOPS) return;
      if (!isSelfTarget && current === targetId) {
        pushPath([...path]);
        return;
      }
      const neighbors = adjacency.get(current);
      if (!neighbors || neighbors.size === 0) return;

      for (const next of neighbors) {
        if (results.length >= maxCandidates) break;
        const nextHops = hops + 1;
        if (nextHops > MAX_PATH_HOPS) continue;
        if (isSelfTarget) {
          if (next === startId) {
            const intermediateCount = path.length - 1;
            if (nextHops >= MIN_SELF_CYCLE_INTERMEDIATES + 1 && intermediateCount >= MIN_SELF_CYCLE_INTERMEDIATES) {
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

    return results.sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      return a.join('>').localeCompare(b.join('>'));
    });
  }

  function sortRoutesList(input: RouteOption[]): RouteOption[] {
    return [...input].sort((a, b) => {
      if (routeSortMode === 'hops') {
        if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
        if (a.totalFee !== b.totalFee) return a.totalFee < b.totalFee ? -1 : 1;
        if (a.senderAmount !== b.senderAmount) return a.senderAmount < b.senderAmount ? -1 : 1;
        return a.path.length - b.path.length;
      }
      if (a.totalFee !== b.totalFee) return a.totalFee < b.totalFee ? -1 : 1;
      if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
      if (a.senderAmount !== b.senderAmount) return a.senderAmount < b.senderAmount ? -1 : 1;
      return a.path.length - b.path.length;
    });
  }

  function isValidRoutePath(path: string[], startId: string, targetId: string): boolean {
    if (!Array.isArray(path) || path.length < 2) return false;
    if (path[0] !== startId) return false;
    if (path[path.length - 1] !== targetId) return false;

    // Interior hops must be unique and must never include sender.
    const interior = path.slice(1, -1);
    if (interior.some((hop) => hop === startId)) return false;
    if (new Set(interior).size !== interior.length) return false;

    // Self routes must include enough intermediaries to make a valid cycle.
    if (startId === targetId) {
      if (interior.length < MIN_SELF_CYCLE_INTERMEDIATES) return false;
      if (new Set(interior).size < MIN_SELF_CYCLE_INTERMEDIATES) return false;
    }

    return true;
  }

  async function computeRoutes(preserveRepeatTimer = false) {
    if (!targetEntityId || !amount) return;

    findingRoutes = true;
    routeSortMode = 'fee';
    routes = [];
    selectedRouteIndex = -1;
    preflightError = null;
    if (!preserveRepeatTimer) {
      clearRepeatTimer();
    }

    try {
      await getXLN();
      const env = currentEnv;
      if (!env) throw new Error('Environment not ready');
      await ensureRecipientProfileReady();

      const amountInSmallestUnit = parseAmountToWei(amount, getTokenDecimals(tokenId));
      if (amountInSmallestUnit <= 0n) {
        throw new Error('Amount must be greater than zero');
      }

      if (!currentReplicas) throw new Error('Replicas not available');
      const sourceNorm = normalizeEntityId(entityId);
      const targetNorm = normalizeEntityId(targetEntityId);
      const network = buildNetworkAdjacency(env, currentReplicas);
      const isSelfTarget = sourceNorm === targetNorm;
      const pathSet = new Set<string>();
      const foundPaths: string[][] = [];
      const pushPath = (rawPath: unknown) => {
        if (!Array.isArray(rawPath)) return;
        const normalizedPath = rawPath
          .map((id) => normalizeEntityId(String(id || '')))
          .filter(Boolean);
        if (!isValidRoutePath(normalizedPath, sourceNorm, targetNorm)) return;
        const intermediaries = normalizedPath.slice(1, -1);
        if (intermediaries.some((hop) => !isRouteableIntermediary(hop))) return;
        const key = normalizedPath.join('>');
        if (pathSet.has(key)) return;
        pathSet.add(key);
        foundPaths.push(normalizedPath);
      };

      const runtimeGraph = env?.gossip?.getNetworkGraph?.();
      try {
        const runtimeRoutes = await runtimeGraph?.findPaths?.(entityId, targetEntityId, amountInSmallestUnit, tokenId) || [];
        for (const route of runtimeRoutes) {
          pushPath((route as any)?.path);
        }
      } catch {
        // Local graph fallback remains authoritative when runtime graph cannot resolve cycles.
      }

      // Always include local graph candidates (best-effort with real local capacities).
      const localPaths = findPathsFromGraph(network.adjacency, sourceNorm, targetNorm, tokenId);
      for (const path of localPaths) pushPath(path);

      if (foundPaths.length === 0) {
        if (isSelfTarget) {
          throw new Error('No self-route found with at least 2 different intermediates');
        }
        throw new Error(`No route found to ${targetEntityId}`);
      }

      const quotedRoutes: RouteOption[] = [];
      for (const normalizedPath of foundPaths) {
        const path = normalizedPath.map((id) => network.canonicalIds.get(id) || id);
        const intermediaries = path.slice(1, -1);
        let downstreamAmount = amountInSmallestUnit;
        const intermediaryFeeByEntity = new Map<string, { fee: bigint; feePPM: number }>();
        let hasCapacity = true;
        for (let i = intermediaries.length - 1; i >= 0; i -= 1) {
          const intermediary = intermediaries[i]!;
          const nextHop = path[i + 2]!;
          const quote = quoteHop(intermediary, nextHop, tokenId, downstreamAmount);
          if (!quote || quote.outCap < downstreamAmount) {
            hasCapacity = false;
            break;
          }
          const requiredInbound = quoteRequiredInboundForForward(downstreamAmount, quote.feePPM, quote.baseFee);
          intermediaryFeeByEntity.set(intermediary, {
            fee: requiredInbound - downstreamAmount,
            feePPM: quote.feePPM,
          });
          downstreamAmount = requiredInbound;
        }
        if (!hasCapacity) continue;

        if (path.length > 1) {
          const senderQuote = quoteHop(path[0]!, path[1]!, tokenId, downstreamAmount);
          if (!senderQuote || senderQuote.outCap < downstreamAmount) {
            continue;
          }
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
        const totalFee = senderAmount - amountInSmallestUnit;
        quotedRoutes.push({
          path,
          hops,
          totalFee,
          senderAmount,
          recipientAmount: amountInSmallestUnit,
        });
      }

      routes = sortRoutesList(quotedRoutes).slice(0, MAX_ROUTES);

      if (routes.length === 0) {
        throw new Error('No route has enough real capacity for this amount');
      }

      for (const route of routes) {
        await ensureRouteKeyCoverage(route.path);
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

  async function findRoutes() {
    await computeRoutes(false);
  }

  async function sendPayment(manual = true) {
    if (selectedRouteIndex < 0 || !routes[selectedRouteIndex]) return;
    if (sendingPayment) return;

    sendingPayment = true;
    try {
      await getXLN();
      const env = currentEnv;
      if (!env) throw new Error('Environment not ready');
      if (!activeIsLive) throw new Error('Payments are only available in LIVE mode');
      preflightError = null;
      await ensureRecipientProfileReady();

      // Timer-driven sends must refresh route quotes to avoid reusing stale capacities.
      if (!manual) {
        await computeRoutes(true);
      }

      const route = routes[selectedRouteIndex];
      if (!route) throw new Error('Selected route is no longer available');
      await ensureRouteKeyCoverage(route.path);
      const routeTargetEntityId = route.path[route.path.length - 1] || targetEntityId;

      const signerId = activeXlnFunctions?.resolveEntityProposerId?.(env, entityId, 'payment-panel')
        || requireSignerIdForEntity(env, entityId, 'payment-panel');

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
              targetEntityId: routeTargetEntityId,
              tokenId,
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
              targetEntityId: routeTargetEntityId, tokenId,
              amount: route.recipientAmount,
              route: route.path,
              description: description || undefined,
            },
          }],
        };
      }

      await enqueueEntityInputs(env, [paymentInput]);
      console.log(`[Send] ${useHtlc ? 'HTLC' : 'Direct'} payment sent via:`, route.path.join(' -> '));
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

  function handleRouteSortChange(event: Event) {
    const target = event.target as HTMLSelectElement | null;
    if (!target) return;
    if (target.value === 'hops' || target.value === 'fee') {
      routeSortMode = target.value;
      if (routes.length > 1) {
        routes = sortRoutesList(routes);
        selectedRouteIndex = routes.length > 0 ? 0 : -1;
      }
    }
  }

  onMount(() => {
    void refreshServerEntityNames();
  });
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
          {#if normalizeEntityId(targetEntityId) === normalizeEntityId(entityId)}
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
        {:else if normalizeEntityId(targetEntityId) === normalizeEntityId(entityId)}
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
      <div class="routes-header">
        <h4>Routes ({routes.length})</h4>
        <div class="route-controls">
          <label class="route-sort-control">
            <span>Sort</span>
            <select value={routeSortMode} on:change={handleRouteSortChange} disabled={sendingPayment || findingRoutes}>
              {#each ROUTE_SORT_OPTIONS as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="route-id-toggle">
            <input type="checkbox" bind:checked={showFullEntityId} />
            <span>Show full entity id</span>
          </label>
        </div>
      </div>
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
                      showAddress={showFullEntityId}
                      size={24}
                    />
                  </div>
                  {#if hopIndex < route.path.length - 1}
                    <span class="hop-arrow">→</span>
                    {#if route.hops[hopIndex] && route.hops[hopIndex].fee > 0n}
                      <span class="hop-fee">({formatToken(route.hops[hopIndex].fee)})</span>
                    {/if}
                  {/if}
                {/each}
              </div>
              <span class="route-meta">
                {route.hops.length} hop{route.hops.length !== 1 ? 's' : ''}
              </span>
              <span class="route-meta">
                Total fee: {formatToken(route.totalFee)}
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

  .routes-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .routes h4 {
    font-size: 12px;
    font-weight: 500;
    color: #78716c;
    margin: 0;
  }

  .route-sort-control {
    display: flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    font-size: 10px;
    color: #78716c;
  }

  .route-sort-control select {
    height: 30px;
    border-radius: 6px;
    border: 1px solid #292524;
    background: #1c1917;
    color: #e7e5e4;
    font-size: 11px;
    padding: 0 8px;
    font-family: inherit;
  }

  .route-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .route-id-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    text-transform: none;
    letter-spacing: 0;
    font-size: 12px;
    color: #a8a29e;
    font-weight: 400;
  }

  .route-id-toggle input[type="checkbox"] {
    width: 14px;
    height: 14px;
    margin: 0;
    accent-color: #fbbf24;
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

  .hop-fee {
    color: #d6d3d1;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
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
