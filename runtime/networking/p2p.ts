/**
 * P2P is a dumb encrypted transport. Replay protection and tx validity belong
 * to entity/account consensus; this layer only authenticates runtime sockets,
 * verifies signed gossip profiles, and hands envelopes to an open transport.
 * Durable retry ownership belongs to the runtime outbox, never this adapter.
 */

import type { Env, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeEntityInputsEnvelope } from '../types';
import { canonicalizeProfile, getBoardPrimaryPublicKey, parseProfile, type Profile } from './gossip';
import { RuntimeWsClient } from './ws-client';
import { buildLocalEntityProfile } from './gossip-helper';
import { extractEntityId } from '../ids';
import { getSignerPrivateKeyIfAvailable, registerSignerPublicKey } from '../account/crypto';
import { computeProfileHash, signProfileRuntimeRoute, verifyProfileSignature } from './profile-signing';
import { inspectHankoForHash } from '../hanko/signing';
import { deriveEncryptionKeyPair, pubKeyToHex, hexToPubKey, type P2PKeyPair } from './p2p-crypto';
import { asFailFastPayload, failfastAssert } from './failfast';
import { normalizeRuntimeId, isRuntimeId } from './runtime-id';
import { compareStableText } from '../protocol/serialization';
import {
  DEFAULT_GOSSIP_BATCH_LIMIT,
  selectProfileBatch,
  type GossipProfileBatchRequest,
} from '../relay/profile-batch';
import { createStructuredLogger, shortId } from '../infra/logger';
import { isRuntimePerfProfileEnabled } from '../infra/perf-runtime-flags';
import {
  isBrowserDirectWsEndpointAllowed,
  isSameWsUrlList,
  normalizeOptionalWsUrl,
  sameWsUrl,
  uniqueTransportValues,
} from './p2p-endpoints';
import { deliveryAccepted, deliveryFailure, isDeliveryDelivered, type DeliveryResult } from '../protocol/payments/delivery-result';
import {
  acceptProfileEncryptionAnnouncement,
  collectLocalProfileEncryptionAnnouncements,
  getCompleteProfileEncryptionManifest,
  type ValidatorEncryptionAnnouncement,
} from './profile-encryption';

const DEFAULT_RELAY_URL = 'wss://xln.finance/relay';
const p2pLog = createStructuredLogger('p2p');
const MIN_GOSSIP_POLL_MS = 250;
const SLOW_BROWSER_TIMER_MS = 32;
const ENTITY_INPUT_TARGET_OFFLINE = 'ENTITY_INPUT_TARGET_NOT_CONNECTED';
const RELIABLE_RECEIPT_TARGET_OFFLINE = 'ENTITY_INPUT_RECEIPT_TARGET_NOT_CONNECTED';
const RETRYABLE_INGRESS_BACKPRESSURE = 'INBOUND_ENTITY_RUNTIME_QUIESCING:';

export const reportRelayClientError = (env: Env, relay: string, error: Error): void => {
  if (error.message === ENTITY_INPUT_TARGET_OFFLINE) {
    env.info('network', 'ENTITY_INPUT_TARGET_OFFLINE', { relay, error: error.message });
    return;
  }
  if (error.message === RELIABLE_RECEIPT_TARGET_OFFLINE) {
    env.info('network', 'RELIABLE_RECEIPT_TARGET_OFFLINE', { relay, error: error.message });
    return;
  }
  if (error.message.startsWith(RETRYABLE_INGRESS_BACKPRESSURE)) {
    env.info('network', 'WS_CLIENT_RETRYABLE_BACKPRESSURE', { relay, error: error.message });
    return;
  }
  env.warn('network', 'WS_CLIENT_ERROR', { relay, error: error.message });
};

export const reportDirectClientError = (
  env: Env,
  endpoint: string,
  targetRuntimeId: string,
  error: Error,
): 'retryable-backpressure' | 'transport-error' => {
  if (error.message.startsWith(RETRYABLE_INGRESS_BACKPRESSURE)) {
    env.info('network', 'WS_DIRECT_RETRYABLE_BACKPRESSURE', {
      endpoint,
      targetRuntimeId,
      error: error.message,
    });
    return 'retryable-backpressure';
  }
  env.warn('network', 'WS_DIRECT_ERROR', {
    endpoint,
    targetRuntimeId,
    error: error.message,
  });
  return 'transport-error';
};

export type P2PConfig = {
  relayUrls?: string[];
  wsUrl?: string | null;
  allowDirectClients?: boolean;
  preferRelayForEntityInput?: boolean;
  seedRuntimeIds?: string[];
  runtimeId?: string;
  signerId?: string;
  advertiseEntityIds?: string[];
  isHub?: boolean;
  gossipPollMs?: number;
};

type RuntimeP2POptions = {
  env: Env;
  runtimeId: string;
  signerId?: string;
  relayUrls?: string[];
  wsUrl?: string | null;
  allowDirectClients?: boolean;
  preferRelayForEntityInput?: boolean;
  seedRuntimeIds?: string[];
  advertiseEntityIds?: string[];
  isHub?: boolean;
  gossipPollMs?: number;
  onEntityInputs: (from: string, envelope: RuntimeEntityInputsEnvelope, timestamp?: number) => void;
  onReliableReceipt?: (from: string, receipt: ReliableDeliveryReceipt) => void;
  onGossipProfiles: (from: string, profiles: Profile[]) => void;
  onEncryptionManifestComplete?: (
    entityId: string,
    attestations: ValidatorEncryptionAnnouncement['attestation'][],
  ) => void;
};

type GossipResponsePayload = {
  profiles: Profile[];
  encryptionAnnouncements?: ValidatorEncryptionAnnouncement[];
};

type GossipRefreshMode = 'incremental' | 'full';
export type EntityInputDeliveryTransport = 'direct' | 'relay';
export type EntityInputDeliveryResult = DeliveryResult & { transport: EntityInputDeliveryTransport };

const normalizeGossipPollMs = (value: number | undefined): number => {
  if (!Number.isFinite(Number(value))) return GOSSIP_POLL_MS;
  return Math.max(MIN_GOSSIP_POLL_MS, Math.floor(Number(value)));
};

const logSlowBrowserTimer = (label: string, startedAt: number, extra = ''): void => {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return;
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs < SLOW_BROWSER_TIMER_MS) return;
  p2pLog.warn('perf.slow_timer', {
    label,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    ...(extra ? { extra } : {}),
  });
};

const isHexPublicKey = (value: string): boolean => /^0x(?:[0-9a-fA-F]{66}|[0-9a-fA-F]{130})$/.test(value);

type SanitizedIncomingProfile = {
  profile: Profile | null;
  error: string | null;
};

const sanitizeIncomingProfile = (rawProfile: unknown): SanitizedIncomingProfile => {
  let profile: Profile;
  try {
    profile = parseProfile(rawProfile);
  } catch (error) {
    return {
      profile: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const normalizedRuntimeId = normalizeRuntimeId(profile.runtimeId);
  if (!normalizedRuntimeId) {
    return {
      profile: null,
      error: `P2P_PROFILE_RUNTIME_ID_INVALID: entity=${profile.entityId}`,
    };
  }
  try {
    return {
      profile: {
        ...canonicalizeProfile(profile),
        runtimeId: normalizedRuntimeId,
      },
      error: null,
    };
  } catch (error) {
    return {
      profile: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const p2pDeliveryResult = (
  delivery: DeliveryResult,
  transport: EntityInputDeliveryTransport,
): EntityInputDeliveryResult => ({
  ...delivery,
  transport,
});

const p2pSendFalseDelivery = (transport: EntityInputDeliveryTransport): EntityInputDeliveryResult =>
  p2pDeliveryResult(
    deliveryFailure({
      category: 'TransientRace',
      code: 'P2P_SEND_RETURNED_FALSE',
      message: 'Transport send returned false',
      terminal: false,
    }),
    transport,
  );

const p2pNotDeliveredResult = (
  transport: EntityInputDeliveryTransport,
  message: string,
): EntityInputDeliveryResult =>
  p2pDeliveryResult(
    deliveryFailure({
      category: 'TransientRace',
      code: 'P2P_ENTITY_INPUT_NOT_DELIVERED',
      message,
      terminal: false,
    }),
    transport,
  );

const p2pSendThrowResult = (
  transport: EntityInputDeliveryTransport,
  message: string,
): EntityInputDeliveryResult => {
  const code = message.includes('P2P_NO_PUBKEY') ? 'P2P_NO_PUBKEY' : 'P2P_SEND_THROW';
  return p2pDeliveryResult(
    deliveryFailure({
      category: code === 'P2P_NO_PUBKEY' ? 'TransientRace' : 'Contradiction',
      code,
      message,
      terminal: code !== 'P2P_NO_PUBKEY',
    }),
    transport,
  );
};

const p2pShouldRefreshGossip = (delivery: DeliveryResult): boolean =>
  delivery.code === 'P2P_NO_PUBKEY';

const p2pSendThrowDebugCode = (delivery: DeliveryResult): string =>
  p2pShouldRefreshGossip(delivery) ? 'P2P_NO_PUBKEY_DELIVERY_FAILED' : 'P2P_SEND_THROW';

const normalizeId = (value: string): string => value.toLowerCase();
const getReplicaSignerId = (replicaKey: string): string => {
  const idx = replicaKey.lastIndexOf(':');
  return idx === -1 ? '' : replicaKey.slice(idx + 1);
};

// Relay push handles normal updates; exact cache misses use bounded on-demand
// requests. This slow reconciliation only repairs missed push notifications.
const GOSSIP_POLL_MS = 30_000;
const PROFILE_ANNOUNCE_DEBOUNCE_MS = 25;
const PROFILE_HEARTBEAT_MS = 15_000;
const GOSSIP_FETCH_RETRY_DELAYS_MS = [40, 80, 160];
const INACTIVE_TAB_STANDBY_KEY = 'xln-inactive-tab-standby';

const isInactiveTabStandby = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(INACTIVE_TAB_STANDBY_KEY) === '1';
  } catch {
    return false;
  }
};

export class RuntimeP2P {
  private env: Env;
  private runtimeId: string;
  private signerId: string;
  private relayUrls: string[];
  private wsUrl: string | null;
  private allowDirectClients: boolean;
  private preferRelayForEntityInput: boolean;
  private seedRuntimeIds: string[];
  private advertiseEntityIds: string[] | null;
  private gossipPollMs: number;
  private onEntityInputs: (from: string, envelope: RuntimeEntityInputsEnvelope, timestamp?: number) => void;
  private onReliableReceipt: (from: string, receipt: ReliableDeliveryReceipt) => void;
  private onGossipProfiles: (from: string, profiles: Profile[]) => void;
  private onEncryptionManifestComplete: RuntimeP2POptions['onEncryptionManifestComplete'];
  private clients: RuntimeWsClient[] = [];
  private directClients = new Map<string, RuntimeWsClient>();
  private directClientUrls = new Map<string, string>();
  private directClientErrors = new Map<string, { at: number; error: string }>();
  private verifiedProfileRoutes: Map<string, {
    runtimeId: string;
    runtimeEncPubKey: string;
    lastUpdated: number;
  }>;
  private bootstrapPollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private encryptionKeyPair: P2PKeyPair;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAnnounceEntities = new Set<string>();
  private lastHeartbeatAnnounceAt = 0;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly shutdownController = new AbortController();

  constructor(options: RuntimeP2POptions) {
    this.env = options.env;
    failfastAssert(isRuntimeId(options.runtimeId), 'P2P_RUNTIME_ID_INVALID', 'RuntimeP2P runtimeId must be signer EOA');
    this.runtimeId = normalizeRuntimeId(options.runtimeId);
    this.signerId = options.signerId || '1';
    this.relayUrls = uniqueTransportValues(options.relayUrls || [DEFAULT_RELAY_URL]);
    this.wsUrl = normalizeOptionalWsUrl(options.wsUrl);
    this.allowDirectClients = options.allowDirectClients !== false;
    this.preferRelayForEntityInput = options.preferRelayForEntityInput === true;
    this.seedRuntimeIds = uniqueTransportValues(options.seedRuntimeIds || []);
    this.advertiseEntityIds = options.advertiseEntityIds || null;
    this.gossipPollMs = normalizeGossipPollMs(options.gossipPollMs);
    this.onEntityInputs = options.onEntityInputs;
    this.onReliableReceipt = options.onReliableReceipt ?? (() => {
      throw new Error('P2P_RELIABLE_RECEIPT_HANDLER_MISSING');
    });
    this.onGossipProfiles = options.onGossipProfiles;
    this.onEncryptionManifestComplete = options.onEncryptionManifestComplete;
    if (!this.env.runtimeState) this.env.runtimeState = {};
    this.verifiedProfileRoutes = this.env.runtimeState.verifiedProfileRoutes ?? new Map();
    this.env.runtimeState.verifiedProfileRoutes = this.verifiedProfileRoutes;
    const seed = this.env.runtimeSeed;
    if (!seed) {
      throw new Error('P2P_INIT_ERROR: runtimeSeed is required for encryption keypair');
    }
    this.encryptionKeyPair = deriveEncryptionKeyPair(seed);
  }

  getEncryptionPublicKeyHex(): string {
    return pubKeyToHex(this.encryptionKeyPair.publicKey);
  }

  matchesIdentity(runtimeId: string, signerId?: string): boolean {
    return this.runtimeId === runtimeId && (!signerId || this.signerId === signerId);
  }

  updateConfig(config: P2PConfig) {
    if (config.allowDirectClients !== undefined && this.allowDirectClients !== (config.allowDirectClients !== false)) {
      this.allowDirectClients = config.allowDirectClients !== false;
      if (!this.allowDirectClients) this.closeDirectClients();
    }
    if (config.preferRelayForEntityInput !== undefined) {
      this.preferRelayForEntityInput = config.preferRelayForEntityInput === true;
    }
    if (config.seedRuntimeIds) {
      this.seedRuntimeIds = uniqueTransportValues(config.seedRuntimeIds);
    }
    if (Object.prototype.hasOwnProperty.call(config, 'wsUrl')) {
      const nextUrl = normalizeOptionalWsUrl(config.wsUrl);
      if (!sameWsUrl(nextUrl, this.wsUrl)) {
        this.wsUrl = nextUrl;
        this.announceLocalProfiles();
      }
    }
    if (config.advertiseEntityIds) {
      this.advertiseEntityIds = config.advertiseEntityIds;
    }
    if (config.gossipPollMs !== undefined) {
      const prevPollMs = this.gossipPollMs;
      this.gossipPollMs = normalizeGossipPollMs(config.gossipPollMs);
      if (!this.pollInterval) {
        this.startPolling();
      } else if (prevPollMs !== this.gossipPollMs) {
        // Interval changed while polling: restart to apply the new cadence.
        this.stopPolling();
        this.startPolling();
      }
    }
    if (config.relayUrls) {
      const nextUrls = uniqueTransportValues(config.relayUrls);
      if (!isSameWsUrlList(nextUrls, this.relayUrls)) {
        this.relayUrls = nextUrls;
        this.reconnect();
        return;
      }
    }
    this.announceLocalProfiles();
  }

  connect() {
    if (this.closing || this.closed) throw new Error('P2P_CONNECT_AFTER_CLOSE');
    this.registerVisibilityReconnect();
    this.startPolling();
    if (this.hasRelayConnectionActivity()) return;
    this.closeClients();
    for (const url of this.relayUrls) {
      const runtimeSeed = this.env.runtimeSeed;
      const client = new RuntimeWsClient({
        url,
        runtimeId: this.runtimeId,
        signerId: this.signerId,
        ...(runtimeSeed ? { seed: runtimeSeed } : {}),
        useHelloAuth: true,
        encryptionKeyPair: this.encryptionKeyPair,
        onPeerEncryptionKey: (fromRuntimeId: string, pubKeyHex: string) => {
          this.handlePeerEncryptionKey(fromRuntimeId, pubKeyHex);
        },
        getTargetEncryptionKey: (targetRuntimeId: string) => {
          return this.resolveTargetEncryptionKey(targetRuntimeId);
        },
        onOpen: () => {
          if (this.closing || this.closed) return;
          this.requestSeedGossip('full');
          this.announceLocalProfiles();
          this.syncDirectPeerConnections();
        },
        onEntityInputs: async (from, envelope, timestamp) => {
          await this.acceptInboundEntityInputs('relay', from, envelope, timestamp);
        },
        onReliableReceipt: (from, receipt) => {
          if (!this.closing && !this.closed) this.onReliableReceipt(from, receipt);
        },
        onGossipRequest: (from, payload) => {
          if (!this.closing && !this.closed) this.handleGossipRequest(from, payload);
        },
        onGossipResponse: (from, payload) => {
          if (!this.closing && !this.closed) this.handleGossipResponse(from, payload);
        },
        onGossipAnnounce: (from, payload) => {
          if (!this.closing && !this.closed) this.handleGossipAnnounce(from, payload);
        },
        onError: (error) => {
          reportRelayClientError(this.env, url, error);
        },
        maxReconnectAttempts: 0,
      });
      this.clients.push(client);
      client.connect().catch(error => {
        if (this.closing || this.closed) return;
        this.env.warn('network', 'WS_CONNECT_FAILED', { relay: url, error: error.message });
      });
    }
  }

  close() {
    this.closing = true;
    this.stopActivity();
    this.closeClients();
    this.closeDirectClients();
    this.closed = true;
  }

  closeAndWait(timeoutMs = 1_000): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.stopActivity();
    const attempt = this.drainAllClients(timeoutMs).then(() => {
      this.closed = true;
    });
    let tracked: Promise<void>;
    tracked = attempt.catch((error) => {
      if (this.closePromise === tracked) this.closePromise = null;
      throw error;
    });
    this.closePromise = tracked;
    return tracked;
  }

  private stopActivity(): void {
    this.shutdownController.abort();
    this.stopPolling();
    this.unregisterVisibilityReconnect();
    if (this.announceTimer) {
      clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }
    this.pendingAnnounceEntities.clear();
  }

  private startPolling() {
    if (this.pollInterval) {
      // Already polling
      return;
    }
    // Request immediately, then periodically
    this.bootstrapPollTimer = setTimeout(() => {
      this.bootstrapPollTimer = null;
      const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
      this.requestSeedGossip('incremental');
      void this.maybeHeartbeatAnnounce();
      logSlowBrowserTimer('p2p.seed-poll.bootstrap', startedAt);
    }, 100);
    this.pollInterval = setInterval(() => {
      const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
      this.requestSeedGossip('incremental');
      void this.maybeHeartbeatAnnounce();
      logSlowBrowserTimer('p2p.seed-poll.interval', startedAt);
    }, this.gossipPollMs);
  }

  private async maybeHeartbeatAnnounce(): Promise<void> {
    const client = this.getActiveClient();
    if (!client || !client.isOpen()) return;
    const now = Date.now();
    if (now - this.lastHeartbeatAnnounceAt < PROFILE_HEARTBEAT_MS) return;
    this.lastHeartbeatAnnounceAt = now;
    await this.announceLocalProfiles();
  }

  private stopPolling() {
    if (this.bootstrapPollTimer) {
      clearTimeout(this.bootstrapPollTimer);
      this.bootstrapPollTimer = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private registerVisibilityReconnect() {
    if (typeof document === 'undefined') return;
    if (this.visibilityHandler) return;
    const resume = () => {
      if (isInactiveTabStandby()) {
        return;
      }
      const activeClient = !!this.getActiveClient();
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (!activeClient) {
        p2pLog.warn('browser.resume_reconnect');
        this.reconnect();
        return;
      }
      this.requestSeedGossip('incremental');
    };
    this.visibilityHandler = resume;
    this.focusHandler = resume;
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('focus', this.focusHandler);
  }

  private unregisterVisibilityReconnect() {
    if (typeof document === 'undefined') return;
    if (!this.visibilityHandler) return;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
    if (this.focusHandler) {
      window.removeEventListener('focus', this.focusHandler);
      this.focusHandler = null;
    }
  }

  getQueueState(): { targetCount: number; totalMessages: number; oldestEntryAge: number; perTarget: Record<string, number> } {
    const pending = this.env.pendingNetworkOutputs ?? [];
    const perTarget: Record<string, number> = {};
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const output of pending) {
      const targetId = String(output.runtimeId || 'unresolved');
      perTarget[targetId] = (perTarget[targetId] ?? 0) + 1;
      const timestamp = Number(output.sourceRuntimeFrame?.timestamp);
      if (Number.isSafeInteger(timestamp) && timestamp >= 0) {
        oldestTimestamp = Math.min(oldestTimestamp, timestamp);
      }
    }
    return {
      targetCount: Object.keys(perTarget).length,
      totalMessages: pending.length,
      oldestEntryAge: Number.isFinite(oldestTimestamp)
        ? Math.max(0, Number(this.env.timestamp ?? oldestTimestamp) - oldestTimestamp)
        : 0,
      perTarget,
    };
  }

  getVerifiedRuntimeRoute(entityId: string): { runtimeId: string; lastUpdated: number } | null {
    const route = this.verifiedProfileRoutes.get(String(entityId || '').toLowerCase());
    return route ? { runtimeId: route.runtimeId, lastUpdated: route.lastUpdated } : null;
  }

  private rememberVerifiedProfileRoute(profile: Profile): void {
    const key = profile.entityId.toLowerCase();
    const existing = this.verifiedProfileRoutes.get(key);
    if (existing && existing.lastUpdated >= profile.lastUpdated) return;
    this.verifiedProfileRoutes.set(key, {
      runtimeId: normalizeRuntimeId(profile.runtimeId),
      runtimeEncPubKey: profile.runtimeEncPubKey,
      lastUpdated: profile.lastUpdated,
    });
    if (!this.env.runtimeState) this.env.runtimeState = {};
    this.env.runtimeState.verifiedProfileRoutes = this.verifiedProfileRoutes;
  }

  getReconnectState(): { attempt: number; nextAt: number } | null {
    const client = this.getActiveClient();
    if (client) return null; // Connected, no reconnect pending
    // Check first client's reconnect state
    for (const c of this.clients) {
      const state = c.getReconnectState();
      if (state) return state;
    }
    return null;
  }

  reconnect() {
    this.closeClients();
    this.connect();
  }

  isConnecting(): boolean {
    return this.clients.some(client => client.isConnecting());
  }

  getDirectPeerState(): Array<{ runtimeId: string; endpoint: string; open: boolean; lastError?: string; lastErrorAt?: number }> {
    const rows: Array<{ runtimeId: string; endpoint: string; open: boolean; lastError?: string; lastErrorAt?: number }> = [];
    for (const [runtimeId, client] of this.directClients.entries()) {
      const lastError = this.directClientErrors.get(runtimeId);
      rows.push({
        runtimeId,
        endpoint: this.directClientUrls.get(runtimeId) || client.getUrl(),
        open: client.isOpen(),
        ...(lastError ? { lastError: lastError.error, lastErrorAt: lastError.at } : {}),
      });
    }
    return rows.sort((left, right) => compareStableText(left.runtimeId, right.runtimeId));
  }

  private deliverEntityInputs(
    client: Pick<RuntimeWsClient, 'sendEntityInputsRaw'>,
    targetRuntimeId: string,
    envelope: RuntimeEntityInputsEnvelope,
    ingressTimestamp: number | undefined,
    transport: EntityInputDeliveryTransport,
  ): EntityInputDeliveryResult {
    const sent = client.sendEntityInputsRaw(targetRuntimeId, envelope, ingressTimestamp);
    return sent
      ? p2pDeliveryResult(deliveryAccepted('P2P_ENTITY_INPUT_HANDED_TO_TRANSPORT'), transport)
      : p2pSendFalseDelivery(transport);
  }

  enqueueEntityInputsDelivery(targetRuntimeId: string, envelope: RuntimeEntityInputsEnvelope, ingressTimestamp?: number): EntityInputDeliveryResult {
    try {
      failfastAssert(typeof targetRuntimeId === 'string' && targetRuntimeId.length > 0, 'P2P_TARGET_RUNTIME_INVALID', 'targetRuntimeId is required');
      failfastAssert(Array.isArray(envelope?.entityInputs), 'P2P_ENTITY_INPUTS_INVALID', 'entity_inputs envelope is malformed', { targetRuntimeId });
      const hasIntent = envelope.crossJurisdictionIntent !== undefined;
      failfastAssert(
        hasIntent ? envelope.entityInputs.length === 0 : envelope.entityInputs.length > 0,
        'P2P_ENTITY_INPUTS_INVALID',
        hasIntent ? 'cross-j intent envelope contains entity inputs' : 'entity_inputs envelope is empty',
        { targetRuntimeId },
      );
    } catch (error) {
      this.env.warn('network', 'P2P_FAILFAST_REJECT', {
        failfast: asFailFastPayload(error),
      });
      this.sendDebugEvent({
        level: 'error',
        code: 'P2P_FAILFAST_REJECT',
        failfast: asFailFastPayload(error),
      });
      throw error;
    }

    for (const input of envelope.entityInputs) {
      this.ensureRelayConnectionsForEntity(input.entityId);
      this.prefetchProfilesForInput(input);
    }

    const normalizedTargetRuntimeId = normalizeRuntimeId(targetRuntimeId);
    failfastAssert(
      !!normalizedTargetRuntimeId,
      'P2P_TARGET_RUNTIME_INVALID',
      'targetRuntimeId must be signer EOA',
      { targetRuntimeId },
    );
    const { client, transport } = this.resolveTransportClient(normalizedTargetRuntimeId);
    let delivery: EntityInputDeliveryResult | null = null;
    if (client && client.isOpen()) {
      try {
        delivery = this.deliverEntityInputs(client, normalizedTargetRuntimeId, envelope, ingressTimestamp, transport);
        if (isDeliveryDelivered(delivery)) return delivery;
        this.env.warn('network', 'P2P_SEND_FAILED', {
          targetRuntimeId: normalizedTargetRuntimeId,
          entityIds: envelope.entityInputs.map(input => input.entityId),
          transport,
          delivery,
        });
      } catch (error) {
        const message = (error as Error).message || String(error);
        const delivery = p2pSendThrowResult(transport, message);
        this.sendDebugEvent({
          level: 'error',
          code: p2pSendThrowDebugCode(delivery),
          message,
          targetRuntimeId: normalizedTargetRuntimeId,
          entityIds: envelope.entityInputs.map(input => input.entityId),
          transport,
          delivery,
        });
        if (p2pShouldRefreshGossip(delivery)) {
          this.refreshGossip();
        }
        throw new Error(
          `P2P_ENTITY_INPUTS_SEND_THROW: runtime=${normalizedTargetRuntimeId} entities=${envelope.entityInputs.length} ` +
          `transport=${transport} error=${message}`,
        );
      }
    }

    const finalMessage = delivery?.failure?.message ?? 'No open transport for entity input';
    const finalDelivery = delivery ?? p2pNotDeliveredResult(transport, finalMessage);
    this.sendDebugEvent({
      level: 'error',
      code: 'P2P_ENTITY_INPUT_NOT_DELIVERED',
      message: finalMessage,
      targetRuntimeId: normalizedTargetRuntimeId,
      entityIds: envelope.entityInputs.map(input => input.entityId),
      transport,
      relayConnected: Boolean(this.getActiveClient()),
      directPeers: this.getDirectPeerState(),
      delivery: finalDelivery,
    });
    throw new Error(
      `P2P_ENTITY_INPUTS_NOT_DELIVERED: runtime=${normalizedTargetRuntimeId} entities=${envelope.entityInputs.length} ` +
      `transport=${transport}`,
    );
  }

  enqueueReliableReceiptDelivery(
    targetRuntimeId: string,
    receipt: ReliableDeliveryReceipt,
  ): EntityInputDeliveryResult {
    const normalizedTargetRuntimeId = normalizeRuntimeId(targetRuntimeId);
    failfastAssert(
      !!normalizedTargetRuntimeId,
      'P2P_RECEIPT_TARGET_RUNTIME_INVALID',
      'Reliable receipt targetRuntimeId must be signer EOA',
      { targetRuntimeId },
    );
    const { client, transport } = this.resolveTransportClient(normalizedTargetRuntimeId);
    if (!client || !client.isOpen()) {
      return p2pDeliveryResult(
        deliveryFailure({
          category: 'TransientRace',
          code: 'P2P_RELIABLE_RECEIPT_NOT_DELIVERED',
          message: 'No open transport for reliable application receipt',
          terminal: false,
        }),
        transport,
      );
    }
    try {
      return client.sendReliableReceiptRaw(normalizedTargetRuntimeId, receipt)
        ? p2pDeliveryResult(deliveryAccepted('P2P_RELIABLE_RECEIPT_HANDED_TO_TRANSPORT'), transport)
        : p2pSendFalseDelivery(transport);
    } catch (error) {
      return p2pDeliveryResult(
        deliveryFailure({
          category: 'TransientRace',
          code: 'P2P_RELIABLE_RECEIPT_SEND_THROW',
          message: error instanceof Error ? error.message : String(error),
          terminal: false,
        }),
        transport,
      );
    }
  }

  requestGossip(runtimeId: string) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedRuntimeId) return;
    const client = this.getActiveClient();
    if (!client) return;
    client.sendGossipRequest(normalizedRuntimeId, {
      set: 'default',
      limit: DEFAULT_GOSSIP_BATCH_LIMIT,
    } satisfies GossipProfileBatchRequest);
  }

  announceProfilesTo(
    runtimeId: string,
    profiles: Profile[],
    encryptionAnnouncements: ValidatorEncryptionAnnouncement[] = [],
  ) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedRuntimeId) return;
    const client = this.getActiveClient();
    if (!client) return;
    client.sendGossipAnnounce(normalizedRuntimeId, {
      profiles,
      encryptionAnnouncements,
    } satisfies GossipResponsePayload);
  }

  isConnected(): boolean {
    return !!this.getActiveClient();
  }

  private hasRelayConnectionActivity(): boolean {
    return this.clients.some(client => client.isOpen() || client.isConnecting());
  }

  sendDebugEvent(payload: unknown): boolean {
    const client = this.getActiveClient();
    if (!client) return false;
    return client.sendDebugEvent(payload);
  }

  private getActiveClient(): RuntimeWsClient | null {
    if (this.closing || this.closed) return null;
    return this.clients.find(client => client.isOpen()) || null;
  }

  private getActiveDirectClient(runtimeId: string): RuntimeWsClient | null {
    if (this.closing || this.closed) return null;
    const client = this.directClients.get(runtimeId) || null;
    return client && client.isOpen() ? client : null;
  }

  private getDirectClientForRuntime(runtimeId: string): RuntimeWsClient | null {
    return this.getActiveDirectClient(runtimeId);
  }

  private hasDirectPeerEndpoint(runtimeId: string): boolean {
    return !!this.getDirectPeerEndpoint(runtimeId);
  }

  private resolveTransportClient(runtimeId: string): {
    client: RuntimeWsClient | null;
    transport: 'direct' | 'relay';
  } {
    if (this.preferRelayForEntityInput) {
      return {
        client: this.getActiveClient(),
        transport: 'relay',
      };
    }
    const hasDirectEndpoint = this.hasDirectPeerEndpoint(runtimeId);
    if (hasDirectEndpoint) {
      this.ensureDirectClientForRuntime(runtimeId);
      const directClient = this.getDirectClientForRuntime(runtimeId);
      if (directClient) {
        return {
          client: directClient,
          transport: 'direct',
        };
      }
    }
    return {
      client: this.getActiveClient(),
      transport: 'relay',
    };
  }

  private requestSeedGossip(mode: GossipRefreshMode = 'incremental') {
    const client = this.getActiveClient();
    if (!client) return;
    const updatedSince = mode === 'incremental' ? this.getLatestKnownRemoteProfileTimestamp() : 0;
    const request: GossipProfileBatchRequest = {
      set: 'default',
      limit: DEFAULT_GOSSIP_BATCH_LIMIT,
      ...(updatedSince > 0 ? { updatedSince } : {}),
    };
    client.sendGossipRequest(this.runtimeId, request);
  }

  private ensureRelayConnectionsForEntity(entityId: string): void {
    // Single-relay mode: never auto-discover/switch relays from gossip profiles.
    // This prevents split-brain routing where different entities publish different relay hints.
    void entityId;
  }

  private collectProfileEntityIdsForInput(input: RoutedEntityInput): string[] {
    const entitiesToCheck = new Set<string>();
    if (input.entityId) entitiesToCheck.add(input.entityId);

    if (input.entityTxs) {
      for (const tx of input.entityTxs) {
        if (tx.type === 'accountInput' && tx.data) {
          const accountInput = tx.data as { fromEntityId?: string; toEntityId?: string };
          if (accountInput.fromEntityId) entitiesToCheck.add(accountInput.fromEntityId);
          if (accountInput.toEntityId) entitiesToCheck.add(accountInput.toEntityId);
        }
        if (tx.type === 'openAccount' && tx.data) {
          const openAccount = tx.data as { targetEntityId?: string };
          if (openAccount.targetEntityId) entitiesToCheck.add(openAccount.targetEntityId);
        }
      }
    }

    return Array.from(entitiesToCheck).filter(Boolean);
  }

  private async ensureProfilesForInput(input: RoutedEntityInput): Promise<boolean> {
    const missingEntities = this.collectProfileEntityIdsForInput(input)
      .filter(entityId => !this.hasProfileForEntity(entityId));
    if (missingEntities.length === 0) return true;
    const resolved = await this.ensureProfiles(missingEntities);
    if (!resolved) {
      this.env.warn('network', 'P2P_INPUT_PROFILE_PREFETCH_MISS', {
        missingEntities,
        entityId: input.entityId,
        txTypes: input.entityTxs?.map(tx => tx.type) || [],
      });
    }
    return resolved;
  }

  private async acceptInboundEntityInputs(
    transport: 'relay' | 'direct',
    from: string,
    envelope: RuntimeEntityInputsEnvelope,
    timestamp: number | undefined,
  ): Promise<void> {
    if (this.closing || this.closed) return;
    const profileStartedAt = Date.now();
    const profileResults = await Promise.all(
      envelope.entityInputs.map(input => this.ensureProfilesForInput(input)),
    );
    if (this.closing || this.closed) return;
    if (isRuntimePerfProfileEnabled('XLN_P2P_INGRESS_PROFILE')) {
      p2pLog.info('ingress.entity_inputs', {
        transport,
        sourceRuntimeId: from,
        sourceRuntimeHeight: envelope.sourceRuntimeHeight,
        inputCount: envelope.entityInputs.length,
        profileResolved: profileResults.every(Boolean),
        profileWaitMs: Date.now() - profileStartedAt,
      });
    }
    this.onEntityInputs(from, envelope, timestamp);
  }

  private prefetchProfilesForInput(input: RoutedEntityInput): void {
    const missingEntities = this.collectProfileEntityIdsForInput(input)
      .filter(entityId => !this.hasProfileForEntity(entityId));
    if (missingEntities.length === 0) return;
    void this.ensureProfilesForInput(input).catch(error => {
      this.env.warn('network', 'P2P_FETCH_PROFILE_FAILED', { error: (error as Error).message });
    });
  }

  refreshGossip() {
    this.requestSeedGossip('full');
    void this.maybeHeartbeatAnnounce();
  }

  async syncProfiles(): Promise<boolean> {
    return this.fetchProfilesWithRetry([]);
  }

  async ensureProfiles(entityIds: string[]): Promise<boolean> {
    const requestedEntityIds = uniqueTransportValues(entityIds.map(normalizeId)).filter(Boolean);
    if (requestedEntityIds.length === 0) return true;
    let requiredEntityIds = this.expandRequiredProfileIds(requestedEntityIds);
    let missingEntityIds = requiredEntityIds.filter(entityId => !this.hasProfileForEntity(entityId));

    for (const entityId of missingEntityIds) {
      this.ensureRelayConnectionsForEntity(entityId);
    }
    if (missingEntityIds.length > 0) {
      await this.fetchProfilesWithRetry(missingEntityIds);
    }

    requiredEntityIds = this.expandRequiredProfileIds(requestedEntityIds);
    missingEntityIds = requiredEntityIds.filter(entityId => !this.hasProfileForEntity(entityId));
    if (missingEntityIds.length > 0) {
      await this.fetchProfilesWithRetry(missingEntityIds);
    }

    const hubCountBeforeFullFetch = this.env.gossip?.getHubs?.().length || 0;
    // Route-finding needs the structural hub graph, not just the target profile.
    // But once the target is resolved and we already have hubs in cache, avoid
    // forcing an extra full-batch fetch on every sender-side payment attempt.
    if (missingEntityIds.length > 0 || hubCountBeforeFullFetch === 0) {
      await this.fetchProfilesWithRetry([]);
    }

    requiredEntityIds = this.expandRequiredProfileIds(requestedEntityIds);
    missingEntityIds = requiredEntityIds.filter(entityId => !this.hasProfileForEntity(entityId));
    const resolved = missingEntityIds.length === 0;
    return resolved;
  }

  private getProfileByEntity(entityId: string): Profile | null {
    const targetEntityId = normalizeId(entityId);
    const profiles = this.env.gossip?.getProfiles?.() || [];
    return profiles.find((profile) => normalizeId(profile.entityId) === targetEntityId) || null;
  }

  private expandRequiredProfileIds(entityIds: string[]): string[] {
    const required = new Set<string>(entityIds.map(normalizeId).filter(Boolean));
    for (const entityId of Array.from(required)) {
      const profile = this.getProfileByEntity(entityId);
      if (!profile) continue;
      for (const peerId of profile.publicAccounts) {
        const normalizedPeerId = normalizeId(peerId);
        if (normalizedPeerId) required.add(normalizedPeerId);
      }
    }
    return Array.from(required);
  }

  // Check if we have a profile for an entity in local gossip cache
  private hasProfileForEntity(entityId: string): boolean {
    return this.getProfileByEntity(entityId) !== null;
  }

  private getLatestKnownRemoteProfileTimestamp(): number {
    const profiles = this.env.gossip?.getProfiles?.() || [];
    let latest = 0;
    for (const profile of profiles) {
      const profileRuntimeId = normalizeRuntimeId(profile.runtimeId || '');
      if (profileRuntimeId && profileRuntimeId === this.runtimeId) {
        continue;
      }
      const ts = profile.lastUpdated;
      if (ts > latest) latest = ts;
    }
    return latest;
  }

  private waitForActiveDelay(delayMs: number): Promise<boolean> {
    const signal = this.shutdownController.signal;
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (active: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(active);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(true), delayMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Fetch profiles from relay with bounded retry for cold or stale caches.
  private async fetchProfilesWithRetry(missingEntityIds: string[] = []): Promise<boolean> {
    if (this.closing || this.closed) return false;
    if (!this.getActiveClient()) {
      this.env.warn('network', 'GOSSIP_PROFILE_FETCH_NO_CLIENT', {
        missingEntityIds,
      });
      return false;
    }
    const startCount = this.env.gossip?.getProfiles?.()?.length || 0;
    const startedAt = Date.now();
    for (const waitMs of GOSSIP_FETCH_RETRY_DELAYS_MS) {
      const client = this.getActiveClient();
      if (!client) return false;
      if (missingEntityIds.length > 0) {
        client.sendGossipRequest(this.runtimeId, {
          ids: missingEntityIds,
        } satisfies GossipProfileBatchRequest);
      } else {
        this.requestSeedGossip('full');
      }
      if (!await this.waitForActiveDelay(waitMs)) return false;
      const profiles = this.env.gossip?.getProfiles?.() || [];
      const hasAllMissing = missingEntityIds.length > 0 && missingEntityIds.every((entityId) => this.hasProfileForEntity(entityId));
      if (profiles.length > startCount || hasAllMissing) {
        return missingEntityIds.length === 0 ? profiles.length > startCount : hasAllMissing;
      }
    }
    if (missingEntityIds.length === 0) return false;
    if (missingEntityIds.length > 0) {
      this.env.warn('network', 'GOSSIP_PROFILE_MISS', {
        missingEntityIds,
        retries: GOSSIP_FETCH_RETRY_DELAYS_MS.length,
        elapsedMs: Date.now() - startedAt,
      });
      this.sendDebugEvent({
        level: 'warn',
        code: 'GOSSIP_PROFILE_MISS',
        missingEntityIds,
        retries: GOSSIP_FETCH_RETRY_DELAYS_MS.length,
        elapsedMs: Date.now() - startedAt,
      });
    }
    return false;
  }

  async announceLocalProfiles() {
    if (this.closing || this.closed) return;
    const encryptionAnnouncements = this.getLocalEncryptionAnnouncements();
    const profiles = await this.getLocalProfilesForEntities();
    if (this.closing || this.closed) return;
    if (profiles.length === 0 && encryptionAnnouncements.length === 0) return;
    for (const profile of profiles) {
      this.env.gossip?.announce?.(profile);
    }

    // ALWAYS announce to relay for storage (relay stores regardless of 'to' field)
    const client = this.getActiveClient();
    if (client) {
      client.sendGossipAnnounce(this.runtimeId, { profiles, encryptionAnnouncements } satisfies GossipResponsePayload);
    }

    // Also send to specific seeds if configured (for direct peer notification)
    for (const seedId of this.seedRuntimeIds) {
      this.announceProfilesTo(seedId, profiles, encryptionAnnouncements);
    }
  }

  announceProfilesForEntities(entityIds: string[], reason: string = 'runtime-change') {
    if (this.closing || this.closed) return;
    if (!entityIds || entityIds.length === 0) return;
    for (const entityId of entityIds) {
      if (!entityId) continue;
      this.pendingAnnounceEntities.add(normalizeId(entityId));
    }
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => {
      const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
      const targets = Array.from(this.pendingAnnounceEntities);
      this.pendingAnnounceEntities.clear();
      this.announceTimer = null;
      if (this.closing || this.closed) return;
      this.announceProfilesNow(targets, reason).catch(error => {
        this.env.warn('network', 'P2P_ANNOUNCE_FAILED', { reason, error: (error as Error).message });
      });
      logSlowBrowserTimer('p2p.announce-debounce', startedAt, `targets=${targets.length} reason=${reason}`);
    }, PROFILE_ANNOUNCE_DEBOUNCE_MS);
  }

  async announceProfilesForEntitiesNow(
    entityIds: string[],
    reason: string = 'runtime-change',
    includePending = true,
  ): Promise<void> {
    if (this.closing || this.closed) return;
    if (!entityIds || entityIds.length === 0) return;
    const targets = new Set<string>();
    if (includePending) {
      for (const pending of this.pendingAnnounceEntities) {
        if (pending) targets.add(normalizeId(pending));
      }
    }
    for (const entityId of entityIds) {
      if (entityId) targets.add(normalizeId(entityId));
    }
    if (includePending) this.pendingAnnounceEntities.clear();
    if (includePending && this.announceTimer) {
      clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }
    await this.announceProfilesNow(Array.from(targets), reason);
  }

  private async announceProfilesNow(entityIds: string[], reason: string) {
    if (this.closing || this.closed) return;
    const encryptionAnnouncements = this.getLocalEncryptionAnnouncements(entityIds);
    const profiles = await this.getLocalProfilesForEntities(entityIds);
    if (this.closing || this.closed) return;
    if (profiles.length === 0 && encryptionAnnouncements.length === 0) return;
    for (const profile of profiles) {
      this.env.gossip?.announce?.(profile);
    }
    const client = this.getActiveClient();
    if (client) {
      client.sendGossipAnnounce(this.runtimeId, { profiles, encryptionAnnouncements } satisfies GossipResponsePayload);
    }
    for (const seedId of this.seedRuntimeIds) {
      this.announceProfilesTo(seedId, profiles, encryptionAnnouncements);
    }
    p2pLog.debug('profile.announce', {
      reason,
      count: profiles.length,
      encryptionAttestationCount: encryptionAnnouncements.length,
      entities: profiles.map(profile => shortId(profile.entityId)),
    });
  }

  private getLocalEncryptionAnnouncements(entityIds?: string[]): ValidatorEncryptionAnnouncement[] {
    const requested = entityIds && entityIds.length > 0
      ? new Set(entityIds.map(normalizeId))
      : null;
    const advertised = this.advertiseEntityIds && this.advertiseEntityIds.length > 0
      ? new Set(this.advertiseEntityIds.map(normalizeId))
      : null;
    const target = requested && advertised
      ? new Set([...requested].filter((entityId) => advertised.has(entityId)))
      : requested ?? advertised ?? undefined;
    return collectLocalProfileEncryptionAnnouncements(this.env, target);
  }

  private async getLocalProfilesForEntities(entityIds?: string[]): Promise<Profile[]> {
    if (!this.env.eReplicas || this.env.eReplicas.size === 0) return [];
    const targetSet = entityIds && entityIds.length > 0 ? new Set(entityIds.map(normalizeId)) : null;
    const advertisedSet = this.advertiseEntityIds && this.advertiseEntityIds.length > 0
      ? new Set(this.advertiseEntityIds.map(normalizeId))
      : null;
    const profiles: Profile[] = [];
    const seen = new Set<string>();
    for (const [replicaKey, replica] of this.env.eReplicas.entries()) {
      const entityId = extractEntityId(replicaKey);
      const replicaSignerId = getReplicaSignerId(replicaKey);
      // Only advertise entities we can actually sign for.
      // This excludes imported/foreign replicas in browser runtimes while still
      // allowing server runtimes (runtimeId may differ from signer addresses).
      if (!replicaSignerId) {
        continue;
      }
      if (getSignerPrivateKeyIfAvailable(this.env, replicaSignerId) === null) continue;
      const normalizedEntityId = normalizeId(entityId);
      if (seen.has(normalizedEntityId)) continue;
      if (advertisedSet && !advertisedSet.has(normalizedEntityId)) continue;
      if (targetSet && !targetSet.has(normalizedEntityId)) continue;
      seen.add(normalizedEntityId);

      const encryptionManifest = getCompleteProfileEncryptionManifest(this.env, replica.state);
      if (!encryptionManifest) {
        p2pLog.debug('profile.encryption_manifest_pending', {
          entity: shortId(entityId),
          signer: shortId(replicaSignerId),
        });
        continue;
      }

      // MONOTONIC TIMESTAMP: Ensure timestamp grows even if env.timestamp doesn't change
      // Get last announced timestamp for this entity from gossip
      const existingProfile = this.env.gossip?.getProfiles?.().find((profile) => profile.entityId === entityId);
      const lastTimestamp = existingProfile?.lastUpdated || 0;
      const monotonicTimestamp = Math.max(lastTimestamp + 1, this.env.timestamp);
      const profile = buildLocalEntityProfile(this.env, replica.state, monotonicTimestamp);
      profile.runtimeId = this.runtimeId;
      profile.wsUrl = profile.metadata.isHub === true ? this.wsUrl : null;
      profile.relays = this.relayUrls;
      const profileHash = computeProfileHash(profile);
      const certification = replica.hankoWitness?.get(profileHash);
      if (!certification || certification.type !== 'profile') {
        p2pLog.debug('profile.certification_pending', {
          entity: shortId(entityId),
          hash: profileHash.slice(0, 18),
          signer: shortId(replicaSignerId),
        });
        continue;
      }
      profile.metadata.profileHanko = certification.hanko;
      const signedProfile = await signProfileRuntimeRoute(this.env as Env, profile, replicaSignerId);
      profiles.push(signedProfile);
    }
    return profiles;
  }

  private handleGossipRequest(from: string, payload: unknown) {
    if (!this.env.gossip?.getProfiles) return;
    const request = payload as GossipProfileBatchRequest;
    const profiles = this.getLocalProfileBatch(request);
    const encryptionAnnouncements = this.getLocalEncryptionAnnouncements(request.ids);

    const client = this.getActiveClient();
    if (!client) return;
    client.sendGossipResponse(from, { profiles, encryptionAnnouncements } satisfies GossipResponsePayload);
  }

  private getLocalProfileBatch(request: GossipProfileBatchRequest = {}): Profile[] {
    const allProfiles = this.env.gossip?.getProfiles?.() || [];
    return selectProfileBatch(allProfiles, request, DEFAULT_GOSSIP_BATCH_LIMIT);
  }

  private handleGossipResponse(from: string, payload: unknown) {
    const response = payload as GossipResponsePayload;
    const profiles = Array.isArray(response?.profiles) ? response.profiles : [];
    const encryptionAnnouncements = Array.isArray(response?.encryptionAnnouncements)
      ? response.encryptionAnnouncements
      : [];
    this.applyIncomingEncryptionAnnouncements(from, encryptionAnnouncements);
    this.applyIncomingProfiles(from, profiles).catch(err => {
      this.env.warn('network', 'P2P_APPLY_PROFILES_ERROR', { error: err.message });
    });
  }

  private handleGossipAnnounce(from: string, payload: unknown) {
    const response = payload as GossipResponsePayload;
    const profiles = Array.isArray(response?.profiles) ? response.profiles : [];
    const encryptionAnnouncements = Array.isArray(response?.encryptionAnnouncements)
      ? response.encryptionAnnouncements
      : [];
    this.applyIncomingEncryptionAnnouncements(from, encryptionAnnouncements);
    this.applyIncomingProfiles(from, profiles).catch(err => {
      this.env.warn('network', 'P2P_APPLY_PROFILES_ERROR', { error: err.message });
    });
  }

  private applyIncomingEncryptionAnnouncements(
    from: string,
    announcements: ValidatorEncryptionAnnouncement[],
  ): void {
    if (this.closing || this.closed) return;
    if (announcements.length === 0) return;
    const localEntities = new Map(
      [...this.env.eReplicas.values()].map((replica) => [normalizeId(replica.entityId), replica.state] as const),
    );
    for (const announcement of announcements) {
      if (this.closing || this.closed) return;
      let entityId = 'unknown';
      try {
        if (
          !announcement ||
          typeof announcement !== 'object' ||
          !announcement.board ||
          typeof announcement.board.entityId !== 'string'
        ) {
          throw new Error('PROFILE_ENCRYPTION_ANNOUNCEMENT_MALFORMED');
        }
        entityId = normalizeId(announcement.board.entityId);
        const state = localEntities.get(entityId);
        if (!state) continue;
        acceptProfileEncryptionAnnouncement(this.env, announcement);
        const complete = getCompleteProfileEncryptionManifest(this.env, state);
        if (complete) {
          p2pLog.debug('profile.encryption_manifest_complete', {
            from: shortId(from),
            entity: shortId(entityId),
            hash: complete.hash.slice(0, 18),
            validators: complete.attestations.length,
          });
          if (state.profileEncryptionManifest?.hash !== complete.hash) {
            this.onEncryptionManifestComplete?.(entityId, [...complete.attestations]);
          }
        }
      } catch (error) {
        p2pLog.warn('profile.encryption_attestation_dropped', {
          from: shortId(from),
          entity: shortId(entityId || 'unknown'),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async applyIncomingProfiles(from: string, profiles: Profile[]) {
    if (this.closing || this.closed) return;
    if (profiles.length === 0) return;
    let accepted = 0;
    const acceptedProfiles: Profile[] = [];
    for (const profile of profiles) {
      const { profile: sanitized, error: malformedReason } = sanitizeIncomingProfile(profile);
      if (!sanitized) {
        const entityId = typeof profile === 'object' && profile !== null && 'entityId' in profile
          ? String((profile as { entityId?: unknown }).entityId || 'unknown')
          : 'unknown';
        p2pLog.warn('profile.dropped_malformed', {
          from: shortId(from),
          entity: shortId(entityId),
          reason: malformedReason || 'unknown',
        });
        continue;
      }
      const existingProfiles = this.env.gossip?.getProfiles?.() || [];
      const existing = existingProfiles.find((existingProfile) => existingProfile.entityId === sanitized.entityId);
      const verifiedRoute = this.getVerifiedRuntimeRoute(sanitized.entityId);
      if (verifiedRoute && verifiedRoute.lastUpdated >= sanitized.lastUpdated) {
        if (
          verifiedRoute.lastUpdated === sanitized.lastUpdated &&
          normalizeRuntimeId(verifiedRoute.runtimeId) !== normalizeRuntimeId(sanitized.runtimeId)
        ) {
          p2pLog.warn('profile.dropped_equal_version_route_conflict', {
            from: shortId(from),
            entity: shortId(sanitized.entityId),
            acceptedRuntime: shortId(verifiedRoute.runtimeId),
            rejectedRuntime: shortId(sanitized.runtimeId),
            lastUpdated: sanitized.lastUpdated,
          });
        }
        continue;
      }
      if (
        existing &&
        existing.lastUpdated >= sanitized.lastUpdated &&
        verifiedRoute &&
        verifiedRoute.lastUpdated >= sanitized.lastUpdated
      ) {
        continue;
      }

      const hasHanko = sanitized.metadata.profileHanko;
      if (!hasHanko) {
        p2pLog.warn('profile.dropped_unsigned', {
          from: shortId(from),
          entity: shortId(sanitized.entityId),
        });
        continue;
      }
      {
        const result = await verifyProfileSignature(sanitized, this.env);
        if (this.closing || this.closed) return;
        if (!result.valid) {
          const boardValidators = sanitized.metadata.board.validators;
          const hasBoardKey = boardValidators.some((validator) => typeof validator.publicKey === 'string');
          const entityPublicKey = getBoardPrimaryPublicKey(sanitized.metadata.board, sanitized.entityId);
          let hankoInspect:
            | {
                recoveredAddresses: string[];
                reconstructedBoardHash?: string;
              }
            | undefined;
          try {
            const details = await inspectHankoForHash(String(hasHanko), String(result.hash || '0x'));
            hankoInspect = {
              recoveredAddresses: details.recoveredAddresses,
            };
            const reconstructedBoardHash = details.claims[0]?.reconstructedBoardHash;
            if (reconstructedBoardHash !== undefined) {
              hankoInspect.reconstructedBoardHash = reconstructedBoardHash;
            }
          } catch (error) {
            hankoInspect = {
              recoveredAddresses: [`inspect_failed:${(error as Error).message}`],
            };
          }
          p2pLog.error('profile.invalid_signature', {
            entity: shortId(sanitized.entityId),
            from: shortId(from),
            reason: result.reason,
            hash: result.hash ? `${result.hash.slice(0, 18)}..` : undefined,
            signerId: result.signerId,
            hanko: typeof hasHanko === 'string' ? `${hasHanko.slice(0, 30)}..` : Boolean(hasHanko),
            entityPublicKey: `${entityPublicKey.slice(0, 20)}..`,
            boardPublicKey: hasBoardKey,
            validators: boardValidators.length,
            boardSigners: boardValidators.map((validator) => String(validator.signerId || validator.signer)).filter(Boolean),
            recoveredAddresses: hankoInspect?.recoveredAddresses ?? [],
            reconstructedBoardHash: hankoInspect?.reconstructedBoardHash,
            runtimeId: sanitized.runtimeId,
            name: sanitized.name,
          });
          continue;
        }
      }

      for (const validator of sanitized.metadata.board.validators) {
        const signerId = validator.signer;
        const publicKey = validator.publicKey;
        if (signerId && publicKey && isHexPublicKey(publicKey)) {
          registerSignerPublicKey(this.env, signerId, publicKey);
        }
      }

      if (this.closing || this.closed) return;
      this.rememberVerifiedProfileRoute(sanitized);
      this.env.gossip?.announce?.(sanitized);
      accepted++;
      acceptedProfiles.push(sanitized);
    }
    if (this.closing || this.closed) return;
    if (accepted > 0) {
      this.syncDirectPeerConnections();
    }
    this.onGossipProfiles(from, acceptedProfiles);
  }

  private closeClients() {
    // close() only initiates terminal shutdown. Keep ownership until
    // drainAllClients() receives every close handshake or reports failure.
    for (const client of this.clients) {
      client.close();
    }
  }

  private closeDirectClients() {
    // Direct clients follow the same sync-then-awaited lifecycle as relays.
    for (const client of this.directClients.values()) {
      client.close();
    }
  }

  private async drainAllClients(timeoutMs: number): Promise<void> {
    const entries = [
      ...this.clients.map((client) => ({ kind: 'relay' as const, key: '', client })),
      ...[...this.directClients.entries()].map(([key, client]) => ({ kind: 'direct' as const, key, client })),
    ];
    const results = await Promise.allSettled(
      entries.map(({ client }) => client.closeAndWait(timeoutMs)),
    );
    const errors: Error[] = [];
    results.forEach((result, index) => {
      const entry = entries[index]!;
      if (result.status === 'rejected') {
        const cause = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        errors.push(new Error(
          `P2P_${entry.kind.toUpperCase()}_CLOSE_FAILED:${entry.key || index}:${cause.message}`,
          { cause },
        ));
        return;
      }
      if (entry.kind === 'relay') this.clients = this.clients.filter(client => client !== entry.client);
      else if (this.directClients.get(entry.key) === entry.client) {
        this.directClients.delete(entry.key);
        this.directClientUrls.delete(entry.key);
        this.directClientErrors.delete(entry.key);
      }
    });
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'P2P_CLOSE_FAILED');
  }

  private getDirectPeerEndpoint(runtimeId: string): string | null {
    if (!this.allowDirectClients) return null;
    const normalizedTargetRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedTargetRuntimeId || normalizedTargetRuntimeId === this.runtimeId) return null;
    const profiles = this.env.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      if (normalizeRuntimeId(profile.runtimeId || '') !== normalizedTargetRuntimeId) continue;
      if (profile.metadata?.isHub !== true) continue;
      const endpoint = normalizeOptionalWsUrl(profile.wsUrl);
      if (endpoint && isBrowserDirectWsEndpointAllowed(endpoint)) return endpoint;
    }
    return null;
  }

  private resolveTargetEncryptionKey(targetRuntimeId: string): Uint8Array | null {
    const normalizedTargetRuntimeId = normalizeRuntimeId(targetRuntimeId);
    if (!normalizedTargetRuntimeId) return null;
    const signedKeys = new Set<string>();
    for (const route of this.verifiedProfileRoutes.values()) {
      if (normalizeRuntimeId(route.runtimeId) !== normalizedTargetRuntimeId) continue;
      const rawKey = route.runtimeEncPubKey;
      if (typeof rawKey !== 'string' || rawKey.length === 0) continue;
      const normalizedKey = rawKey.startsWith('0x') ? rawKey.toLowerCase() : `0x${rawKey.toLowerCase()}`;
      if (!/^0x[0-9a-f]{64}$/.test(normalizedKey)) continue;
      signedKeys.add(normalizedKey);
    }
    if (signedKeys.size > 1) {
      throw new Error(`P2P_SIGNED_RUNTIME_KEY_CONFLICT: runtimeId=${normalizedTargetRuntimeId}`);
    }
    const selectedKey = signedKeys.values().next().value as string | undefined;
    if (!selectedKey) return null;
    return hexToPubKey(selectedKey);
  }

  private validateTransportEncryptionHint(fromRuntimeId: string, pubKeyHex: string): void {
    if (this.closing || this.closed) return;
    const normalizedRuntimeId = normalizeRuntimeId(fromRuntimeId);
    if (!normalizedRuntimeId) return;
    const signedKey = this.resolveTargetEncryptionKey(normalizedRuntimeId);
    // Relay identities need not publish Entity profiles. Their transport hint
    // is informational and never becomes encryption authority.
    if (!signedKey) return;
    const hintedKey = hexToPubKey(pubKeyHex);
    if (signedKey.every((byte, index) => byte === hintedKey[index])) return;
    throw new Error(`P2P_TRANSPORT_ENCRYPTION_KEY_MISMATCH: runtimeId=${normalizedRuntimeId}`);
  }

  private handlePeerEncryptionKey(fromRuntimeId: string, pubKeyHex: string): void {
    try {
      this.validateTransportEncryptionHint(fromRuntimeId, pubKeyHex);
    } catch (error) {
      this.env.warn('network', 'P2P_TRANSPORT_ENCRYPTION_KEY_REJECTED', {
        runtimeId: normalizeRuntimeId(fromRuntimeId),
        error: (error as Error).message,
      });
      throw error;
    }
  }

  private ensureDirectClientForRuntime(runtimeId: string): void {
    if (this.closing || this.closed) return;
    const normalizedTargetRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedTargetRuntimeId || normalizedTargetRuntimeId === this.runtimeId) return;
    const endpoint = this.getDirectPeerEndpoint(normalizedTargetRuntimeId);
    if (!endpoint) return;
    const existing = this.directClients.get(normalizedTargetRuntimeId);
    const existingUrl = this.directClientUrls.get(normalizedTargetRuntimeId);
    if (existing && existingUrl === endpoint) {
      if (!existing.isOpen() && !existing.isConnecting()) {
        existing.connect().catch(error => {
          this.env.warn('network', 'WS_DIRECT_CONNECT_FAILED', {
            endpoint,
            targetRuntimeId: normalizedTargetRuntimeId,
            error: (error as Error).message,
          });
        });
      }
      return;
    }
    if (existing) {
      existing.close();
      this.directClients.delete(normalizedTargetRuntimeId);
      this.directClientUrls.delete(normalizedTargetRuntimeId);
      this.directClientErrors.delete(normalizedTargetRuntimeId);
    }
    const client = new RuntimeWsClient({
      url: endpoint,
      runtimeId: this.runtimeId,
      signerId: this.signerId,
      ...(this.env.runtimeSeed ? { seed: this.env.runtimeSeed } : {}),
      useHelloAuth: true,
      encryptionKeyPair: this.encryptionKeyPair,
      getTargetEncryptionKey: (targetRuntimeId: string) => {
        return this.resolveTargetEncryptionKey(targetRuntimeId);
      },
      onPeerEncryptionKey: (fromRuntimeId: string, pubKeyHex: string) => {
        this.handlePeerEncryptionKey(fromRuntimeId, pubKeyHex);
      },
      onOpen: () => {
        if (this.closing || this.closed) return;
        this.directClientErrors.delete(normalizedTargetRuntimeId);
      },
      onEntityInputs: async (from, envelope, timestamp) => {
        await this.acceptInboundEntityInputs('direct', from, envelope, timestamp);
      },
      onReliableReceipt: (from, receipt) => {
        if (!this.closing && !this.closed) this.onReliableReceipt(from, receipt);
      },
      onError: (error) => {
        if (this.closing || this.closed) return;
        if (reportDirectClientError(this.env, endpoint, normalizedTargetRuntimeId, error) === 'retryable-backpressure') {
          return;
        }
        this.directClientErrors.set(normalizedTargetRuntimeId, {
          at: Date.now(),
          error: error.message,
        });
      },
      maxReconnectAttempts: 0,
    });
    this.directClients.set(normalizedTargetRuntimeId, client);
    this.directClientUrls.set(normalizedTargetRuntimeId, endpoint);
    client.connect().catch(error => {
      if (this.closing || this.closed) return;
      this.env.warn('network', 'WS_DIRECT_CONNECT_FAILED', {
        endpoint,
        targetRuntimeId: normalizedTargetRuntimeId,
        error: (error as Error).message,
      });
    });
  }

  private syncDirectPeerConnections(): void {
    if (this.closing || this.closed) return;
    if (!this.allowDirectClients) {
      this.closeDirectClients();
      return;
    }
    const desired = new Map<string, string>();
    const profiles = this.env.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      const runtimeId = normalizeRuntimeId(profile.runtimeId || '');
      if (!runtimeId || runtimeId === this.runtimeId) continue;
      const endpoint = this.getDirectPeerEndpoint(runtimeId);
      if (!endpoint) continue;
      desired.set(runtimeId, endpoint);
      this.ensureDirectClientForRuntime(runtimeId);
    }
    for (const runtimeId of Array.from(this.directClients.keys())) {
      if (desired.has(runtimeId)) continue;
      this.directClients.get(runtimeId)?.close();
      this.directClients.delete(runtimeId);
      this.directClientUrls.delete(runtimeId);
    }
  }

}
