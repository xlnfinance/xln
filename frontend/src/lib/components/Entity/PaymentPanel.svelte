<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import type {
    AccountMachine,
    DerivedDelta,
    RoutedEntityInput as EntityInputPayload,
    EntityReplica,
    Env,
    PaymentRoute,
    PersistedFrameJournal,
    Profile as GossipProfile,
  } from '@xln/runtime/xln-api';
  import { getXLN, xlnEnvironment, replicas, xlnFunctions, enqueueEntityInputs } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import { routePreview } from '../../stores/routePreviewStore';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import { toasts } from '$lib/stores/toastStore';
  import { safeStringify } from '$lib/utils/safeStringify';
  import { keccak256, AbiCoder, hexlify } from 'ethers';
  import EntityInput from '../shared/EntityInput.svelte';
  import TokenSelect from '../shared/TokenSelect.svelte';
  import EntityIdentity from '../shared/EntityIdentity.svelte';

  export let entityId: string;
  export let contacts: Array<{ name: string; entityId: string }> = [];

  // Form state
  let targetEntityId = '';
  let amount = '';
  let tokenId = 1;
  let description = '';
  let descriptionLocked = false;
  let useHtlc = true; // Hashlock by default (atomic), optional direct (unsafe)
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
  let paymentPanelEl: HTMLDivElement | null = null;
  let hostedCheckoutMode = false;
  let hostedCheckoutRouteKey = '';
  let hostedCheckoutPreparing = false;
  let hostedCheckoutAwaitingConfirmation = false;
  let hostedCheckoutPendingHashlock: string | null = null;
  let hostedCheckoutStatusMessage = '';
  let hostedCheckoutSuccessVisible = false;
  let hostedCheckoutWatcherToken = 0;
  let hostedCheckoutCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let hostedCheckoutShutdownStarted = false;
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

  type TokenCapacityValue = {
    inCapacity: bigint | string;
    outCapacity: bigint | string;
  };

  type TokenCapacities =
    | Map<number | string, TokenCapacityValue>
    | Record<string, TokenCapacityValue>;

  type GossipAccount = NonNullable<GossipProfile['accounts']>[number];
  type DebugEventP2P = {
    sendDebugEvent?: (data: unknown) => unknown;
  };
  type RuntimeP2PController = {
    close?: () => void;
  };
  type RuntimeStateEnv = Env & {
    runtimeState?: {
      p2p?: RuntimeP2PController;
    };
  };
  type SendPaymentResult = {
    queued: boolean;
    hashlock: string | null;
  };
  type PersistedFrameLogEntry = PersistedFrameJournal['logs'][number];

  $: currentReplicas = $replicas;
  $: currentEnv = $xlnEnvironment;
  $: activeXlnFunctions = $xlnFunctions;
  $: activeIsLive = $globalIsLive;

  const getGossipProfiles = (): GossipProfile[] => currentEnv?.gossip?.getProfiles?.() || [];

  const normalizeEntityId = (id: string | null | undefined): string => String(id || '').trim().toLowerCase();

  const sanitizePrefillText = (raw: string | null | undefined, maxLen = 180): string => {
    const value = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!value) return '';
    return value.slice(0, maxLen);
  };

  const parseBooleanParam = (raw: string | null | undefined): boolean => {
    const value = String(raw || '').trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
  };

  function getURLHashRoute(): string | null {
    if (typeof window === 'undefined') return null;
    const hashRaw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (!hashRaw) return null;
    const qIndex = hashRaw.indexOf('?');
    const routePart = qIndex >= 0 ? hashRaw.slice(0, qIndex) : hashRaw;
    if (!routePart || routePart.includes('=')) return null;
    return routePart.trim().toLowerCase() || null;
  }

  function getURLHashParams(): URLSearchParams | null {
    if (typeof window === 'undefined') return null;
    const hashRaw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (!hashRaw) return null;
    const qIndex = hashRaw.indexOf('?');
    if (qIndex >= 0) {
      const routePart = hashRaw.slice(0, qIndex);
      if (!routePart.includes('=')) {
        return new URLSearchParams(hashRaw.slice(qIndex + 1));
      }
    }
    return hashRaw.includes('=') ? new URLSearchParams(hashRaw) : null;
  }

  function getURLParamValue(keys: string[]): string | null {
    if (typeof window === 'undefined') return null;
    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = getURLHashParams();
    for (const key of keys) {
      const hashValue = hashParams ? hashParams.get(key) : null;
      if (hashValue !== null && hashValue !== '') return hashValue;
      const queryValue = searchParams.get(key);
      if (queryValue !== null && queryValue !== '') return queryValue;
    }
    return null;
  }

  function applyPaymentPrefillFromURL() {
    const hashRoute = getURLHashRoute();
    const targetParam = sanitizePrefillText(getURLParamValue(['id', 'target', 'targetEntityId', 'recipient', 'entity']), 120);
    const amountParam = sanitizePrefillText(getURLParamValue(['amt', 'amount']), 64);
    const tokenParam = sanitizePrefillText(getURLParamValue(['t', 'tokenId', 'token']), 12);
    const noteParam = sanitizePrefillText(getURLParamValue(['desc', 'note', 'description', 'memo']), 200);
    const recipientUserId = sanitizePrefillText(getURLParamValue(['u', 'uid', 'recipient_user_id', 'userId', 'recipientId']), 96);
    const modeParam = sanitizePrefillText(getURLParamValue(['mode']), 16).toLowerCase();
    const noteLockedParam = getURLParamValue(['locked', 'note_locked', 'description_locked', 'memo_locked', 'lock_note']);
    const checkoutParam = getURLParamValue(['checkout', 'autoclose', 'close']);

    if (targetParam) targetEntityId = targetParam;
    if (amountParam) amount = amountParam;
    if (tokenParam) {
      const parsedTokenId = Number(tokenParam);
      if (Number.isFinite(parsedTokenId) && parsedTokenId > 0) {
        tokenId = Math.floor(parsedTokenId);
      }
    }

    const noteParts: string[] = [];
    if (noteParam) noteParts.push(noteParam);
    if (recipientUserId) noteParts.push(`uid:${recipientUserId}`);
    if (noteParts.length > 0) {
      description = noteParts.join(' | ');
    }

    if (modeParam === 'direct' || modeParam === 'unsafe') useHtlc = false;
    if (modeParam === 'hashlock' || modeParam === 'htlc') useHtlc = true;
    if (hashRoute === 'pay' && !modeParam) useHtlc = true;
    hostedCheckoutMode =
      hashRoute === 'pay' &&
      (parseBooleanParam(checkoutParam) || Boolean(targetParam || amountParam || noteParam || recipientUserId));
    if (hostedCheckoutMode) useHtlc = true;

    const explicitLock = parseBooleanParam(noteLockedParam);
    descriptionLocked = explicitLock || Boolean(recipientUserId);
    hostedCheckoutSuccessVisible = false;
    hostedCheckoutAwaitingConfirmation = false;
    hostedCheckoutPendingHashlock = null;
    hostedCheckoutStatusMessage = '';
    hostedCheckoutRouteKey = '';
  }

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
    const profiles = getGossipProfiles();
    const targetNorm = normalizeEntityId(targetEntityId);
    return profiles.find((profile) => normalizeEntityId(profile.entityId) === targetNorm);
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

  const clearHostedCheckoutCloseTimer = () => {
    if (hostedCheckoutCloseTimer) {
      clearTimeout(hostedCheckoutCloseTimer);
      hostedCheckoutCloseTimer = null;
    }
  };

  const cancelHostedCheckoutWatcher = () => {
    hostedCheckoutWatcherToken += 1;
    hostedCheckoutAwaitingConfirmation = false;
    hostedCheckoutPendingHashlock = null;
    clearHostedCheckoutCloseTimer();
  };

  async function shutdownHostedCheckoutRuntime(): Promise<void> {
    if (!hostedCheckoutMode || hostedCheckoutShutdownStarted) return;
    hostedCheckoutShutdownStarted = true;
    const env = currentEnv as RuntimeStateEnv | null;
    if (!env) return;

    try {
      env.runtimeState?.p2p?.close?.();
    } catch {
      // best effort
    }

    try {
      const xln = await getXLN();
      xln.stopP2P(env);
    } catch {
      // best effort
    }
  }

  async function closeHostedCheckoutWindow(): Promise<void> {
    await shutdownHostedCheckoutRuntime();
    window.close();
  }

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
    cancelHostedCheckoutWatcher();
    if (hostedCheckoutMode) {
      void shutdownHostedCheckoutRuntime();
    }
  });

  async function scrollHostedCheckoutIntoView(): Promise<void> {
    if (!hostedCheckoutMode) return;
    await tick();
    paymentPanelEl?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }

  function resetQuotedRoutes(): void {
    routes = [];
    selectedRouteIndex = -1;
    hostedCheckoutRouteKey = '';
    clearRepeatTimer();
  }

  function getEntityName(id: string): string {
    if (!id) return 'Unknown';
    const norm = normalizeEntityId(id);
    if (norm === normalizeEntityId(entityId)) return 'Self';
    const contact = selectorContacts.find((c) => normalizeEntityId(c.entityId) === norm);
    if (contact?.name) return contact.name;
    const serverName = serverEntityNames.get(norm);
    if (serverName) return serverName;
    const profile = getGossipProfiles().find((p) => normalizeEntityId(p.entityId) === norm);
    const metaName = profile?.metadata?.name;
    return typeof metaName === 'string' && metaName.trim() ? metaName.trim() : id;
  }

  function getGossipProfileByEntityId(id: string): GossipProfile | undefined {
    const norm = normalizeEntityId(id);
    if (!norm) return undefined;
    return getGossipProfiles().find((p) => normalizeEntityId(p.entityId) === norm);
  }

  function isRouteableIntermediary(entity: string): boolean {
    // Routeability is a transport/security property, not a display-metadata property.
    // A hop is routeable iff we can encrypt for it and it is hub-like when profile exists.
    if (!extractEntityCryptoKey(entity)) return false;
    const profile = getGossipProfileByEntityId(entity);
    if (!profile) return true; // allow local+gossip mixed discovery; key coverage is enforced above
    const metadata = profile.metadata || {};
    return metadata.isHub === true || profile.capabilities.includes('hub') || profile.capabilities.includes('routing');
  }

  function formatToken(value: bigint): string {
    try {
      if (activeXlnFunctions?.formatTokenAmount) return activeXlnFunctions.formatTokenAmount(tokenId, value);
    } catch {
      // best effort formatting
    }
    return value.toString();
  }

  function formatTokenNumberOnly(value: bigint): string {
    const raw = formatToken(value);
    const symbol = String(activeXlnFunctions?.getTokenInfo?.(tokenId)?.symbol || '').trim();
    if (!symbol) return raw;
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return raw.replace(new RegExp(`\\s+${escaped}\\s*$`, 'i'), '').trim();
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
  function buildNetworkAdjacency(
    env: Env | null | undefined,
    replicaMap: Map<string, EntityReplica>,
  ): AdjacencyBuildResult {
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
    for (const [replicaKey, replica] of replicaMap.entries()) {
      const [entId] = replicaKey.split(':');
      if (!entId || !replica.state?.accounts) continue;
      for (const counterpartyId of replica.state.accounts.keys()) {
        addEdge(entId, String(counterpartyId));
      }
    }

    // Source 2: Gossip profiles (network-wide account graph)
    const profiles = env?.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      rememberCanonical(profile.entityId);
      if (!profile.accounts) continue;
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

  function sanitizeFeePPM(raw: unknown, defaultFeePPM = 10): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return defaultFeePPM;
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
      try {
        const v = BigInt(raw.trim());
        return v < 0n ? 0n : v;
      } catch {
        return 0n;
      }
    }
    return 0n;
  }

  function getTokenCapacitySnapshot(tokenCapacities: TokenCapacities | undefined, token: number): { outCapacity: bigint; inCapacity: bigint } | null {
    if (!tokenCapacities) return null;
    const tokenCap = tokenCapacities instanceof Map
      ? tokenCapacities.get(token) ?? tokenCapacities.get(String(token))
      : tokenCapacities[String(token)];
    if (!tokenCap) return null;
    const outCapacity = sanitizeBigInt(tokenCap?.outCapacity ?? 0n);
    const inCapacity = sanitizeBigInt(tokenCap?.inCapacity ?? 0n);
    if (outCapacity <= 0n && inCapacity <= 0n) return null;
    return { outCapacity, inCapacity };
  }

  function getGossipAccountCapacity(owner: string, counterparty: string, token: number): { outCapacity: bigint; inCapacity: bigint } | null {
    const ownerNorm = normalizeEntityId(owner);
    const cpNorm = normalizeEntityId(counterparty);
    const profile = getGossipProfiles().find((p) => normalizeEntityId(p.entityId) === ownerNorm);
    if (!profile || !Array.isArray(profile.accounts)) return null;
    const account = profile.accounts.find((a) => normalizeEntityId(a.counterpartyId) === cpNorm);
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
      const accounts = replica?.state?.accounts;
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
        const derived = activeXlnFunctions.deriveDelta(delta, isLeft) as DerivedDelta;
        const outCapacity = sanitizeBigInt(derived.outCapacity);
        const inCapacity = sanitizeBigInt(derived.inCapacity);
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
    const profile = getGossipProfiles().find((p) => normalizeEntityId(p.entityId) === fromNorm);
    const basePpm = sanitizeFeePPM(
      profile?.metadata?.routingFeePPM ?? DEFAULT_UNKNOWN_HOP_FEE_PPM,
      DEFAULT_UNKNOWN_HOP_FEE_PPM
    );
    const baseFee = sanitizeBigInt(profile?.metadata?.baseFee ?? 0n);
    const account = Array.isArray(profile?.accounts)
      ? profile.accounts.find((a) => normalizeEntityId(a.counterpartyId) === toNorm)
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
    const profile = getGossipProfiles().find((p) => normalizeEntityId(p.entityId) === entityNorm);
    if (!profile) return null;
    const gossipCandidates = [
      profile?.metadata?.cryptoPublicKey,
      profile?.metadata?.encryptionPublicKey,
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
      const p2p = currentEnv?.runtimeState?.p2p as DebugEventP2P | null | undefined;
      if (typeof p2p?.sendDebugEvent === 'function') p2p.sendDebugEvent(payload);
    } catch {
      // Best effort only; never block UI on debug forwarding.
    }
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function getRecipientProfileIssue(): { code: string; message: string; details?: Record<string, unknown> } | null {
    if (!targetEntityId || normalizeEntityId(targetEntityId) === normalizeEntityId(entityId)) return null;
    const profiles = getGossipProfiles();
    const targetNorm = normalizeEntityId(targetEntityId);
    const targetProfile = profiles.find((p) => normalizeEntityId(p.entityId) === targetNorm);
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
    if (targetEntities.length > 0 && typeof xln.ensureGossipProfiles === 'function') {
      emitUiDebugEvent('PAYMENT_PREFLIGHT_GOSSIP_FETCH', `Fetching gossip profiles (${reason})`, {
        targetEntities,
      });
      try {
        const resolved = await xln.ensureGossipProfiles(env, targetEntities);
        if (resolved) return;
      } catch {
        // fall back to coarse refresh loop below
      }
    }
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
        const runtimeRoutes: PaymentRoute[] =
          await runtimeGraph?.findPaths?.(entityId, targetEntityId, amountInSmallestUnit, tokenId) || [];
        for (const route of runtimeRoutes) {
          pushPath(route.path);
        }
      } catch {}

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

  async function autoPrepareHostedCheckout(checkoutKey: string): Promise<void> {
    if (!hostedCheckoutMode || hostedCheckoutPreparing) return;
    hostedCheckoutPreparing = true;
    hostedCheckoutStatusMessage = 'Preparing payment route';
    try {
      await scrollHostedCheckoutIntoView();
      await computeRoutes(false);
      if (hostedCheckoutRouteKey !== checkoutKey) return;
      if (routes.length > 0) {
        selectedRouteIndex = 0;
        hostedCheckoutStatusMessage = 'Route ready';
      }
    } finally {
      hostedCheckoutPreparing = false;
    }
  }

  async function payNowCheapest() {
    if (sendingPayment || findingRoutes) return;
    await computeRoutes(false);
    if (routes.length === 0) return;
    selectedRouteIndex = 0; // routes are sorted by cheapest fee by default
    await sendPayment(true);
  }

  function getPersistedLogData(entry: PersistedFrameLogEntry): Record<string, unknown> {
    const data = entry?.data;
    return data && typeof data === 'object' ? data : {};
  }

  async function waitForHostedCheckoutConfirmation(hashlock: string, fromHeight: number): Promise<void> {
    if (!hostedCheckoutMode) return;
    const env = currentEnv;
    if (!env) return;
    const xln = await getXLN();
    if (
      typeof xln.getPersistedLatestHeight !== 'function' ||
      typeof xln.readPersistedFrameJournal !== 'function'
    ) {
      return;
    }

    const watcherToken = ++hostedCheckoutWatcherToken;
    hostedCheckoutAwaitingConfirmation = true;
    hostedCheckoutPendingHashlock = hashlock;
    hostedCheckoutStatusMessage = 'Waiting for persisted confirmation';
    hostedCheckoutSuccessVisible = false;
    clearHostedCheckoutCloseTimer();
    await scrollHostedCheckoutIntoView();

    const targetEntity = normalizeEntityId(entityId);
    const targetHashlock = String(hashlock).toLowerCase();
    let nextHeight = Math.max(1, fromHeight);
    const deadlineAt = Date.now() + 45_000;

    try {
      while (Date.now() < deadlineAt) {
        if (watcherToken !== hostedCheckoutWatcherToken) return;
        const latestHeight = await xln.getPersistedLatestHeight(env);
        for (let height = nextHeight; height <= latestHeight; height += 1) {
          if (watcherToken !== hostedCheckoutWatcherToken) return;
          const receipt = await xln.readPersistedFrameJournal(env, height);
          const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
          for (const entry of logs) {
            if (entry.message !== 'PaymentFinalized' && entry.message !== 'PaymentFailed') continue;
            const data = getPersistedLogData(entry);
            const logHashlock = typeof data.hashlock === 'string' ? data.hashlock.toLowerCase() : '';
            if (logHashlock !== targetHashlock) continue;
            const logEntity =
              typeof data.entityId === 'string'
                ? normalizeEntityId(data.entityId)
                : normalizeEntityId(entry.entityId);
            if (logEntity && logEntity !== targetEntity) continue;
            if (entry.message === 'PaymentFailed') {
              const reason = typeof data.reason === 'string' ? data.reason : 'Payment failed';
              throw new Error(reason);
            }

            hostedCheckoutAwaitingConfirmation = false;
            hostedCheckoutPendingHashlock = hashlock;
            hostedCheckoutStatusMessage = 'Confirmed. Closing checkout...';
            hostedCheckoutSuccessVisible = true;
            toasts.success('Payment confirmed');
            await scrollHostedCheckoutIntoView();
            clearRepeatTimer();
            clearHostedCheckoutCloseTimer();
            hostedCheckoutCloseTimer = setTimeout(() => {
              void closeHostedCheckoutWindow();
            }, 900);
            return;
          }
        }
        nextHeight = latestHeight + 1;
        await sleep(250);
      }
      throw new Error('Timed out waiting for persisted payment confirmation');
    } catch (error) {
      if (watcherToken !== hostedCheckoutWatcherToken) return;
      hostedCheckoutAwaitingConfirmation = false;
      hostedCheckoutSuccessVisible = false;
      const message = error instanceof Error ? error.message : String(error);
      hostedCheckoutStatusMessage = message;
      preflightError = message;
      toasts.error(`Payment confirmation failed: ${message}`);
    }
  }

  async function sendPayment(manual = true): Promise<SendPaymentResult> {
    if (selectedRouteIndex < 0 || !routes[selectedRouteIndex]) return { queued: false, hashlock: null };
    if (sendingPayment) return { queued: false, hashlock: null };

    sendingPayment = true;
    try {
      const xln = await getXLN();
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

      const descriptionValue = description.trim();
      let paymentInput: EntityInputPayload;
      let queuedHashlock: string | null = null;
      const persistedStartHeight =
        hostedCheckoutMode && manual && typeof xln.getPersistedLatestHeight === 'function'
          ? await xln.getPersistedLatestHeight(env)
          : 0;

      if (useHtlc) {
        // Hashlock: atomic multi-hop with hashlock
        const { secret, hashlock } = generateSecretHashlock();
        console.log(`[Send] Hashlock secret=${secret.slice(0,16)}... hashlock=${hashlock.slice(0,16)}...`);
        queuedHashlock = hashlock;
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
              secret, hashlock,
              ...(descriptionValue ? { description: descriptionValue } : {}),
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
              ...(descriptionValue ? { description: descriptionValue } : {}),
            },
          }],
        };
      }

      await enqueueEntityInputs(env, [paymentInput]);
      console.log(`[Send] ${useHtlc ? 'Hashlock' : 'Direct (unsafe)'} payment sent via:`, route.path.join(' -> '));
      if (hostedCheckoutMode && manual && queuedHashlock) {
        void waitForHostedCheckoutConfirmation(queuedHashlock, persistedStartHeight + 1);
      }
      return { queued: true, hashlock: queuedHashlock };
    } catch (error) {
      console.error('[Send] Payment failed:', error);
      preflightError = (error as Error)?.message || 'Unknown send error';
      toasts.error(`Payment failed: ${preflightError}`);
      return { queued: false, hashlock: null };
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
    hostedCheckoutStatusMessage = '';
    hostedCheckoutSuccessVisible = false;
    resetQuotedRoutes();
  }

  function handleRecipientPickerOpen() {
    void refreshGossipOnDemand(
      'recipient-picker-open',
      targetEntityId ? [targetEntityId] : [],
    );
    void refreshServerEntityNames();
  }

  function handleTokenChange(e: CustomEvent) {
    tokenId = e.detail.value;
    preflightError = null;
    hostedCheckoutStatusMessage = '';
    hostedCheckoutSuccessVisible = false;
    resetQuotedRoutes();
  }

  function handleAmountInput() {
    preflightError = null;
    hostedCheckoutStatusMessage = '';
    hostedCheckoutSuccessVisible = false;
    resetQuotedRoutes();
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

  $: hostedCheckoutAutoKey =
    hostedCheckoutMode
      ? `${normalizeEntityId(entityId)}|${normalizeEntityId(targetEntityId)}|${tokenId}|${amount.trim()}|${description.trim()}`
      : '';

  $: if (
    hostedCheckoutMode &&
    hostedCheckoutAutoKey &&
    activeIsLive &&
    currentEnv &&
    currentReplicas &&
    !findingRoutes &&
    !sendingPayment &&
    !hostedCheckoutAwaitingConfirmation &&
    routes.length === 0 &&
    hostedCheckoutRouteKey !== hostedCheckoutAutoKey
  ) {
    hostedCheckoutRouteKey = hostedCheckoutAutoKey;
    void autoPrepareHostedCheckout(hostedCheckoutAutoKey);
  }

  $: hostedCheckoutBannerMessage = (() => {
    if (!hostedCheckoutMode) return '';
    if (hostedCheckoutSuccessVisible) return 'Persisted confirmation received';
    if (hostedCheckoutAwaitingConfirmation) return 'Waiting for persisted confirmation';
    if (findingRoutes || hostedCheckoutPreparing) return 'Finding best route';
    if (routes.length > 0) return 'Route ready';
    return 'Preparing payment';
  })();

  onMount(() => {
    applyPaymentPrefillFromURL();
    void scrollHostedCheckoutIntoView();
    void refreshServerEntityNames();
    const handleLocationChange = () => {
      applyPaymentPrefillFromURL();
      void scrollHostedCheckoutIntoView();
    };
    const handleHostedCheckoutPageHide = () => {
      if (!hostedCheckoutMode) return;
      void shutdownHostedCheckoutRuntime();
    };
    window.addEventListener('hashchange', handleLocationChange);
    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('pagehide', handleHostedCheckoutPageHide);
    window.addEventListener('beforeunload', handleHostedCheckoutPageHide);
    return () => {
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('pagehide', handleHostedCheckoutPageHide);
      window.removeEventListener('beforeunload', handleHostedCheckoutPageHide);
    };
  });
</script>

<div bind:this={paymentPanelEl} class="payment-panel" class:hosted-checkout={hostedCheckoutMode}>
  {#if hostedCheckoutMode}
    <div class="hosted-checkout-banner">
      <div class="hosted-checkout-copy">
        <span class="hosted-checkout-eyebrow">Hosted Checkout</span>
        <strong>{hostedCheckoutBannerMessage}</strong>
        <span>Review the payment details below, then confirm with Pay Now.</span>
      </div>
      <div class="hosted-checkout-summary">
        <span>{amount || '0.00'} {activeXlnFunctions?.getTokenInfo?.(tokenId)?.symbol || 'token'}</span>
        <span>{getEntityName(targetEntityId || entityId)}</span>
      </div>
    </div>
  {/if}

  <EntityInput
    label="Recipient"
    value={targetEntityId}
    entities={allEntities}
    contacts={selectorContacts}
    excludeId=""
    placeholder="Select recipient..."
    disabled={findingRoutes || sendingPayment}
    on:change={handleTargetChange}
    on:open={handleRecipientPickerOpen}
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
        on:input={handleAmountInput}
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
    <label>Description {descriptionLocked ? '(locked)' : '(optional)'}</label>
    <input
      type="text"
      bind:value={description}
      placeholder="Payment for..."
      readonly={descriptionLocked}
      aria-readonly={descriptionLocked}
      disabled={findingRoutes || sendingPayment}
    />
    {#if descriptionLocked}
      <small class="description-lock-hint">Recipient user id is locked into this payment note.</small>
    {/if}
  </div>

  <div class="mode-toggle">
    <span class="mode-label">Mode</span>
    <div class="mode-switch" role="group" aria-label="Payment mode">
      <button
        type="button"
        class="mode-btn"
        class:active={useHtlc}
        aria-pressed={useHtlc}
        disabled={hostedCheckoutMode || findingRoutes || sendingPayment}
        on:click={() => (useHtlc = true)}
      >
        Hashlock
      </button>
      <button
        type="button"
        class="mode-btn unsafe"
        class:active={!useHtlc}
        aria-pressed={!useHtlc}
        disabled={hostedCheckoutMode || findingRoutes || sendingPayment}
        on:click={() => (useHtlc = false)}
      >
        Direct (unsafe)
      </button>
    </div>
    <span class="mode-state" class:safe={useHtlc} class:unsafe={!useHtlc}>
      {useHtlc ? 'Hashlock active' : 'Direct active (unsafe)'}
    </span>
  </div>

  <div class="payment-actions">
    <button
      class="btn-pay-now"
      on:click={payNowCheapest}
      disabled={!targetEntityId || !amount || findingRoutes || sendingPayment || !activeIsLive}
    >
      {sendingPayment ? 'Sending...' : (findingRoutes ? 'Finding Routes...' : 'Pay Now')}
    </button>
    <button
      class="btn-find"
      on:click={findRoutes}
      disabled={!targetEntityId || !amount || findingRoutes || sendingPayment}
    >
      {findingRoutes ? 'Finding Routes...' : 'Find Routes'}
    </button>
  </div>

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
                      <span class="hop-fee">({formatTokenNumberOnly(route.hops[hopIndex].fee)})</span>
                    {/if}
                  {/if}
                {/each}
              </div>
              <span class="route-meta">
                {route.hops.length} hop{route.hops.length !== 1 ? 's' : ''}
              </span>
              <span class="route-meta">
                Fee: {formatTokenNumberOnly(route.totalFee)}
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
        {sendingPayment ? 'Sending...' : (useHtlc ? 'Send Hashlock Payment' : 'Send Direct Payment')}
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

  {#if hostedCheckoutSuccessVisible}
    <div class="checkout-success" role="status" aria-live="polite">
      <div class="checkout-success-title">Confirmed</div>
      <div class="checkout-success-body">{hostedCheckoutStatusMessage || 'Payment settled. Closing checkout...'}</div>
    </div>
  {/if}
</div>

<style>
  .payment-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .payment-panel.hosted-checkout {
    position: relative;
    padding: 18px;
    border-radius: 18px;
    border: 1px solid rgba(34, 197, 94, 0.28);
    background:
      radial-gradient(circle at top right, rgba(34, 197, 94, 0.12), transparent 38%),
      linear-gradient(180deg, rgba(10, 16, 12, 0.96), rgba(10, 12, 14, 0.98));
    box-shadow: 0 28px 70px rgba(0, 0, 0, 0.32);
  }

  .hosted-checkout-banner {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 14px;
    align-items: center;
    padding: 14px 16px;
    border-radius: 14px;
    border: 1px solid rgba(34, 197, 94, 0.2);
    background: rgba(6, 10, 8, 0.72);
  }

  .hosted-checkout-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: #d6f5dd;
  }

  .hosted-checkout-copy strong {
    font-size: 15px;
    letter-spacing: -0.02em;
  }

  .hosted-checkout-copy span:last-child {
    color: #9fb9a6;
    font-size: 12px;
  }

  .hosted-checkout-eyebrow {
    color: #7dd3a5;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .hosted-checkout-summary {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 180px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(15, 23, 18, 0.95);
    border: 1px solid rgba(22, 163, 74, 0.24);
    color: #ecfdf3;
    text-align: right;
    font-size: 12px;
    font-weight: 600;
  }

  .hosted-checkout-summary span:first-child {
    font-size: 16px;
    letter-spacing: -0.03em;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    align-items: end;
  }

  .row :global(.token-select) {
    width: 100%;
  }

  .row :global(.token-select .select-trigger) {
    min-height: 44px;
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

  .btn-find, .btn-send, .btn-pay-now {
    padding: 14px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .payment-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .btn-pay-now {
    background: linear-gradient(135deg, #15803d, #166534);
    border: 1px solid #166534;
    color: #dcfce7;
    font-weight: 700;
  }

  .btn-pay-now:hover:not(:disabled) {
    background: linear-gradient(135deg, #16a34a, #15803d);
    border-color: #22c55e;
  }

  .btn-pay-now:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
    padding: 10px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: 6px;
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
    gap: 3px;
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
    gap: 6px;
  }

  .hop-card {
    padding: 4px 6px;
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
    color: #a8a29e;
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
  }

  .route-meta {
    font-size: 10px;
    color: #71717a;
  }

  .mode-toggle {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .mode-label {
    color: #78716c;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .mode-switch {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px;
    border: 1px solid #31343d;
    border-radius: 11px;
    background: #12141a;
  }

  .mode-btn {
    border: 1px solid #2c2f38;
    border-radius: 8px;
    background: #161922;
    color: #9ca3af;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    padding: 9px 12px;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
    opacity: 0.72;
  }

  .mode-btn:hover:not(:disabled) {
    color: #e5e7eb;
    border-color: #4b5563;
  }

  .mode-btn.active {
    background: linear-gradient(180deg, rgba(34, 197, 94, 0.9), rgba(22, 163, 74, 0.84));
    border-color: #22c55e;
    color: #04130a;
    opacity: 1;
  }

  .mode-btn.unsafe.active {
    background: linear-gradient(180deg, rgba(239, 68, 68, 0.92), rgba(220, 38, 38, 0.84));
    border-color: #ef4444;
    color: #200706;
    opacity: 1;
  }

  .mode-state {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 5px 10px;
    border-radius: 999px;
    border: 1px solid #353949;
    background: #151924;
    color: #94a3b8;
  }

  .mode-state.safe {
    border-color: rgba(34, 197, 94, 0.42);
    color: #86efac;
    background: rgba(21, 128, 61, 0.15);
  }

  .mode-state.unsafe {
    border-color: rgba(239, 68, 68, 0.45);
    color: #fca5a5;
    background: rgba(127, 29, 29, 0.14);
  }

  .mode-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .checkout-success {
    position: sticky;
    bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 16px 18px;
    border-radius: 14px;
    border: 1px solid rgba(34, 197, 94, 0.35);
    background: linear-gradient(135deg, rgba(20, 83, 45, 0.96), rgba(22, 101, 52, 0.92));
    box-shadow: 0 22px 60px rgba(3, 12, 6, 0.42);
    color: #ecfdf5;
    z-index: 2;
  }

  .checkout-success-title {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.04em;
  }

  .checkout-success-body {
    font-size: 13px;
    color: rgba(236, 253, 245, 0.86);
  }

  @media (max-width: 900px) {
    .payment-actions {
      grid-template-columns: 1fr;
    }

    .hosted-checkout-banner {
      grid-template-columns: 1fr;
    }

    .hosted-checkout-summary {
      min-width: 0;
      text-align: left;
    }
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

  .description-lock-hint {
    margin-top: 4px;
    color: #a3a3a3;
    font-size: 11px;
    letter-spacing: 0.02em;
  }

  input[readonly] {
    border-color: #3f3f46;
    background: #161514;
    color: #d4d4d8;
  }
</style>
