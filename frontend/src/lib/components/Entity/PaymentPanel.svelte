<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { RefreshCw, ScanLine, X } from 'lucide-svelte';
  import jsQR from 'jsqr';
  import type {
    AccountMachine,
    RoutedEntityInput as EntityInputPayload,
    EntityReplica,
    Env,
    PaymentRoute,
    Profile as GossipProfile,
  } from '@xln/runtime/xln-api';
  import { getXLN, xlnEnvironment, replicas, xlnFunctions, enqueueEntityInputs } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import { routePreview } from '../../stores/routePreviewStore';
  import { isCounterpartyBlockedByDispute, requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import { toasts } from '$lib/stores/toastStore';
  import { keccak256, AbiCoder, hexlify } from 'ethers';
  import EntityInput from '../shared/EntityInput.svelte';
  import TokenSelect from '../shared/TokenSelect.svelte';
  import EntityIdentity from '../shared/EntityIdentity.svelte';
  import { amountToUsd } from '$lib/utils/assetPricing';
  import { buildXlnInvoiceUri, parseXlnInvoice, type ParsedXlnInvoice } from '$lib/utils/xlnInvoice';
  import {
    extractEntityEncPubKey,
    findProfileByEntityId,
    getDirectionalEdgeCapacity,
    normalizeEntityId,
    quoteHop,
    sanitizeBigInt,
  } from './payment-routing';

  export let entityId: string;

  // Form state
  let targetEntityId = '';
  let amount = '';
  let tokenId = 1;
  let description = '';
  let descriptionLocked = false;
  let invoiceValue = '';
  let invoiceError = '';
  let invoiceLocked = false;
  let pendingAutoRouteKey = '';
  let completedAutoRouteKey = '';
  let autoRouteRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let autoRouteRetryDeadlineMs = 0;
  let scannerOpen = false;
  let scannerStatus = '';
  let scannerError = '';
  let scannerVideoEl: HTMLVideoElement | null = null;
  let scannerFileInputEl: HTMLInputElement | null = null;
  let scannerStream: MediaStream | null = null;
  let scannerFrame = 0;
  let useHtlc = true;
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
  let repeatArmed = false;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  let repeatStoppedReason = '';
  let payMaxAmount = 0n;
  let payMaxUsd = 0;
  let serverEntityNames = new Map<string, string>();
  let refreshingRecipientOptions = false;
  let seededDefaultTarget = false;
  let canPayNow = false;
  const REPEAT_OPTIONS = [
    { value: 0, label: 'No repeat' },
    { value: 1_000, label: 'Repeat 1s' },
    { value: 10_000, label: 'Repeat 10s' },
    { value: 60_000, label: 'Repeat 1m' },
  ];
  // If a hop does not publish fee metadata, use a conservative default so
  // unknown peers cannot appear artificially cheaper than known hubs.
  const DEFAULT_UNKNOWN_HOP_FEE_PPM = 1;
  const MAX_ROUTES = 100;
  const MAX_CANDIDATE_PATHS = 500;
  const MAX_PATH_HOPS = 6;
  const MIN_SELF_CYCLE_INTERMEDIATES = 2;
  const GOSSIP_REFRESH_ATTEMPTS = 3;
  const GOSSIP_REFRESH_WAIT_MS = 100;
  const AUTO_ROUTE_RETRY_WINDOW_MS = 8_000;
  const AUTO_ROUTE_RETRY_DELAY_MS = 200;
  const EMBEDDED_CONFIRMATION_POLL_MS = 150;
  type LockBookEntry = {
    accountId: string;
    tokenId: number;
    direction: 'incoming' | 'outgoing';
  };

  type SendPaymentResult = {
    queued: boolean;
    hashlock: string | null;
  };
  type BarcodeDetectorLike = {
    detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>>;
  };
  type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

  $: currentReplicas = $replicas;
  $: currentEnv = $xlnEnvironment;
  $: activeXlnFunctions = $xlnFunctions;
  $: activeIsLive = $globalIsLive;
  $: isSelfRecipient = Boolean(targetEntityId) && normalizeEntityId(targetEntityId) === normalizeEntityId(entityId);

  const getGossipProfiles = (): GossipProfile[] => currentEnv?.gossip?.getProfiles?.() || [];

  function hasPendingOutgoingLock(from: string, to: string, token: number): boolean {
    if (!currentReplicas) return false;
    const fromNorm = normalizeEntityId(from);
    const toNorm = normalizeEntityId(to);
    for (const [key, replica] of currentReplicas.entries()) {
      const [replicaEntityId] = key.split(':');
      if (normalizeEntityId(replicaEntityId) !== fromNorm) continue;
      const lockBook = replica?.state?.lockBook;
      if (!(lockBook instanceof Map)) continue;
      for (const lock of lockBook.values()) {
        const entry = lock as LockBookEntry;
        if (entry.direction !== 'outgoing') continue;
        if (normalizeEntityId(entry.accountId) !== toNorm) continue;
        if (Number(entry.tokenId) !== token) continue;
        return true;
      }
    }
    return false;
  }

  const sanitizePrefillText = (raw: string | null | undefined, maxLen = 180): string => {
    const source = String(raw || '').trim();
    if (!source) return '';
    let value = '';
    let lastWasSpace = false;
    for (const char of source) {
      const isWhitespace = char === ' ' || char === '\n' || char === '\r' || char === '\t';
      if (isWhitespace) {
        if (!lastWasSpace) value += ' ';
        lastWasSpace = true;
        continue;
      }
      value += char;
      lastWasSpace = false;
      if (value.length >= maxLen) break;
    }
    return value.trim();
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

    if (modeParam === 'direct' || modeParam === 'unsafe' || modeParam === 'hashlock' || modeParam === 'htlc') {
      useHtlc = true;
    }
    if (hashRoute === 'pay') useHtlc = true;
    console.info('[PaymentPanel.prefill]', {
      hashRoute,
      useHtlc,
      targetEntityId: targetParam || targetEntityId,
      amount: amountParam || amount,
      tokenId,
    });
    if (!targetParam && entityId) targetEntityId = entityId;

    const explicitLock = parseBooleanParam(noteLockedParam);
    descriptionLocked = explicitLock || Boolean(recipientUserId);
    if (targetParam) {
      invoiceLocked = true;
      invoiceError = '';
      invoiceValue = buildXlnInvoiceUri({
        targetEntityId: targetParam,
        tokenId,
        amount: amountParam,
        description: noteParam,
        recipientUserId,
        jurisdictionId: sanitizePrefillText(getURLParamValue(['jId', 'jurisdiction', 'j']), 64),
        noteLocked: explicitLock || Boolean(recipientUserId),
      });
      requestAutoFindRoutes();
    }
  }

  function buildAutoRouteKey(): string {
    return [targetEntityId, amount, tokenId, description].join('|');
  }

  function requestAutoFindRoutes(): void {
    if (!targetEntityId || !amount) return;
    if (autoRouteRetryTimer) {
      clearTimeout(autoRouteRetryTimer);
      autoRouteRetryTimer = null;
    }
    pendingAutoRouteKey = buildAutoRouteKey();
    autoRouteRetryDeadlineMs = Date.now() + AUTO_ROUTE_RETRY_WINDOW_MS;
    completedAutoRouteKey = '';
  }

  function isTransientRoutePreflightError(message: string | null | undefined): boolean {
    const normalized = String(message || '').trim().toLowerCase();
    if (!normalized) return false;
    return normalized.includes('no route has enough real capacity')
      || normalized.includes('enough real capacity')
      || normalized.includes('no route found')
      || normalized.includes('no route available')
      || normalized.includes('target profile missing')
      || normalized.includes('refresh gossip')
      || normalized.includes('has no downloaded gossip profile')
      || normalized.includes('profile has no encryption key')
      || normalized.includes('missing encryption keys for route hops');
  }

  function clearInvoiceIntent(): void {
    invoiceLocked = false;
    invoiceError = '';
    invoiceValue = '';
    descriptionLocked = false;
  }

  function applyInvoiceIntent(parsed: ParsedXlnInvoice): void {
    invoiceValue = parsed.canonicalUri;
    invoiceError = '';
    invoiceLocked = Boolean(parsed.amount);
    targetEntityId = parsed.targetEntityId;
    if (parsed.amount) amount = parsed.amount;
    if (parsed.tokenId) tokenId = parsed.tokenId;
    const noteParts: string[] = [];
    if (parsed.description) noteParts.push(parsed.description);
    if (parsed.recipientUserId) noteParts.push(`uid:${parsed.recipientUserId}`);
    description = noteParts.join(' | ');
    descriptionLocked = parsed.noteLocked || Boolean(parsed.description) || Boolean(parsed.recipientUserId);
    resetQuotedRoutes();
    requestAutoFindRoutes();
  }

  function handleInvoiceInput(): void {
    const trimmed = invoiceValue.trim();
    if (!trimmed) {
      clearInvoiceIntent();
      return;
    }
    const normalized = trimmed.toLowerCase();
    if (!normalized.startsWith('xln:') && !normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      invoiceError = '';
      return;
    }
    try {
      const parsed = parseXlnInvoice(trimmed);
      applyInvoiceIntent(parsed);
    } catch (error) {
      invoiceLocked = false;
      invoiceError = error instanceof Error ? error.message : String(error);
    }
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
      add(profile.entityId);
    }
    return Array.from(ids.values()).sort();
  })();

  $: if (!seededDefaultTarget && entityId) {
    if (!targetEntityId) targetEntityId = entityId;
    seededDefaultTarget = true;
  }

  const clearRepeatTimer = () => {
    if (repeatTimer) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  };

  function stopRepeatTimer(reason: string): void {
    clearRepeatTimer();
    repeatArmed = false;
    repeatStoppedReason = reason;
  }

  const restartRepeatTimer = () => {
    clearRepeatTimer();
    if (!repeatArmed || repeatIntervalMs <= 0 || selectedRouteIndex < 0 || !routes[selectedRouteIndex]) return;
    repeatStoppedReason = '';
    repeatTimer = setInterval(() => {
      if (sendingPayment || findingRoutes) return;
      if (hasPendingOutgoingLock(entityId, targetEntityId, tokenId)) {
        stopRepeatTimer('Previous HTLC is still settling on this account.');
        return;
      }
      void sendPayment(false);
    }, repeatIntervalMs);
  };

  $: if (repeatIntervalMs === 0) {
    clearRepeatTimer();
    repeatArmed = false;
  }

  onDestroy(() => {
    clearRepeatTimer();
    if (autoRouteRetryTimer) {
      clearTimeout(autoRouteRetryTimer);
      autoRouteRetryTimer = null;
    }
  });

  function resetQuotedRoutes(): void {
    routes = [];
    selectedRouteIndex = -1;
    clearRepeatTimer();
    repeatArmed = false;
    repeatStoppedReason = '';
  }

  function getEntityName(id: string): string {
    if (!id) return 'Unknown';
    const norm = normalizeEntityId(id);
    if (norm === normalizeEntityId(entityId)) return 'Self';
    const serverName = serverEntityNames.get(norm);
    if (serverName) return serverName;
    const profile = getGossipProfiles().find((p) => normalizeEntityId(p.entityId) === norm);
    const name = profile?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : id;
  }

  function buildEmbeddedRouteLabel(route: RouteOption): string {
    const viaNames = route.path
      .slice(1, -1)
      .map((hopId) => getEntityName(hopId))
      .map((name) => String(name || '').trim())
      .filter(Boolean);
    return viaNames.length > 0 ? `Pay via ${viaNames.join('-')}` : 'Pay now';
  }

  function getGossipProfileByEntityId(id: string): GossipProfile | undefined {
    return findProfileByEntityId(getGossipProfiles(), id) ?? undefined;
  }

  function getTokenSymbol(tokenIdValue: number): string {
    return String(activeXlnFunctions?.getTokenInfo?.(tokenIdValue)?.symbol || 'token').trim() || 'token';
  }

  function formatUsdHint(valueUsd: number): string {
    if (!Number.isFinite(valueUsd) || valueUsd <= 0) return '$0.00';
    if (valueUsd >= 1000) {
      return '~$' + valueUsd.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
    return '~$' + valueUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function computeLocalPayMax(tokenIdValue: number): bigint {
    if (!currentReplicas || !activeXlnFunctions?.deriveDelta) return 0n;
    const selfNorm = normalizeEntityId(entityId);
    let maxOut = 0n;
    for (const [replicaKey, replica] of currentReplicas.entries()) {
      const [replicaEntityId] = replicaKey.split(':');
      if (normalizeEntityId(replicaEntityId) !== selfNorm) continue;
      for (const account of replica.state.accounts.values()) {
        for (const [deltaTokenId, delta] of account.deltas.entries()) {
          if (Number(deltaTokenId) !== tokenIdValue) continue;
          const isLeft = normalizeEntityId(account.leftEntity) === selfNorm;
          const derived = activeXlnFunctions.deriveDelta(delta, isLeft);
          if (derived.outCapacity > maxOut) maxOut = derived.outCapacity;
        }
      }
    }
    return maxOut;
  }

  function fillMaxPaymentAmount(): void {
    const maxAmount = computeLocalPayMax(tokenId);
    if (maxAmount <= 0n) return;
    amount = formatTokenInputValue(tokenId, maxAmount);
  }

  $: payMaxAmount = computeLocalPayMax(tokenId);
  $: payMaxUsd = amountToUsd(payMaxAmount, getTokenDecimals(tokenId), getTokenSymbol(tokenId));

  function isRouteableIntermediary(entity: string): boolean {
    // Routeability is a transport/security property, not a display-metadata property.
    // A hop is routeable iff we can encrypt for it and it is hub-like when profile exists.
    if (currentEnv && entityId && isCounterpartyBlockedByDispute(currentEnv, entityId, entity)) return false;
    if (!extractEntityEncPubKey(currentReplicas, getGossipProfiles(), entity)) return false;
    const profile = getGossipProfileByEntityId(entity);
    if (!profile) return true; // allow local+gossip mixed discovery; key coverage is enforced above
    return profile.metadata.isHub === true;
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
    const rawLower = raw.toLowerCase();
    const symbolLower = symbol.toLowerCase();
    if (rawLower.endsWith(symbolLower)) {
      return raw.slice(0, raw.length - symbol.length).trimEnd();
    }
    return raw.trim();
  }

  function formatTokenInputValue(tokenIdValue: number, value: bigint): string {
    const decimals = getTokenDecimals(tokenIdValue);
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const frac = abs % base;
    let body = whole.toString();
    if (frac > 0n) {
      const fracText = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
      if (fracText.length > 0) body = `${body}.${fracText}`;
    }
    return `${negative ? '-' : ''}${body}`;
  }

  function formatCompactRouteFee(tokenIdValue: number, value: bigint): string {
    const decimals = getTokenDecimals(tokenIdValue);
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const frac = abs % base;
    let body = whole.toString();
    if (frac > 0n) {
      const fracRaw = frac.toString().padStart(decimals, '0');
      const fracTrimmed = fracRaw.slice(0, 8).replace(/0+$/, '');
      if (fracTrimmed.length > 0) body = `${body}.${fracTrimmed}`;
    }
    return `${negative ? '-' : ''}${body}`;
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
    if (!normalized) {
      throw new Error('Amount must be a positive decimal number');
    }
    let dotCount = 0;
    for (let index = 0; index < normalized.length; index += 1) {
      const char = normalized[index]!;
      const isDigit = char >= '0' && char <= '9';
      if (isDigit) continue;
      if (char === '.') {
        dotCount += 1;
        continue;
      }
      throw new Error('Amount must be a positive decimal number');
    }
    if (dotCount > 1 || normalized === '.' || normalized.startsWith('.') || normalized.endsWith('.')) {
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

  function hasOutboundCapacity(from: string, to: string, token: number): boolean {
    if (!activeXlnFunctions?.deriveDelta) return false;
    return getDirectionalEdgeCapacity(
      currentReplicas,
      getGossipProfiles(),
      activeXlnFunctions.deriveDelta,
      from,
      to,
      token,
    ) > 0n;
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
      const p2p = currentEnv?.runtimeState?.p2p;
      if (typeof p2p?.sendDebugEvent === 'function') p2p.sendDebugEvent(payload);
    } catch {
      // Best effort only; never block UI on debug forwarding.
    }
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function startInvoiceScanner(): Promise<void> {
    scannerError = '';
    scannerStatus = 'Starting camera…';
    scannerOpen = true;
    await tick();
    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
        },
        audio: false,
      });
      if (scannerVideoEl) {
        scannerVideoEl.srcObject = scannerStream;
        await scannerVideoEl.play();
      }
      scannerStatus = 'Point camera at an XLN invoice QR';
      loopInvoiceScanner();
    } catch (error) {
      scannerError = error instanceof Error ? error.message : String(error);
      scannerStatus = '';
    }
  }

  function stopInvoiceScanner(): void {
    scannerOpen = false;
    scannerStatus = '';
    scannerError = '';
    if (scannerFrame) {
      cancelAnimationFrame(scannerFrame);
      scannerFrame = 0;
    }
    if (scannerVideoEl) {
      scannerVideoEl.pause();
      scannerVideoEl.srcObject = null;
    }
    if (scannerStream) {
      for (const track of scannerStream.getTracks()) track.stop();
      scannerStream = null;
    }
  }

  const getBarcodeDetectorCtor = (): BarcodeDetectorCtor | null => {
    if (typeof window === 'undefined') return null;
    return ((window as typeof window & { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector || null);
  };

  async function tryDetectQrFromVideo(video: HTMLVideoElement): Promise<string | null> {
    const BarcodeDetectorCtor = getBarcodeDetectorCtor();
    if (BarcodeDetectorCtor) {
      try {
        const detector = new BarcodeDetectorCtor({ formats: ['qr_code'] });
        const results = await detector.detect(video);
        const rawValue = String(results[0]?.rawValue || '').trim();
        if (rawValue) return rawValue;
      } catch {
        // fall through to jsQR
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    return result?.data?.trim() || null;
  }

  function loopInvoiceScanner(): void {
    if (!scannerOpen || !scannerVideoEl) return;
    scannerFrame = requestAnimationFrame(async () => {
      if (!scannerOpen || !scannerVideoEl) return;
      if (scannerVideoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && scannerVideoEl.videoWidth > 0 && scannerVideoEl.videoHeight > 0) {
        const raw = await tryDetectQrFromVideo(scannerVideoEl);
        if (raw) {
          try {
            const parsed = parseXlnInvoice(raw);
            applyInvoiceIntent(parsed);
            stopInvoiceScanner();
            return;
          } catch (error) {
            scannerError = error instanceof Error ? error.message : String(error);
          }
        }
      }
      loopInvoiceScanner();
    });
  }

  async function handleScannerFileChange(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;
    scannerError = '';
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Failed to decode image');
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(imageData.data, imageData.width, imageData.height);
      if (!result?.data) throw new Error('No QR code found in image');
      const parsed = parseXlnInvoice(result.data);
      applyInvoiceIntent(parsed);
      stopInvoiceScanner();
    } catch (error) {
      scannerError = error instanceof Error ? error.message : String(error);
    } finally {
      if (input) input.value = '';
    }
  }

  function getRecipientProfileIssue(): { code: string; message: string; details?: Record<string, unknown> } | null {
    if (!targetEntityId || normalizeEntityId(targetEntityId) === normalizeEntityId(entityId)) return null;
    const profiles = getGossipProfiles();
    const targetNorm = normalizeEntityId(targetEntityId);
    const targetProfile = profiles.find((p) => normalizeEntityId(p.entityId) === targetNorm);
    if (!targetProfile) {
      const msg = `Recipient ${targetEntityId} has no downloaded gossip profile`;
      return { code: 'PAYMENT_PREFLIGHT_PROFILE_MISSING', message: msg };
    }
    if (!extractEntityEncPubKey(currentReplicas, profiles, targetEntityId)) {
      const msg = `Recipient ${targetEntityId} profile has no encryption key`;
      return { code: 'PAYMENT_PREFLIGHT_KEY_MISSING', message: msg, details: { targetProfile } };
    }
    return null;
  }

  function getRouteMissDiagnostics(): {
    profilesCount: number;
    hubsCount: number;
    targetProfilePresent: boolean;
    targetProfileLastUpdated: number | null;
    targetPublicAccounts: number;
  } {
    const profiles = getGossipProfiles();
    const targetNorm = normalizeEntityId(targetEntityId);
    const targetProfile = profiles.find((profile) => normalizeEntityId(profile.entityId) === targetNorm) || null;
    const hubsCount = profiles.filter((profile) =>
      profile.metadata.isHub === true
    ).length;
    return {
      profilesCount: profiles.length,
      hubsCount,
      targetProfilePresent: !!targetProfile,
      targetProfileLastUpdated: targetProfile ? targetProfile.lastUpdated : null,
      targetPublicAccounts: targetProfile ? targetProfile.publicAccounts.length : 0,
    };
  }

  function buildRouteMissMessage(): string {
    const diagnostics = getRouteMissDiagnostics();
    if (!diagnostics.targetProfilePresent) {
      return `No route found to ${targetEntityId} out of ${diagnostics.profilesCount} gossip profiles (target profile missing)`;
    }
    return (
      `No route found to ${targetEntityId} out of ${diagnostics.profilesCount} gossip profiles ` +
      `(hubs=${diagnostics.hubsCount}, target lastUpdated=${diagnostics.targetProfileLastUpdated}, publicAccounts=${diagnostics.targetPublicAccounts})`
    );
  }

  function getEntitiesFromPaths(paths: string[][]): string[] {
    const seen = new Set<string>();
    const entities: string[] = [];
    for (const path of paths) {
      for (const rawEntityId of path) {
        const norm = normalizeEntityId(rawEntityId);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        entities.push(rawEntityId);
      }
    }
    return entities;
  }

  function getMissingRouteKeys(path: string[]): string[] {
    const missingSet = new Set<string>();
    for (const hopEntity of path.slice(1)) {
      if (!extractEntityEncPubKey(currentReplicas, getGossipProfiles(), hopEntity)) {
        missingSet.add(hopEntity);
      }
    }
    return Array.from(missingSet);
  }

  async function refreshGossipOnDemand(reason: string, targetEntities: string[]): Promise<void> {
    const env = currentEnv;
    if (!env) return;
    const xln = await getXLN();
    const seedProfilesFromServer = async (entityIds: string[]): Promise<boolean> => {
      if (typeof fetch === 'undefined' || !env.gossip?.announce) return false;
      let seeded = false;
      for (const entityId of entityIds) {
        const target = normalizeEntityId(entityId);
        if (!target) continue;
        try {
          const response = await fetch(`/api/gossip/profile?entityId=${encodeURIComponent(target)}`);
          if (!response.ok) continue;
          const payload = await response.json().catch(() => null) as {
            profile?: GossipProfile | null;
            peers?: GossipProfile[];
          } | null;
          const profiles: GossipProfile[] = [];
          if (payload?.profile) profiles.push(payload.profile);
          if (Array.isArray(payload?.peers)) profiles.push(...payload.peers);
          for (const profile of profiles) {
            if (!profile?.entityId) continue;
            env.gossip.announce(profile);
            seeded = true;
          }
        } catch {
          // best effort only
        }
      }
      return seeded;
    };

    if (targetEntities.length > 0) {
      await seedProfilesFromServer(targetEntities);
    }
    try {
      await env.runtimeState?.p2p?.syncProfiles?.();
    } catch {
      // fall through to targeted fetch / refresh loop
    }
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
      await sleep(GOSSIP_REFRESH_WAIT_MS);
      if (targetEntities.length > 0) {
        await seedProfilesFromServer(targetEntities);
      }
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

  async function findRoutes(preserveRepeatTimer = false, silent = false): Promise<boolean> {
    if (!targetEntityId || !amount) return;

    const viewportY = typeof window === 'undefined' ? 0 : window.scrollY;
    findingRoutes = true;
    routes = [];
    selectedRouteIndex = -1;
    preflightError = null;
    if (!preserveRepeatTimer) {
      clearRepeatTimer();
    }

    try {
      const xln = await getXLN();
      const env = currentEnv;
      if (!env) throw new Error('Environment not ready');
      try {
        await env.runtimeState?.p2p?.syncProfiles?.();
      } catch {
        // best effort only
      }
      if (typeof xln.ensureGossipProfiles === 'function') {
        try {
          await xln.ensureGossipProfiles(env, [entityId, targetEntityId]);
        } catch {
          // best effort only
        }
      }
      await ensureRecipientProfileReady();

      const amountInSmallestUnit = parseAmountToWei(amount, getTokenDecimals(tokenId));
      if (amountInSmallestUnit <= 0n) {
        throw new Error('Amount must be greater than zero');
      }

      if (!currentReplicas) throw new Error('Replicas not available');
      const sourceNorm = normalizeEntityId(entityId);
      const targetNorm = normalizeEntityId(targetEntityId);
      const isSelfTarget = sourceNorm === targetNorm;
      const collectCandidatePaths = async (): Promise<{ network: ReturnType<typeof buildNetworkAdjacency>; foundPaths: string[][] }> => {
        const network = buildNetworkAdjacency(env, currentReplicas);
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

        const runtimeGraph = env.gossip?.getNetworkGraph?.();
        try {
          const runtimeRoutes: PaymentRoute[] =
            await runtimeGraph?.findPaths?.(entityId, targetEntityId, amountInSmallestUnit, tokenId) || [];
          for (const route of runtimeRoutes) {
            pushPath(route.path);
          }
        } catch {}

        const localPaths = findPathsFromGraph(network.adjacency, sourceNorm, targetNorm, tokenId);
        for (const path of localPaths) pushPath(path);
        return { network, foundPaths };
      };

      let { network, foundPaths } = await collectCandidatePaths();

      if (foundPaths.length === 0) {
        if (!isSelfTarget) {
          await refreshGossipOnDemand('route-miss', [targetEntityId]);
          ({ network, foundPaths } = await collectCandidatePaths());
        }
        if (foundPaths.length === 0) {
          if (isSelfTarget) {
            throw new Error('No self-route found with at least 2 different intermediates');
          }
          const routeMissMessage = buildRouteMissMessage();
          emitUiDebugEvent('PAYMENT_ROUTE_MISS', routeMissMessage, getRouteMissDiagnostics());
          throw new Error(routeMissMessage);
        }
      }

      const quoteCandidateRoutes = (paths: string[][]): RouteOption[] => {
        const quotedRoutes: RouteOption[] = [];
        for (const normalizedPath of paths) {
          const path = normalizedPath.map((id) => network.canonicalIds.get(id) || id);
          const intermediaries = path.slice(1, -1);
          let downstreamAmount = amountInSmallestUnit;
          const intermediaryFeeByEntity = new Map<string, { fee: bigint; feePPM: number }>();
          let hasCapacity = true;
          for (let i = intermediaries.length - 1; i >= 0; i -= 1) {
            const intermediary = intermediaries[i]!;
            const nextHop = path[i + 2]!;
            if (!activeXlnFunctions?.deriveDelta) {
              throw new Error('Runtime deriveDelta is unavailable');
            }
            const quote = quoteHop(
              currentReplicas,
              getGossipProfiles(),
              activeXlnFunctions.deriveDelta,
              intermediary,
              nextHop,
              tokenId,
              downstreamAmount,
              DEFAULT_UNKNOWN_HOP_FEE_PPM,
            );
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
            if (!activeXlnFunctions?.deriveDelta) {
              throw new Error('Runtime deriveDelta is unavailable');
            }
            const senderQuote = quoteHop(
              currentReplicas,
              getGossipProfiles(),
              activeXlnFunctions.deriveDelta,
              path[0]!,
              path[1]!,
              tokenId,
              downstreamAmount,
              DEFAULT_UNKNOWN_HOP_FEE_PPM,
            );
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
        return quotedRoutes;
      };

      let quotedRoutes = quoteCandidateRoutes(foundPaths);
      if (quotedRoutes.length === 0 && foundPaths.length > 0) {
        await refreshGossipOnDemand('route-capacity', getEntitiesFromPaths(foundPaths));
        ({ network, foundPaths } = await collectCandidatePaths());
        quotedRoutes = quoteCandidateRoutes(foundPaths);
      }

      routes = sortRoutesList(quotedRoutes).slice(0, MAX_ROUTES);

      if (routes.length === 0) {
        throw new Error('No route has enough real capacity for this amount');
      }

      for (const route of routes) {
        await ensureRouteKeyCoverage(route.path);
      }

      if (routes.length > 0) selectedRouteIndex = 0;
      await tick();
      if (typeof window !== 'undefined' && window.scrollY !== viewportY) {
        window.scrollTo(window.scrollX, viewportY);
      }
      return routes.length > 0;
    } catch (error) {
      console.error('[Send] Route finding failed:', error);
      preflightError = (error as Error)?.message || 'Unknown route preflight error';
      if (!silent) {
        toasts.error(`Route finding failed: ${preflightError}`);
      }
      return false;
    } finally {
      findingRoutes = false;
    }
  }

  $: if (
    pendingAutoRouteKey &&
    pendingAutoRouteKey !== completedAutoRouteKey &&
    targetEntityId &&
    amount &&
    currentEnv &&
    activeIsLive &&
    !findingRoutes &&
    !sendingPayment
  ) {
    const routeKey = pendingAutoRouteKey;
    completedAutoRouteKey = routeKey;
    void findRoutes(false, true).then((success) => {
      if (success) return;
      if (pendingAutoRouteKey !== routeKey || completedAutoRouteKey !== routeKey) return;
      if (!isTransientRoutePreflightError(preflightError) || Date.now() >= autoRouteRetryDeadlineMs) {
        return;
      }
      if (autoRouteRetryTimer) clearTimeout(autoRouteRetryTimer);
      autoRouteRetryTimer = setTimeout(() => {
        if (completedAutoRouteKey === routeKey) {
          completedAutoRouteKey = '';
        }
        autoRouteRetryTimer = null;
      }, AUTO_ROUTE_RETRY_DELAY_MS);
    });
  }

  async function waitForEmbeddedHtlcConfirmation(hashlock: string, timeoutMs = 45_000): Promise<void> {
    const startedAfterId = (() => {
      const lastLog = Array.isArray(currentEnv?.frameLogs) && currentEnv.frameLogs.length > 0
        ? currentEnv.frameLogs[currentEnv.frameLogs.length - 1]
        : null;
      return Number((lastLog as { id?: number } | null)?.id ?? -1);
    })();
    const entityNorm = normalizeEntityId(entityId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const logs = Array.isArray(currentEnv?.frameLogs) ? currentEnv.frameLogs : [];
      for (const rawEntry of logs as Array<{ id?: number; message?: string; data?: Record<string, unknown> }>) {
        const entryId = Number(rawEntry?.id ?? -1);
        if (entryId <= startedAfterId) continue;
        const message = String(rawEntry?.message || '').trim();
        const data = rawEntry?.data || {};
        if (String(data.hashlock || '').trim() !== hashlock) continue;
        const eventEntityNorm = normalizeEntityId(String(data.entityId || ''));
        if (eventEntityNorm && eventEntityNorm !== entityNorm) continue;
        if (message === 'HtlcFailed') {
          throw new Error(String(data.reason || 'Payment failed'));
        }
        if (message === 'HtlcFinalized') {
          return;
        }
      }
      await sleep(EMBEDDED_CONFIRMATION_POLL_MS);
    }
    throw new Error('Payment confirmation timed out');
  }

  export async function embeddedPrepareFirstRoute(): Promise<string> {
    if (sendingPayment || findingRoutes) {
      throw new Error('Payment already in progress');
    }
    if (isSelfRecipient) {
      throw new Error('Self-payment requires explicit route selection');
    }
    preflightError = null;
    await findRoutes(false);
    if (routes.length === 0) {
      throw new Error(preflightError || 'No route found');
    }
    selectedRouteIndex = 0;
    return buildEmbeddedRouteLabel(routes[0]!);
  }

  function hasSelectedRoute(): boolean {
    return selectedRouteIndex >= 0 && !!routes[selectedRouteIndex];
  }

  async function payNowCheapest() {
    if (sendingPayment || findingRoutes) return;
    if (isSelfRecipient) return;
    await findRoutes(false);
    if (routes.length === 0) return;
    selectedRouteIndex = 0; // routes are sorted by cheapest fee by default
    await sendPayment(true);
  }

  async function payUsingCurrentIntent(): Promise<void> {
    if (sendingPayment || findingRoutes) return;
    if (hasSelectedRoute()) {
      await sendPayment(true);
      return;
    }
    await payNowCheapest();
  }

  export async function embeddedPayUsingFirstRoute(): Promise<void> {
    console.info('[PaymentPanel.embeddedPayUsingFirstRoute] start');
    if (sendingPayment || findingRoutes) {
      throw new Error('Payment already in progress');
    }
    if (isSelfRecipient) {
      throw new Error('Self-payment requires explicit route selection');
    }
    if (routes.length === 0 || !routes[selectedRouteIndex]) {
      await embeddedPrepareFirstRoute();
    }
    if (routes.length === 0) {
      throw new Error(preflightError || 'No route available');
    }
    if (selectedRouteIndex < 0 || !routes[selectedRouteIndex]) {
      selectedRouteIndex = 0;
    }
    const result = await sendPayment(true);
    if (!result.queued) {
      throw new Error(preflightError || 'Payment failed');
    }
    if (!result.hashlock) {
      throw new Error('Missing HTLC hashlock');
    }
    await waitForEmbeddedHtlcConfirmation(result.hashlock);
    console.info('[PaymentPanel.embeddedPayUsingFirstRoute] done');
  }

  async function sendPayment(manual = true): Promise<SendPaymentResult> {
    if (selectedRouteIndex < 0 || !routes[selectedRouteIndex]) return { queued: false, hashlock: null };
    if (sendingPayment) return { queued: false, hashlock: null };

    sendingPayment = true;
    let queued = false;
    try {
      const xln = await getXLN();
      const env = currentEnv;
      if (!env) throw new Error('Environment not ready');
      if (!activeIsLive) throw new Error('Payments are only available in LIVE mode');
      preflightError = null;
      await ensureRecipientProfileReady();

      // Timer-driven sends must refresh route quotes to avoid reusing stale capacities.
      if (!manual) {
        await findRoutes(true);
      }

      const route = routes[selectedRouteIndex];
      if (!route) throw new Error('Selected route is no longer available');
      console.info('[PaymentPanel.sendPayment]', {
        manual,
        useHtlc,
        selectedRouteIndex,
        route: route.path,
        senderAmount: route.senderAmount.toString(),
        recipientAmount: route.recipientAmount.toString(),
      });
      await ensureRouteKeyCoverage(route.path);
      const routeTargetEntityId = route.path[route.path.length - 1] || targetEntityId;

      const signerId = activeXlnFunctions?.resolveEntityProposerId?.(env, entityId, 'payment-panel')
        || requireSignerIdForEntity(env, entityId, 'payment-panel');

      const descriptionValue = description.trim();
      let paymentInput: EntityInputPayload;
      let queuedHashlock: string | null = null;
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
      queued = true;
      console.info('[PaymentPanel.sendPayment.queued]', {
        manual,
        useHtlc,
        hashlock: queuedHashlock,
      });
      console.log('[Send] Hashlock payment sent via:', route.path.join(' -> '));
      return { queued: true, hashlock: queuedHashlock };
    } catch (error) {
      console.error('[Send] Payment failed:', error);
      preflightError = (error as Error)?.message || 'Unknown send error';
      if (!manual) {
        stopRepeatTimer(preflightError);
      }
      toasts.error(`Payment failed: ${preflightError}`);
      return { queued: false, hashlock: null };
    } finally {
      sendingPayment = false;
      if (manual && queued && repeatIntervalMs > 0) {
        repeatArmed = true;
        restartRepeatTimer();
      }
    }
  }

  function handleTargetChange(e: CustomEvent) {
    targetEntityId = e.detail.value;
    preflightError = null;
    resetQuotedRoutes();
  }

  function handleRecipientPickerOpen() {
    void refreshGossipOnDemand(
      'recipient-picker-open',
      targetEntityId ? [targetEntityId] : [],
    );
    void refreshServerEntityNames();
  }

  async function refreshRecipientPickerOptions(): Promise<void> {
    if (refreshingRecipientOptions) return;
    refreshingRecipientOptions = true;
    preflightError = null;
    try {
      await refreshGossipOnDemand(
        'recipient-picker-manual-refresh',
        targetEntityId ? [targetEntityId] : [],
      );
      await refreshServerEntityNames();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      preflightError = message;
      toasts.error(`Recipient refresh failed: ${message}`);
    } finally {
      refreshingRecipientOptions = false;
    }
  }

  function handleTokenChange(e: CustomEvent) {
    tokenId = e.detail.value;
    preflightError = null;
    resetQuotedRoutes();
  }

  function handleAmountInput() {
    preflightError = null;
    resetQuotedRoutes();
  }

  function handleRepeatChange(event: Event) {
    const target = event.target as HTMLSelectElement | null;
    repeatIntervalMs = target ? Number(target.value) : 0;
    clearRepeatTimer();
    if (repeatIntervalMs <= 0) {
      repeatArmed = false;
      repeatStoppedReason = '';
      return;
    }
    repeatStoppedReason = '';
  }

  $: canPayNow =
    !!targetEntityId &&
    !!amount &&
    activeIsLive &&
    !findingRoutes &&
    !sendingPayment &&
    (!isSelfRecipient || hasSelectedRoute());

  onMount(() => {
    applyPaymentPrefillFromURL();
    void refreshServerEntityNames();
    const handleLocationChange = () => {
      applyPaymentPrefillFromURL();
    };
    window.addEventListener('hashchange', handleLocationChange);
    window.addEventListener('popstate', handleLocationChange);
    return () => {
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('popstate', handleLocationChange);
      stopInvoiceScanner();
    };
  });
</script>

<div class="payment-panel">
  <div class="invoice-entry">
    <div class="invoice-label-row">
      <label for="payment-invoice-input">Invoice</label>
      <span class="invoice-helper">Paste invoice or enter details manually below</span>
    </div>
    <div class="invoice-entry-shell">
      <input
        id="payment-invoice-input"
        type="text"
        bind:value={invoiceValue}
        aria-label="Invoice"
        disabled={findingRoutes || sendingPayment}
        on:input={handleInvoiceInput}
      />
      <button
        type="button"
        class="invoice-tool-btn"
        on:click={startInvoiceScanner}
        disabled={findingRoutes || sendingPayment}
      >
        <ScanLine size={14} />
        <span>Scan QR</span>
      </button>
      {#if invoiceLocked}
        <button
          type="button"
          class="invoice-tool-btn invoice-clear-btn"
          on:click={clearInvoiceIntent}
          disabled={findingRoutes || sendingPayment}
        >
          <X size={14} />
          <span>Clear</span>
        </button>
      {/if}
    </div>
    {#if invoiceError}
      <div class="profile-preflight-error">{invoiceError}</div>
    {/if}
  </div>

  <div class="recipient-picker-row">
    <div class="recipient-picker-input">
      <EntityInput
        label="Entity"
        value={targetEntityId}
        entities={allEntities}
        preferredId={entityId}
        disabled={invoiceLocked || findingRoutes || sendingPayment}
        on:change={handleTargetChange}
        on:open={handleRecipientPickerOpen}
      />
    </div>
    <button
      type="button"
      class="recipient-refresh-btn"
      on:click={() => void refreshRecipientPickerOptions()}
      disabled={findingRoutes || sendingPayment || refreshingRecipientOptions}
      title="Refresh available entities from gossip"
      aria-label="Refresh entities"
    >
      <RefreshCw size={14} />
      <span>{refreshingRecipientOptions ? 'Refreshing' : 'Refresh'}</span>
    </button>
  </div>

  {#if preflightError}
    <div class="profile-preflight-error">{preflightError}</div>
  {/if}

  <div class="amount-token-row">
    <div class="amount-field">
      <label for="payment-amount-input">
        <span>Amount</span>
      </label>
      <div class="amount-input-shell">
        <input
          id="payment-amount-input"
          type="text"
          bind:value={amount}
          data-testid="payment-amount-input"
          aria-label="Payment amount"
          disabled={invoiceLocked || findingRoutes || sendingPayment}
          on:input={handleAmountInput}
        />
        <div class="amount-inline-tools">
          <button
            type="button"
            class="inline-max-link amount-max-link"
            on:click={fillMaxPaymentAmount}
            disabled={payMaxAmount <= 0n || findingRoutes || sendingPayment}
          >
            {formatTokenInputValue(tokenId, payMaxAmount)} {getTokenSymbol(tokenId)} ({formatUsdHint(payMaxUsd)})
          </button>
          <div class="inline-token-select">
            <TokenSelect
              value={tokenId}
              compact={true}
              disabled={invoiceLocked || findingRoutes || sendingPayment}
              on:change={handleTokenChange}
            />
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="field">
    <label>Description {descriptionLocked ? '(locked)' : '(optional)'}</label>
    <input
      id="payment-description-input"
      type="text"
      bind:value={description}
      aria-label="Payment description"
      readonly={descriptionLocked || invoiceLocked}
      aria-readonly={descriptionLocked || invoiceLocked}
      disabled={findingRoutes || sendingPayment}
    />
    {#if descriptionLocked}
      <small class="description-lock-hint">Recipient user id is locked into this payment note.</small>
    {/if}
  </div>

  {#if isSelfRecipient}
    <div class="payment-note">
      Self-payment needs an explicit route. Use <strong>Find Routes</strong> first instead of auto-pay.
    </div>
  {/if}

  {#if routes.length > 0}
    <div class="routes">
      <div class="routes-header">
        <h4>Routes ({routes.length})</h4>
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
            <span class="route-marker" aria-hidden="true"></span>
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
                      showAddress={false}
                      size={20}
                    />
                  </div>
                  {#if hopIndex < route.path.length - 1}
                    <span class="hop-arrow">→</span>
                  {/if}
                {/each}
              </div>
              <span class="route-meta">
                Fee {formatCompactRouteFee(tokenId, route.totalFee)} {getTokenSymbol(tokenId)}
              </span>
            </div>
          </label>
        {/each}
      </div>
    </div>
  {/if}

  <div class="payment-actions">
    <div class="send-controls">
      <button
        class="btn-pay-now"
        on:click={() => void payUsingCurrentIntent()}
        disabled={!canPayNow}
      >
        {sendingPayment ? 'Sending...' : (findingRoutes ? 'Finding Routes...' : 'Pay Now')}
      </button>
      <button
        class="btn-find"
        on:click={() => void findRoutes(false)}
        disabled={!targetEntityId || !amount || findingRoutes || sendingPayment}
      >
        {findingRoutes ? 'Finding Routes...' : 'Find Routes'}
      </button>
    </div>
    <!-- Repeat controls intentionally hidden for now. Keep timer wiring for later re-enable. -->
  </div>

  <!-- Repeat status intentionally hidden with repeat controls. -->

</div>

{#if scannerOpen}
  <div class="scanner-modal" role="dialog" aria-modal="true" aria-label="Scan invoice QR">
    <div class="scanner-card">
      <div class="scanner-card-header">
        <h4>Scan Invoice QR</h4>
        <button type="button" class="invoice-tool-btn invoice-clear-btn" on:click={stopInvoiceScanner}>
          <X size={14} />
          <span>Close</span>
        </button>
      </div>
      <video bind:this={scannerVideoEl} class="scanner-video" playsinline muted></video>
      {#if scannerStatus}
        <div class="scanner-status">{scannerStatus}</div>
      {/if}
      {#if scannerError}
        <div class="profile-preflight-error">{scannerError}</div>
      {/if}
      <div class="scanner-actions">
        <input
          bind:this={scannerFileInputEl}
          type="file"
          accept="image/*"
          class="scanner-file-input"
          on:change={handleScannerFileChange}
        />
        <button type="button" class="invoice-tool-btn" on:click={() => scannerFileInputEl?.click()}>
          <span>Upload QR Image</span>
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .payment-panel {
    --pay-field-h: 48px;
    --pay-field-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    width: 100%;
    max-width: 1120px;
  }

  .invoice-entry {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 14px;
  }

  .invoice-label-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
  }

  .invoice-helper {
    color: #8d857d;
    font-size: 12px;
  }

  .invoice-entry-shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 10px;
    align-items: center;
  }

  .invoice-entry-shell input {
    min-height: var(--pay-field-h);
    border-radius: var(--pay-field-radius);
  }

  .invoice-tool-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: var(--pay-field-h);
    padding: 0 14px;
    border-radius: var(--pay-field-radius);
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: #f5efe6;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .invoice-clear-btn {
    color: #e7b6a5;
  }

  .recipient-picker-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: end;
  }

  .recipient-picker-input {
    min-width: 0;
  }

  .recipient-refresh-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: var(--pay-field-h);
    min-width: 116px;
    padding: 0 14px;
    border-radius: var(--pay-field-radius);
    border: none;
    background: rgba(255, 255, 255, 0.04);
    color: #cfc7bd;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .recipient-refresh-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.07);
    color: #f5efe6;
  }

  .recipient-refresh-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .amount-token-row {
    display: block;
  }

  .amount-field label,
  .field label {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .amount-inline-tools {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    min-width: 0;
  }

  .inline-token-select {
    width: 132px;
    flex-shrink: 0;
  }

  .inline-token-select :global(.token-select) {
    width: 100%;
  }

  .inline-token-select :global(.select-trigger) {
    min-height: calc(var(--pay-field-h) - 8px);
    padding: 7px 9px;
  }

  .amount-input-shell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--pay-field-h);
    padding: 4px 6px 4px 12px;
    background: #1c1917;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--pay-field-radius);
  }

  .amount-input-shell:focus-within {
    border-color: #fbbf24;
  }

  .amount-input-shell input {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: none;
    background: transparent;
  }

  .field, .amount-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .inline-max-link {
    border: none;
    background: transparent;
    padding: 0;
    color: #8d857d;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  .amount-max-link {
    line-height: 1.2;
  }

  .inline-max-link:hover:not(:disabled) {
    color: #f8fafc;
  }

  .inline-max-link:disabled {
    color: #64748b;
    cursor: default;
  }

  label {
    font-size: 11px;
    font-weight: 500;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  input {
    min-height: var(--pay-field-h);
    padding: 0 14px;
    background: #1c1917;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--pay-field-radius);
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

  @media (max-width: 900px) {
    .invoice-entry-shell {
      grid-template-columns: 1fr;
    }

    .amount-inline-tools {
      width: 100%;
      justify-content: space-between;
      flex-wrap: wrap;
    }

    .inline-token-select {
      width: 148px;
    }
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
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .btn-pay-now {
    background: linear-gradient(180deg, #7c4a1e, #8f551f);
    border: 1px solid #a16207;
    color: #fff7ed;
    font-weight: 700;
  }

  .btn-pay-now:hover:not(:disabled) {
    background: linear-gradient(180deg, #8d5421, #a16207);
    border-color: #ca8a04;
  }

  .btn-pay-now:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-find {
    background: rgba(255, 255, 255, 0.04);
    border: none;
    color: #a8a29e;
  }

  .btn-find:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.07);
    color: #fbbf24;
  }

  .btn-find:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-send {
    background: linear-gradient(180deg, #7c4a1e, #8f551f);
    border: 1px solid #a16207;
    color: #fff7ed;
  }

  .btn-send:hover:not(:disabled) {
    background: linear-gradient(180deg, #8d5421, #a16207);
    border-color: #ca8a04;
  }

  .btn-send:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .routes {
    padding-top: 16px;
    border-top: 1px solid #292524;
  }

  .scanner-modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.74);
    display: grid;
    place-items: center;
    z-index: 3000;
    padding: 20px;
  }

  .scanner-card {
    width: min(100%, 560px);
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px;
    border-radius: 18px;
    background: #14110f;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
  }

  .scanner-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }

  .scanner-card-header h4 {
    margin: 0;
    color: #f5efe6;
    font-size: 18px;
  }

  .scanner-video {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: 16px;
    background: #0c0a09;
  }

  .scanner-status {
    color: #cfc7bd;
    font-size: 13px;
  }

  .scanner-actions {
    display: flex;
    justify-content: flex-start;
    gap: 10px;
  }

  .scanner-file-input {
    display: none;
  }

  .send-controls {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    align-items: end;
  }

  .send-controls-secondary {
    grid-template-columns: auto;
    justify-content: end;
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

  .repeat-status.repeat-stopped {
    color: #f87171;
  }

  .payment-note {
    padding: 12px 14px;
    border-radius: 12px;
    border: none;
    background: rgba(38, 26, 18, 0.52);
    color: #d6c7b3;
    font-size: 12px;
    line-height: 1.45;
  }

  .payment-note strong {
    color: #f5d28a;
    font-weight: 700;
  }

  .routes-scroll {
    max-height: 360px;
    overflow-y: auto;
    scrollbar-color: var(--theme-scrollbar-thumb, #27272a) transparent;
  }

  .routes-scroll::-webkit-scrollbar {
    width: 10px;
  }

  .routes-scroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .routes-scroll::-webkit-scrollbar-thumb {
    background: var(--theme-scrollbar-thumb, #27272a);
    border-radius: 999px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  .routes-scroll::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--theme-scrollbar-thumb, #27272a) 82%, white 18%);
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

  .route-option {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
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
    position: absolute;
    opacity: 0;
    pointer-events: none;
    width: 0;
    height: 0;
    margin: 0;
  }

  .route-marker {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 2px solid rgba(255, 255, 255, 0.7);
    background: transparent;
    flex: 0 0 auto;
    margin-top: 1px;
  }

  .route-option.selected .route-marker {
    border-color: #f8fafc;
    background: radial-gradient(circle at center, #3b82f6 0 40%, transparent 45%);
  }

  .route-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
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
    gap: 4px;
  }

  .route-cards :global(.entity-identity) {
    gap: 6px;
  }

  .route-cards :global(.name) {
    font-size: 9px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .hop-card {
    padding: 2px 5px;
    border-radius: 7px;
    border: 1px solid #2a2623;
    background: #171311;
    min-width: 0;
  }

  .hop-arrow {
    color: #7c7168;
    font-size: 10px;
  }

  .route-meta {
    font-size: 8px;
    color: #71717a;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  @media (max-width: 900px) {
    .recipient-picker-row,
    .payment-actions,
    .send-controls {
      grid-template-columns: 1fr;
    }

    .recipient-refresh-btn {
      width: 100%;
    }
  }

  @media (max-width: 900px) {
    .routes-scroll {
      max-height: none;
      overflow: visible;
    }
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
