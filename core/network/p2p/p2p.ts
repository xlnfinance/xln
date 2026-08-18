/**
 * P2P is a dumb encrypted transport. Replay protection and tx validity belong
 * to entity/account consensus; this layer only authenticates runtime sockets,
 * verifies signed gossip profiles, and hands envelopes to an open transport.
 * Durable retry ownership belongs to the runtime outbox, never this adapter.
 */

import type { RuntimeReplica, RoutedEntityInput, RuntimeEntityInputsEnvelope } from '../../runtime/types';
import { canonicalizeProfile, parseProfile, type Profile } from '../../entity/profile';
import { RuntimeWsClient } from './ws-client';
import { canonicalizeRuntimeWsAudience, directRuntimeWsAudience } from './ws-protocol';
import { buildLocalEntityProfile } from './gossip/helper';
import { extractEntityId } from '../../protocol/identity';
import {
  computeProfileHash,
  signProfileRuntimeRoute,
  verifyProfileSignature,
} from '../../entity/profile/profile-signing';
import { hasCurrentBoardProfileRouteAuthority } from './gossip/local-profile-lifecycle';
import { inspectHankoForHash } from '../../hanko/signing';
import { deriveEncryptionKeyPair, pubKeyToHex, hexToPubKey, type P2PKeyPair } from '../../protocol/crypto/p2p-crypto';
import { asFailFastPayload, failfastAssert } from './failfast';
import { normalizeRuntimeId, isRuntimeId } from './auth/runtime-id';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import {
  DEFAULT_GOSSIP_BATCH_LIMIT,
  decodeGossipProfileBatchRequest,
  selectProfileBatch,
  DEFAULT_GOSSIP_ROUTE_TO_ROUTES,
  MAX_GOSSIP_ROUTE_TO_ROUTES,
  encodeRouteToRequest,
  type GossipRouteToRequest,
  type GossipProfileBatchRequest,
} from './gossip/profile-batch';
import { createStructuredLogger, shortId } from '../../support/logger';
import {
  isBrowserDirectWsEndpointAllowed,
  isSameWsUrlList,
  normalizeOptionalWsUrl,
  sameWsUrl,
  uniqueTransportValues,
} from './p2p-endpoints';
import {
  deliveryAccepted,
  deliveryFailure,
  isDeliveryDelivered,
  type DeliveryResult,
} from '../../protocol/payments/delivery-result';
import { isRetryableIngressBackpressure } from './ingress-backpressure';
import { assertRuntimeEntityInputsEnvelopeSource } from '../../runtime/admit/entity-input-envelope-auth.ts';
import { retryFailure } from '../../protocol/errors/failure-taxonomy';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../protocol/boundary-validation';
import {
  decodeJurisdictionGossipAnnouncement,
  MAX_JURISDICTION_GOSSIP_BATCH_RECORDS,
  type JurisdictionGossipAnnouncement,
} from '../../jurisdiction/gossip/announcement';

const DEFAULT_RELAY_URL = 'wss://xln.finance/relay';
const p2pLog = createStructuredLogger('p2p');
const MIN_GOSSIP_POLL_MS = 250;
const SLOW_BROWSER_TIMER_MS = 32;
const ENTITY_INPUT_TARGET_OFFLINE = 'ENTITY_INPUT_TARGET_NOT_CONNECTED';
const ENTITY_INPUT_RATE_LIMITED = 'ENTITY_INPUT_RATE_LIMITED';
export const reportRelayClientError = (env: RuntimeReplica, relay: string, error: Error): void => {
  if (error.message === ENTITY_INPUT_TARGET_OFFLINE) {
    env.info('network', 'ENTITY_INPUT_TARGET_OFFLINE', { relay, error: error.message });
    return;
  }
  if (error.message === ENTITY_INPUT_RATE_LIMITED) {
    env.info('network', 'ENTITY_INPUT_RATE_LIMITED', { relay, error: error.message });
    return;
  }
  if (isRetryableIngressBackpressure(error)) {
    env.info('network', 'WS_CLIENT_RETRYABLE_BACKPRESSURE', { relay, error: error.message });
    return;
  }
  env.warn('network', 'WS_CLIENT_ERROR', { relay, error: error.message });
};

export const reportDirectClientError = (
  env: RuntimeReplica,
  endpoint: string,
  targetRuntimeId: string,
  error: Error,
): 'retryable-backpressure' | 'transport-error' => {
  if (isRetryableIngressBackpressure(error)) {
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

export type P2PGossipSet = 'default' | 'hubs';

export type P2PConfig = {
  relayUrls?: string[];
  wsUrl?: string | null;
  seedRuntimeIds?: string[];
  runtimeId?: string;
  signerId?: string;
  advertiseEntityIds?: string[];
  gossipPollMs?: number;
  /**
   * Which profile set the periodic poll pulls. Runtimes hosting hubs pull
   * 'default' (everything the relay knows); user runtimes pull 'hubs' and
   * discover everything else on demand (ids / routeTo). Nothing is pushed.
   */
  gossipSet?: P2PGossipSet;
  /** Re-announce cadence for unchanged local profiles (hubs 15 s, users hourly). */
  profileHeartbeatMs?: number;
};

type InboundEntityInputsOptions = {
  envelopeSourceVerified?: boolean;
  entityInputsValidated?: boolean;
};

type RuntimeP2POptions = {
  env: RuntimeReplica;
  runtimeId: string;
  signerId?: string;
  relayUrls?: string[];
  wsUrl?: string | null;
  seedRuntimeIds?: string[];
  advertiseEntityIds?: string[];
  gossipPollMs?: number;
  gossipSet?: P2PGossipSet;
  profileHeartbeatMs?: number;
  onEntityInputs: (
    from: string,
    envelope: RuntimeEntityInputsEnvelope,
    timestamp?: number,
    options?: InboundEntityInputsOptions,
  ) => void;
  onGossipProfiles: (from: string, profiles: Profile[]) => void;
  onGossipJurisdictions?: (from: string, announcements: JurisdictionGossipAnnouncement[]) => void;
  officialFoundationSignerId?: string;
};

type GossipResponsePayload = {
  profiles: Profile[];
  jurisdictions: JurisdictionGossipAnnouncement[];
};

const decodeGossipPayload = (value: unknown): Readonly<{ profiles: unknown[]; jurisdictions: unknown[]; cursor?: number }> => {
  const response = requireBoundaryRecord(value, 'P2P_GOSSIP_RESPONSE_INVALID');
  requireExactBoundaryKeys(response, ['profiles', 'jurisdictions'], ['cursor'], 'P2P_GOSSIP_RESPONSE_FIELDS_INVALID');
  const cursor = response['cursor'];
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || Number(cursor) < 0)) {
    throw new Error('P2P_GOSSIP_RESPONSE_CURSOR_INVALID');
  }
  if (!Array.isArray(response['profiles'])) throw new Error('P2P_GOSSIP_RESPONSE_PROFILES_INVALID');
  if (!Array.isArray(response['jurisdictions'])) throw new Error('P2P_GOSSIP_RESPONSE_JURISDICTIONS_INVALID');
  if (response['profiles'].length > DEFAULT_GOSSIP_BATCH_LIMIT) {
    throw new Error('P2P_GOSSIP_RESPONSE_BATCH_TOO_LARGE');
  }
  if (response['jurisdictions'].length > MAX_JURISDICTION_GOSSIP_BATCH_RECORDS) {
    throw new Error('P2P_GOSSIP_RESPONSE_JURISDICTION_BATCH_TOO_LARGE');
  }
  return {
    profiles: response['profiles'],
    jurisdictions: response['jurisdictions'],
    ...(cursor === undefined ? {} : { cursor: Number(cursor) }),
  };
};

type GossipRefreshMode = 'incremental' | 'full';
export type EntityInputDeliveryTransport = 'direct' | 'relay';
export type EntityInputDeliveryResult = DeliveryResult & { transport: EntityInputDeliveryTransport };

const normalizeProfileHeartbeatMs = (value: number | undefined, gossipSet: P2PGossipSet): number => {
  const fallback = gossipSet === 'default' ? HUB_PROFILE_HEARTBEAT_MS : USER_PROFILE_HEARTBEAT_MS;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1_000, Math.floor(value));
};

const normalizeGossipPollMs = (value: number | undefined): number => {
  if (!Number.isFinite(Number(value))) return GOSSIP_POLL_MS;
  return Math.max(MIN_GOSSIP_POLL_MS, Math.floor(Number(value)));
};

const logSlowBrowserTimer = (label: string, startedAt: number, extra = ''): void => {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return;
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs < SLOW_BROWSER_TIMER_MS) return;
  // This is latency telemetry, not a transport or consensus fault. Keep it
  // visible without turning ordinary host scheduling jitter into a browser
  // health incident; actual P2P failures use the fail-loud paths below.
  p2pLog.info('perf.slow_timer', {
    label,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    ...(extra ? { extra } : {}),
  });
};

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

const p2pNotDeliveredResult = (transport: EntityInputDeliveryTransport, message: string): EntityInputDeliveryResult =>
  p2pDeliveryResult(
    deliveryFailure({
      category: 'TransientRace',
      code: 'P2P_ENTITY_INPUT_NOT_DELIVERED',
      message,
      terminal: false,
    }),
    transport,
  );

const p2pSendThrowResult = (transport: EntityInputDeliveryTransport, message: string): EntityInputDeliveryResult => {
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

const p2pShouldRefreshGossip = (delivery: DeliveryResult): boolean => delivery.code === 'P2P_NO_PUBKEY';

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
// A busy entity re-certifies its routing profile (live capacities) on every
// commit; each announcement costs every peer a full Hanko verification. New
// entities still announce immediately (`announceProfilesForEntitiesNow`);
// refreshes of known profiles coalesce so a peer verifies at most one profile
// per entity per debounce window.
const PROFILE_ANNOUNCE_DEBOUNCE_MS = 1_000;
const HUB_PROFILE_HEARTBEAT_MS = 15_000;
// A user profile changes on every payment (capacities), yet nobody routes
// *through* a user: peers only need its topology (accounts, keys, runtime).
// Capacity-only refreshes therefore go out at most once per heartbeat; a
// topology change still announces at once (debounced like before).
const USER_PROFILE_HEARTBEAT_MS = 3_600_000;
const GOSSIP_FETCH_RETRY_DELAYS_MS = [40, 80, 160];
const GOSSIP_ROUTE_FETCH_RETRY_DELAYS_MS = [60, 120, 240];

/** Everything a peer needs from a non-hub profile except live capacities. */
const profileTopologyKey = (profile: Profile): string => safeStringify([
  profile.entityId,
  profile.entityEncryptionPublicKey,
  profile.name,
  profile.runtimeId,
  profile.runtimeEncPubKey,
  profile.wsUrl,
  profile.relays,
  profile.publicAccounts,
  profile.accounts.map(account => [
    account.counterpartyId,
    account.domain,
    Object.keys(account.tokenCapacities instanceof Map
      ? Object.fromEntries(account.tokenCapacities)
      : account.tokenCapacities).sort(compareStableText),
  ]),
  { ...profile.metadata, profileHanko: undefined },
]);
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
  private env: RuntimeReplica;
  private runtimeId: string;
  private signerId: string;
  private relayUrls: string[];
  private wsUrl: string | null;
  private seedRuntimeIds: string[];
  private advertiseEntityIds: string[] | null;
  private gossipPollMs: number;
  private gossipSet: P2PGossipSet;
  private profileHeartbeatMs: number;
  private lastAnnouncedProfiles = new Map<string, { topologyKey: string; at: number }>();
  /** Relay receipt cursor per relay runtime id (exact incremental polling). */
  private gossipCursors = new Map<string, number>();
  private onEntityInputs: (
    from: string,
    envelope: RuntimeEntityInputsEnvelope,
    timestamp?: number,
    options?: InboundEntityInputsOptions,
  ) => void;
  private onGossipProfiles: (from: string, profiles: Profile[]) => void;
  private onGossipJurisdictions: (from: string, announcements: JurisdictionGossipAnnouncement[]) => void;
  private officialFoundationSignerId: string | undefined;
  private clients: RuntimeWsClient[] = [];
  private directClients = new Map<string, RuntimeWsClient>();
  /**
   * Last signed route per local entity, keyed by everything the route
   * signature commits except `lastUpdated`. Answering every gossip poll with a
   * freshly timestamped signature made each answer a "newer" profile that every
   * peer had to re-verify (Hanko + route ECDSA); unchanged content re-serves
   * the same signed profile and peers skip it on the timestamp compare.
   */
  private signedLocalProfiles = new Map<string, { key: string; profile: Profile }>();
  private directClientUrls = new Map<string, string>();
  private directClientErrors = new Map<string, { at: number; error: string }>();
  private retiringClients = new Map<RuntimeWsClient, { kind: 'relay' | 'direct'; key: string }>();
  private verifiedProfileRoutes: Map<
    string,
    {
      runtimeId: string;
      runtimeSignerId: string;
      runtimeEncPubKey: string;
      lastUpdated: number;
    }
  >;
  private bootstrapPollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private encryptionKeyPair: P2PKeyPair;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAnnounceEntities = new Set<string>();
  private profileFetches = new Map<string, Promise<boolean>>();
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
    this.seedRuntimeIds = uniqueTransportValues(options.seedRuntimeIds || []);
    this.advertiseEntityIds = options.advertiseEntityIds || null;
    this.gossipPollMs = normalizeGossipPollMs(options.gossipPollMs);
    this.gossipSet = options.gossipSet ?? 'hubs';
    this.profileHeartbeatMs = normalizeProfileHeartbeatMs(options.profileHeartbeatMs, this.gossipSet);
    this.onEntityInputs = options.onEntityInputs;
    this.onGossipProfiles = options.onGossipProfiles;
    this.onGossipJurisdictions = options.onGossipJurisdictions ?? (() => {});
    this.officialFoundationSignerId = options.officialFoundationSignerId;
    if (!this.env.infrastructure) this.env.infrastructure = {};
    this.verifiedProfileRoutes = this.env.infrastructure.verifiedProfileRoutes ?? new Map();
    this.env.infrastructure.verifiedProfileRoutes = this.verifiedProfileRoutes;
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
    if (config.gossipSet !== undefined) {
      this.gossipSet = config.gossipSet;
      this.profileHeartbeatMs = normalizeProfileHeartbeatMs(config.profileHeartbeatMs, this.gossipSet);
    } else if (config.profileHeartbeatMs !== undefined) {
      this.profileHeartbeatMs = normalizeProfileHeartbeatMs(config.profileHeartbeatMs, this.gossipSet);
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
        helloAudience: canonicalizeRuntimeWsAudience(url),
        signerId: this.signerId,
        ...(runtimeSeed ? { seed: runtimeSeed } : {}),
        encryptionKeyPair: this.encryptionKeyPair,
        onPeerEncryptionKey: (fromRuntimeId: string, pubKeyHex: string) => {
          this.handlePeerEncryptionKey(fromRuntimeId, pubKeyHex);
        },
        getTargetEncryptionKey: (targetRuntimeId: string) => {
          return this.resolveTargetEncryptionKey(targetRuntimeId);
        },
        onOpen: () => {
          if (this.closing || this.closed || !this.clients.includes(client)) return;
          this.requestSeedGossip('full');
          this.announceLocalProfiles();
        },
        onEntityInputs: async (from, envelope, timestamp) => {
          if (!this.clients.includes(client)) return;
          await this.acceptInboundEntityInputs('relay', from, envelope, timestamp);
        },
        onGossipRequest: (from, payload) => {
          if (!this.closing && !this.closed && this.clients.includes(client)) {
            this.handleGossipRequest(from, payload);
          }
        },
        onGossipResponse: (from, payload) => {
          if (!this.closing && !this.closed && this.clients.includes(client)) {
            this.handleGossipResponse(from, payload);
          }
        },
        onGossipAnnounce: (from, payload) => {
          if (!this.closing && !this.closed && this.clients.includes(client)) {
            this.handleGossipAnnounce(from, payload);
          }
        },
        onError: error => {
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
    tracked = attempt.catch(error => {
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
    if (now - this.lastHeartbeatAnnounceAt < this.profileHeartbeatMs) return;
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

  getQueueState(): {
    targetCount: number;
    totalMessages: number;
    oldestEntryAge: number;
    perTarget: Record<string, number>;
  } {
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
        ? Math.max(0, Number(this.env.state.timestamp ?? oldestTimestamp) - oldestTimestamp)
        : 0,
      perTarget,
    };
  }

  getVerifiedRuntimeRoute(entityId: string): { runtimeId: string; lastUpdated: number } | null {
    const route = this.verifiedProfileRoutes.get(String(entityId || '').toLowerCase());
    return route ? { runtimeId: route.runtimeId, lastUpdated: route.lastUpdated } : null;
  }

  private rememberVerifiedProfileRoute(profile: Profile, runtimeSignerId: string): void {
    const key = profile.entityId.toLowerCase();
    const existing = this.verifiedProfileRoutes.get(key);
    if (existing && existing.lastUpdated >= profile.lastUpdated) return;
    this.verifiedProfileRoutes.set(key, {
      runtimeId: normalizeRuntimeId(profile.runtimeId),
      runtimeSignerId,
      runtimeEncPubKey: profile.runtimeEncPubKey,
      lastUpdated: profile.lastUpdated,
    });
    if (!this.env.infrastructure) this.env.infrastructure = {};
    this.env.infrastructure.verifiedProfileRoutes = this.verifiedProfileRoutes;
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

  getDirectPeerState(): Array<{
    runtimeId: string;
    endpoint: string;
    open: boolean;
    lastError?: string;
    lastErrorAt?: number;
  }> {
    const rows: Array<{
      runtimeId: string;
      endpoint: string;
      open: boolean;
      lastError?: string;
      lastErrorAt?: number;
    }> = [];
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

  /** Snapshot unverified transport liveness for proposer-owned frame context. */
  observeOnlineEntityIds(entityIds: readonly string[]): ReadonlySet<string> {
    const online = new Set<string>();
    const relayOpen = this.clients.some(client => client.isOpen());
    for (const rawEntityId of entityIds) {
      const entityId = normalizeId(rawEntityId);
      const route = this.verifiedProfileRoutes.get(entityId);
      if (!route) continue;
      if (this.directClients.get(route.runtimeId)?.isOpen() || relayOpen) online.add(entityId);
    }
    return online;
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

  enqueueEntityInputsDelivery(
    targetRuntimeId: string,
    envelope: RuntimeEntityInputsEnvelope,
    ingressTimestamp?: number,
  ): EntityInputDeliveryResult {
    try {
      failfastAssert(
        typeof targetRuntimeId === 'string' && targetRuntimeId.length > 0,
        'P2P_TARGET_RUNTIME_INVALID',
        'targetRuntimeId is required',
      );
      failfastAssert(
        Array.isArray(envelope?.entityInputs),
        'P2P_ENTITY_INPUTS_INVALID',
        'entity_inputs envelope is malformed',
        { targetRuntimeId },
      );
      failfastAssert(
        envelope.entityInputs.length > 0,
        'P2P_ENTITY_INPUTS_INVALID',
        'entity_inputs envelope is empty',
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
      this.prefetchProfilesForInput(input);
    }

    const normalizedTargetRuntimeId = normalizeRuntimeId(targetRuntimeId);
    failfastAssert(!!normalizedTargetRuntimeId, 'P2P_TARGET_RUNTIME_INVALID', 'targetRuntimeId must be signer EOA', {
      targetRuntimeId,
    });
    const primary = this.resolveTransportClient(normalizedTargetRuntimeId);
    const attempts = this.resolveTransportAttempts(primary);
    let transport = primary.transport;
    let delivery: EntityInputDeliveryResult | null = null;
    for (const [attemptIndex, attempt] of attempts.entries()) {
      transport = attempt.transport;
      try {
        delivery = this.deliverEntityInputs(
          attempt.client,
          normalizedTargetRuntimeId,
          envelope,
          ingressTimestamp,
          transport,
        );
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
        if (transport === 'direct' && attemptIndex + 1 < attempts.length) {
          this.env.warn('network', 'P2P_DIRECT_PRE_SEND_FAILED', {
            targetRuntimeId: normalizedTargetRuntimeId,
            transport,
            delivery,
          });
          continue;
        }
        throw retryFailure('P2P_ENTITY_INPUTS_SEND_THROW',
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
    throw retryFailure('P2P_ENTITY_INPUTS_NOT_DELIVERED',
      `P2P_ENTITY_INPUTS_NOT_DELIVERED: runtime=${normalizedTargetRuntimeId} entities=${envelope.entityInputs.length} ` +
        `transport=${transport}`,
    );
  }

  requestGossip(runtimeId: string) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedRuntimeId) return;
    const client = this.getActiveClient();
    if (!client) return;
    client.sendGossipRequest(normalizedRuntimeId, {
      set: 'default',
      limit: DEFAULT_GOSSIP_BATCH_LIMIT,
      includeJurisdictions: true,
    } satisfies GossipProfileBatchRequest);
  }

  announceProfilesTo(
    runtimeId: string,
    profiles: Profile[],
  ) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedRuntimeId) return;
    const client = this.getActiveClient();
    if (!client) return;
    client.sendGossipAnnounce(normalizedRuntimeId, {
      profiles,
      jurisdictions: [],
    } satisfies GossipResponsePayload);
  }

  announceJurisdiction(announcement: JurisdictionGossipAnnouncement): boolean {
    this.env.gossip.announceJurisdiction(announcement, this.officialFoundationSignerId);
    const client = this.getActiveClient();
    if (!client) return false;
    return client.sendGossipAnnounce(this.runtimeId, {
      profiles: [],
      jurisdictions: [announcement],
    } satisfies GossipResponsePayload);
  }

  isConnected(): boolean {
    return !!this.getActiveClient();
  }

  getRelayClientCount(): number {
    return this.clients.length;
  }

  private hasRelayConnectionActivity(): boolean {
    return this.clients.some(
      client => client.isOpen() || client.isConnecting() || client.getReconnectState() !== null,
    );
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

  private resolveTransportAttempts(
    primary: { client: RuntimeWsClient | null; transport: 'direct' | 'relay' },
  ): Array<{
    client: RuntimeWsClient;
    transport: 'direct' | 'relay';
  }> {
    const attempts = primary.client?.isOpen()
      ? [primary as { client: RuntimeWsClient; transport: 'direct' | 'relay' }]
      : [];
    if (primary.transport === 'direct') {
      const relay = this.getActiveClient();
      if (relay?.isOpen()) attempts.push({ client: relay, transport: 'relay' });
    }
    return attempts;
  }

  private requestSeedGossip(mode: GossipRefreshMode = 'incremental') {
    const client = this.getActiveClient();
    if (!client) return;
    const relayId = normalizeRuntimeId(client.getPeerRuntimeId());
    const cursor = mode === 'incremental' && relayId ? this.gossipCursors.get(relayId) : undefined;
    const updatedSince = mode === 'incremental' && cursor === undefined ? this.getLatestKnownRemoteProfileTimestamp() : 0;
    const request: GossipProfileBatchRequest = {
      set: this.gossipSet,
      limit: DEFAULT_GOSSIP_BATCH_LIMIT,
      ...(cursor !== undefined ? { sinceSeq: cursor } : updatedSince > 0 ? { updatedSince } : {}),
    };
    client.sendGossipRequest(this.runtimeId, request);
  }

  /**
   * Pull the profile chains that route `source` → `target` from the relay
   * (nothing is pushed; a runtime asks for exactly what a payment needs).
   * Resolves true once the local graph yields at least one route.
   */
  async ensureRoutes(
    source: string,
    target: string,
    amount: bigint = 1n,
    tokenId: number = 1,
    maxRoutes: number = DEFAULT_GOSSIP_ROUTE_TO_ROUTES,
  ): Promise<boolean> {
    if (this.closing || this.closed) return false;
    const normalizedSource = normalizeId(source);
    const normalizedTarget = normalizeId(target);
    if (!normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) return false;
    const hasRoute = async (): Promise<boolean> => {
      const routes = await this.env.gossip.getNetworkGraph().findPaths(normalizedSource, normalizedTarget, amount, tokenId);
      return routes.length > 0;
    };
    if (await hasRoute()) return true;
    const key = `route:${normalizedSource}>${normalizedTarget}:${tokenId}`;
    const inFlight = this.profileFetches.get(key);
    if (inFlight) return inFlight;
    const fetch = (async () => {
      const routeTo: GossipRouteToRequest = {
        source: normalizedSource,
        target: normalizedTarget,
        tokenId,
        amount,
        maxRoutes: Math.min(MAX_GOSSIP_ROUTE_TO_ROUTES, Math.max(1, Math.floor(maxRoutes))),
      };
      for (const waitMs of GOSSIP_ROUTE_FETCH_RETRY_DELAYS_MS) {
        const client = this.getActiveClient();
        if (!client) return false;
        client.sendGossipRequest(this.runtimeId, { routeTo: encodeRouteToRequest(routeTo) });
        if (!(await this.waitForActiveDelay(waitMs))) return false;
        if (await hasRoute()) return true;
      }
      this.env.warn('network', 'GOSSIP_ROUTE_MISS', {
        source: normalizedSource,
        target: normalizedTarget,
        tokenId,
        retries: GOSSIP_ROUTE_FETCH_RETRY_DELAYS_MS.length,
      });
      return false;
    })();
    this.profileFetches.set(key, fetch);
    try {
      return await fetch;
    } finally {
      if (this.profileFetches.get(key) === fetch) this.profileFetches.delete(key);
    }
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
    const missingEntities = this.collectProfileEntityIdsForInput(input).filter(
      entityId => !this.hasProfileForEntity(entityId),
    );
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
    _transport: 'relay' | 'direct',
    from: string,
    envelope: RuntimeEntityInputsEnvelope,
    timestamp: number | undefined,
  ): Promise<void> {
    if (this.closing || this.closed) return;
    assertRuntimeEntityInputsEnvelopeSource(this.env, from, envelope);
    const requiredProfileIds = uniqueTransportValues(
      envelope.entityInputs.flatMap(input => this.collectProfileEntityIdsForInput(input)),
    ).filter(Boolean);
    if (requiredProfileIds.length > 0) {
      void this.ensureProfiles(requiredProfileIds).catch(error => {
        this.env.warn('network', 'P2P_FETCH_PROFILE_FAILED', { error: (error as Error).message });
      });
    }
    if (this.closing || this.closed) return;
    this.onEntityInputs(from, envelope, timestamp, {
      envelopeSourceVerified: true,
      entityInputsValidated: true,
    });
  }

  private prefetchProfilesForInput(input: RoutedEntityInput): void {
    const missingEntities = this.collectProfileEntityIdsForInput(input).filter(
      entityId => !this.hasProfileForEntity(entityId),
    );
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
    const key = [...requestedEntityIds].sort(compareStableText).join(',');
    const inFlight = this.profileFetches.get(key);
    if (inFlight) return inFlight;
    const fetch = this.ensureProfilesUncoalesced(requestedEntityIds);
    this.profileFetches.set(key, fetch);
    try {
      return await fetch;
    } finally {
      if (this.profileFetches.get(key) === fetch) this.profileFetches.delete(key);
    }
  }

  private async ensureProfilesUncoalesced(requestedEntityIds: string[]): Promise<boolean> {
    let requiredEntityIds = this.expandRequiredProfileIds(requestedEntityIds);
    let missingEntityIds = requiredEntityIds.filter(entityId => !this.hasProfileForEntity(entityId));

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
    return profiles.find(profile => normalizeId(profile.entityId) === targetEntityId) || null;
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
    return new Promise(resolve => {
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
      if (!(await this.waitForActiveDelay(waitMs))) return false;
      const profiles = this.env.gossip?.getProfiles?.() || [];
      const hasAllMissing =
        missingEntityIds.length > 0 && missingEntityIds.every(entityId => this.hasProfileForEntity(entityId));
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
    const profiles = await this.getLocalProfilesForEntities();
    if (this.closing || this.closed) return;
    const jurisdictions = this.env.gossip.getJurisdictions();
    if (profiles.length === 0 && jurisdictions.length === 0) return;
    for (const profile of profiles) {
      this.env.gossip?.announce?.(profile);
      this.rememberAnnouncedProfile(profile);
    }

    // ALWAYS announce to relay for storage (relay stores regardless of 'to' field)
    const client = this.getActiveClient();
    if (client) {
      client.sendGossipAnnounce(this.runtimeId, {
        profiles,
        jurisdictions,
      } satisfies GossipResponsePayload);
    }

    // Also send to specific seeds if configured (for direct peer notification)
    for (const seedId of this.seedRuntimeIds) {
      this.announceProfilesTo(seedId, profiles);
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

  private rememberAnnouncedProfile(profile: Profile): void {
    this.lastAnnouncedProfiles.set(normalizeId(profile.entityId), {
      topologyKey: profileTopologyKey(profile),
      at: Date.now(),
    });
  }

  /**
   * Hubs re-announce whenever their certified profile changes (debounced by
   * the caller). Non-hub profiles only leave the runtime when their topology
   * changed or the heartbeat elapsed; capacity-only churn stays local.
   */
  private shouldAnnounceProfile(profile: Profile): boolean {
    if (profile.metadata.isHub === true) return true;
    const previous = this.lastAnnouncedProfiles.get(normalizeId(profile.entityId));
    if (!previous) return true;
    if (previous.topologyKey !== profileTopologyKey(profile)) return true;
    return Date.now() - previous.at >= this.profileHeartbeatMs;
  }

  private async announceProfilesNow(entityIds: string[], reason: string) {
    if (this.closing || this.closed) return;
    const builtProfiles = await this.getLocalProfilesForEntities(entityIds);
    if (this.closing || this.closed) return;
    // The freshest certified profile always lands in the local cache (local
    // routing/UI see live capacities); only the network announce is gated.
    for (const profile of builtProfiles) this.env.gossip?.announce?.(profile);
    const profiles = builtProfiles.filter(profile => this.shouldAnnounceProfile(profile));
    if (profiles.length === 0) return;
    for (const profile of profiles) this.rememberAnnouncedProfile(profile);
    const client = this.getActiveClient();
    if (client) {
      client.sendGossipAnnounce(this.runtimeId, {
        profiles,
        jurisdictions: [],
      } satisfies GossipResponsePayload);
    }
    for (const seedId of this.seedRuntimeIds) {
      this.announceProfilesTo(seedId, profiles);
    }
    p2pLog.debug('profile.announce', {
      reason,
      count: profiles.length,
      entities: profiles.map(profile => shortId(profile.entityId)),
    });
  }

  private async getLocalProfilesForEntities(entityIds?: string[]): Promise<Profile[]> {
    if (!this.env.state.eReplicas || this.env.state.eReplicas.size === 0) return [];
    const targetSet = entityIds && entityIds.length > 0 ? new Set(entityIds.map(normalizeId)) : null;
    const advertisedSet =
      this.advertiseEntityIds && this.advertiseEntityIds.length > 0
        ? new Set(this.advertiseEntityIds.map(normalizeId))
        : null;
    const profiles: Profile[] = [];
    const seen = new Set<string>();
    for (const [replicaKey, replica] of this.env.state.eReplicas.entries()) {
      const entityId = extractEntityId(replicaKey);
      const replicaSignerId = getReplicaSignerId(replicaKey);
      // Only advertise entities we can actually sign for.
      // This excludes imported/foreign replicas in browser runtimes while still
      // allowing server runtimes (runtimeId may differ from signer addresses).
      if (!replicaSignerId) {
        continue;
      }
      if (!(await hasCurrentBoardProfileRouteAuthority(this.env, replica, replicaSignerId))) continue;
      const normalizedEntityId = normalizeId(entityId);
      if (seen.has(normalizedEntityId)) continue;
      if (advertisedSet && !advertisedSet.has(normalizedEntityId)) continue;
      if (targetSet && !targetSet.has(normalizedEntityId)) continue;
      seen.add(normalizedEntityId);

      // MONOTONIC TIMESTAMP: Ensure timestamp grows even if env.timestamp doesn't change
      // Get last announced timestamp for this entity from gossip
      const existingProfile = this.env.gossip?.getProfiles?.().find(profile => profile.entityId === entityId);
      const lastTimestamp = existingProfile?.lastUpdated || 0;
      const monotonicTimestamp = Math.max(lastTimestamp + 1, this.env.state.timestamp);
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
      const routeKey = safeStringify([
        profileHash,
        certification.hanko,
        replicaSignerId,
        profile.runtimeId,
        profile.runtimeEncPubKey,
        profile.wsUrl,
        profile.relays,
        profile.metadata.mirrors ?? [],
      ]);
      const cached = this.signedLocalProfiles.get(normalizedEntityId);
      if (cached && cached.key === routeKey && cached.profile.lastUpdated <= monotonicTimestamp) {
        profiles.push(cached.profile);
        continue;
      }
      const signedProfile = await signProfileRuntimeRoute(this.env as RuntimeReplica, profile, replicaSignerId);
      this.signedLocalProfiles.set(normalizedEntityId, { key: routeKey, profile: signedProfile });
      profiles.push(signedProfile);
    }
    return profiles;
  }

  private handleGossipRequest(from: string, payload: unknown) {
    if (!this.env.gossip?.getProfiles) return;
    const request = decodeGossipProfileBatchRequest(payload);
    const profiles = this.getLocalProfileBatch(request);

    const client = this.getActiveClient();
    if (!client) return;
    const jurisdictions = request.includeJurisdictions
      ? this.env.gossip.getJurisdictions()
      : [];
    client.sendGossipResponse(from, { profiles, jurisdictions } satisfies GossipResponsePayload);
  }

  private getLocalProfileBatch(request: GossipProfileBatchRequest = {}): Profile[] {
    const allProfiles = this.env.gossip?.getProfiles?.() || [];
    return selectProfileBatch(allProfiles, request, DEFAULT_GOSSIP_BATCH_LIMIT);
  }

  private handleGossipResponse(from: string, payload: unknown) {
    const decoded = decodeGossipPayload(payload);
    if (decoded.cursor !== undefined) {
      const relayId = normalizeRuntimeId(from);
      if (relayId) this.gossipCursors.set(relayId, decoded.cursor);
    }
    this.applyIncomingJurisdictions(from, decoded.jurisdictions);
    this.applyIncomingProfiles(from, decoded.profiles).catch(err => {
      this.env.warn('network', 'P2P_APPLY_PROFILES_ERROR', { error: err.message });
    });
  }

  private handleGossipAnnounce(from: string, payload: unknown) {
    const decoded = decodeGossipPayload(payload);
    this.applyIncomingJurisdictions(from, decoded.jurisdictions);
    this.applyIncomingProfiles(from, decoded.profiles).catch(err => {
      this.env.warn('network', 'P2P_APPLY_PROFILES_ERROR', { error: err.message });
    });
  }

  private applyIncomingJurisdictions(from: string, values: readonly unknown[]): void {
    const accepted: JurisdictionGossipAnnouncement[] = [];
    for (const value of values) {
      try {
        const announcement = decodeJurisdictionGossipAnnouncement(value, this.officialFoundationSignerId);
        if (this.env.gossip.announceJurisdiction(announcement, this.officialFoundationSignerId)) {
          accepted.push(announcement);
        }
      } catch (error) {
        p2pLog.warn('jurisdiction.dropped_invalid', {
          from: shortId(from),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (accepted.length > 0) this.onGossipJurisdictions(from, accepted);
  }

  private async applyIncomingProfiles(from: string, profiles: readonly unknown[]) {
    if (this.closing || this.closed) return;
    if (profiles.length === 0) return;
    let accepted = 0;
    const acceptedProfiles: Profile[] = [];
    for (const profile of profiles) {
      const { profile: sanitized, error: malformedReason } = sanitizeIncomingProfile(profile);
      if (!sanitized) {
        const entityId =
          typeof profile === 'object' && profile !== null && 'entityId' in profile
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
      const existing = existingProfiles.find(existingProfile => existingProfile.entityId === sanitized.entityId);
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
      const result = await verifyProfileSignature(sanitized, this.env);
      {
        if (this.closing || this.closed) return;
        if (!result.valid) {
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
            entityPublicKey: `${sanitized.entityEncryptionPublicKey.slice(0, 20)}..`,
            recoveredAddresses: hankoInspect?.recoveredAddresses ?? [],
            reconstructedBoardHash: hankoInspect?.reconstructedBoardHash,
            runtimeId: sanitized.runtimeId,
            name: sanitized.name,
          });
          continue;
        }
      }

      if (this.closing || this.closed) return;
      this.rememberVerifiedProfileRoute(sanitized, result.signerId!);
      this.env.gossip?.announce?.(sanitized);
      accepted++;
      acceptedProfiles.push(sanitized);
    }
    if (this.closing || this.closed) return;
    this.onGossipProfiles(from, acceptedProfiles);
  }

  private closeClients() {
    const active = this.clients;
    this.clients = [];
    active.forEach((client, index) => this.retireClient(client, 'relay', String(index)));
  }

  private closeDirectClients() {
    for (const [runtimeId, client] of this.directClients.entries()) {
      this.retireClient(client, 'direct', runtimeId);
    }
    this.directClients.clear();
    this.directClientUrls.clear();
    this.directClientErrors.clear();
  }

  private retireClient(
    client: RuntimeWsClient,
    kind: 'relay' | 'direct',
    key: string,
  ): void {
    if (this.retiringClients.has(client)) return;
    this.retiringClients.set(client, { kind, key });
    client.close();
  }

  private retireDirectClient(runtimeId: string, client: RuntimeWsClient): void {
    if (this.directClients.get(runtimeId) === client) this.directClients.delete(runtimeId);
    this.directClientUrls.delete(runtimeId);
    this.directClientErrors.delete(runtimeId);
    this.retireClient(client, 'direct', runtimeId);
  }

  private async drainAllClients(timeoutMs: number): Promise<void> {
    this.closeClients();
    this.closeDirectClients();
    const entries = [...this.retiringClients.entries()].map(([client, identity]) => ({
      ...identity,
      client,
    }));
    const results = await Promise.allSettled(entries.map(({ client }) => client.closeAndWait(timeoutMs)));
    const errors: Error[] = [];
    results.forEach((result, index) => {
      const entry = entries[index]!;
      if (result.status === 'rejected') {
        const cause = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        errors.push(
          new Error(`P2P_${entry.kind.toUpperCase()}_CLOSE_FAILED:${entry.key || index}:${cause.message}`, { cause }),
        );
        return;
      }
      this.retiringClients.delete(entry.client);
    });
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'P2P_CLOSE_FAILED');
  }

  private getDirectPeerEndpoint(runtimeId: string): string | null {
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
    const existing = this.directClients.get(normalizedTargetRuntimeId);
    const existingUrl = this.directClientUrls.get(normalizedTargetRuntimeId);
    const endpoint = this.getDirectPeerEndpoint(normalizedTargetRuntimeId);
    if (!endpoint) {
      if (existing) this.retireDirectClient(normalizedTargetRuntimeId, existing);
      return;
    }
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
      this.retireDirectClient(normalizedTargetRuntimeId, existing);
    }
    const client = new RuntimeWsClient({
      url: endpoint,
      runtimeId: this.runtimeId,
      helloAudience: directRuntimeWsAudience(normalizedTargetRuntimeId),
      signerId: this.signerId,
      ...(this.env.runtimeSeed ? { seed: this.env.runtimeSeed } : {}),
      encryptionKeyPair: this.encryptionKeyPair,
      getTargetEncryptionKey: (targetRuntimeId: string) => {
        return this.resolveTargetEncryptionKey(targetRuntimeId);
      },
      onPeerEncryptionKey: (fromRuntimeId: string, pubKeyHex: string) => {
        this.handlePeerEncryptionKey(fromRuntimeId, pubKeyHex);
      },
      onOpen: () => {
        if (
          this.closing || this.closed ||
          this.directClients.get(normalizedTargetRuntimeId) !== client
        ) return;
        this.directClientErrors.delete(normalizedTargetRuntimeId);
      },
      onEntityInputs: async (from, envelope, timestamp) => {
        if (this.directClients.get(normalizedTargetRuntimeId) !== client) return;
        await this.acceptInboundEntityInputs('direct', from, envelope, timestamp);
      },
      onError: error => {
        if (
          this.closing || this.closed ||
          this.directClients.get(normalizedTargetRuntimeId) !== client
        ) return;
        if (
          reportDirectClientError(this.env, endpoint, normalizedTargetRuntimeId, error) === 'retryable-backpressure'
        ) {
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

}
