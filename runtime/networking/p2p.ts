/**
 * XLN P2P Overlay Network
 *
 * ARCHITECTURE: Transport layer for entity communication via relay servers.
 *
 * SECURITY MODEL - P2P is a "dumb pipe":
 * - NO replay protection here - accountFrame heights handle that in consensus layer
 * - Profile signatures prevent spoofing (board validator public keys bind the entity)
 * - Queue limits prevent memory exhaustion from disconnected peers
 * - Actual transaction validation happens at entity/account consensus layer
 *
 * Why no nonces/replay protection at P2P level?
 * - Each accountFrame has monotonic height (can't replay frame 5 after frame 6)
 * - Entity transactions require validator signatures (can't forge)
 * - Even replayed messages are rejected by consensus height checks
 * - Adding P2P nonces would be redundant complexity
 *
 * Profile anti-spoofing (uses same Hanko mechanism as accountFrames):
 * - Profile hash signed using same path as accountFrame/disputeHash/settlement
 * - Verification uses verifyHankoForHash() - same security as all entity operations
 * - Key binding: signer must be in entity's board.validators[]
 * - Invalid or unsigned profiles are rejected
 */

import type { Env, RoutedEntityInput } from '../types';
import { canonicalizeProfile, getBoardPrimaryPublicKey, parseProfile, type Profile } from './gossip';
import { RuntimeWsClient } from './ws-client';
import { buildLocalEntityProfile } from './gossip-helper';
import { extractEntityId } from '../ids';
import { getSignerPrivateKey, registerSignerPublicKey } from '../account-crypto';
import { signProfile, verifyProfileSignature } from './profile-signing';
import { inspectHankoForHash } from '../hanko/signing';
import { deriveEncryptionKeyPair, pubKeyToHex, hexToPubKey, type P2PKeyPair } from './p2p-crypto';
import { asFailFastPayload, failfastAssert } from './failfast';
import { normalizeRuntimeId, isRuntimeId } from './runtime-id';
import {
  DEFAULT_GOSSIP_BATCH_LIMIT,
  selectProfileBatch,
  type GossipProfileBatchRequest,
} from '../relay/profile-batch';

const DEFAULT_RELAY_URL = 'wss://xln.finance/relay';
const MAX_QUEUE_PER_RUNTIME = 100; // Prevent memory exhaustion (DoS protection)
const MIN_GOSSIP_POLL_MS = 1000;

export type P2PConfig = {
  relayUrls?: string[];
  wsUrl?: string | null;
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
  seedRuntimeIds?: string[];
  advertiseEntityIds?: string[];
  isHub?: boolean;
  gossipPollMs?: number;
  onEntityInput: (from: string, input: RoutedEntityInput, timestamp?: number) => void;
  onGossipProfiles: (from: string, profiles: Profile[]) => void;
};

type GossipResponsePayload = {
  profiles: Profile[];
};

type GossipRefreshMode = 'incremental' | 'full';

const normalizeGossipPollMs = (value: number | undefined): number => {
  if (!Number.isFinite(Number(value))) return GOSSIP_POLL_MS;
  return Math.max(MIN_GOSSIP_POLL_MS, Math.floor(Number(value)));
};

const normalizeLoopbackHost = (host: string): string => {
  const normalized = String(host || '').trim().toLowerCase();
  if (normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1') {
    return 'localhost';
  }
  return normalized;
};

const parseWsUrl = (value: string): URL | null => {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    return parsed;
  } catch {
    return null;
  }
};

const getWsUrlKey = (value: string, ignoreProtocol = false): string | null => {
  const parsed = parseWsUrl(value);
  if (!parsed) return null;
  const host = normalizeLoopbackHost(parsed.hostname);
  const port = parsed.port || (parsed.protocol === 'wss:' ? '443' : '80');
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${ignoreProtocol ? 'ws*' : parsed.protocol}//${host}:${port}${pathname}`;
};

const unique = (items: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const trimmed = String(item || '').trim();
    if (!trimmed) continue;
    const key = getWsUrlKey(trimmed) || trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
};

const normalizeOptionalWsUrl = (value: string | null | undefined): string | null => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const parsed = parseWsUrl(trimmed);
  return parsed ? trimmed : null;
};

const sameWsUrl = (left: string | null, right: string | null): boolean => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return getWsUrlKey(left) === getWsUrlKey(right);
};

const isSameList = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const aSorted = [...a].map(value => getWsUrlKey(value) || value).sort();
  const bSorted = [...b].map(value => getWsUrlKey(value) || value).sort();
  return aSorted.every((value, index) => value === bSorted[index]);
};

const isHexPublicKey = (value: string): boolean => {
  if (!value.startsWith('0x')) return false;
  const hex = value.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
  return hex.length === 66 || hex.length === 130;
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

const normalizeId = (value: string): string => value.toLowerCase();
const getReplicaSignerId = (replicaKey: string): string => {
  const idx = replicaKey.lastIndexOf(':');
  return idx === -1 ? '' : replicaKey.slice(idx + 1);
};

const GOSSIP_POLL_MS = 1000; // Keep every runtime synced to relay at least once per second
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
  private seedRuntimeIds: string[];
  private advertiseEntityIds: string[] | null;
  private gossipPollMs: number;
  private onEntityInput: (from: string, input: RoutedEntityInput, timestamp?: number) => void;
  private onGossipProfiles: (from: string, profiles: Profile[]) => void;
  private clients: RuntimeWsClient[] = [];
  private directClients = new Map<string, RuntimeWsClient>();
  private directClientUrls = new Map<string, string>();
  private pendingByRuntime = new Map<string, { input: RoutedEntityInput, enqueuedAt: number, ingressTimestamp?: number }[]>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private retryInterval: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private encryptionKeyPair: P2PKeyPair;
  private peerRuntimeEncPubKeys = new Map<string, string>();
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAnnounceEntities = new Set<string>();
  private lastHeartbeatAnnounceAt = 0;

  constructor(options: RuntimeP2POptions) {
    this.env = options.env;
    failfastAssert(isRuntimeId(options.runtimeId), 'P2P_RUNTIME_ID_INVALID', 'RuntimeP2P runtimeId must be signer EOA');
    this.runtimeId = normalizeRuntimeId(options.runtimeId);
    this.signerId = options.signerId || '1';
    this.relayUrls = unique(options.relayUrls || [DEFAULT_RELAY_URL]);
    this.wsUrl = normalizeOptionalWsUrl(options.wsUrl);
    this.seedRuntimeIds = unique(options.seedRuntimeIds || []);
    this.advertiseEntityIds = options.advertiseEntityIds || null;
    this.gossipPollMs = normalizeGossipPollMs(options.gossipPollMs);
    this.onEntityInput = options.onEntityInput;
    this.onGossipProfiles = options.onGossipProfiles;
    // Derive X25519 encryption keypair from seed (mandatory, no fallback)
    const seed = this.env.runtimeSeed;
    if (!seed) {
      throw new Error('P2P_INIT_ERROR: runtimeSeed is required for encryption keypair');
    }
    this.encryptionKeyPair = deriveEncryptionKeyPair(seed);
  }

  /** Get encryption public key as hex for profile sharing */
  getEncryptionPublicKeyHex(): string {
    return pubKeyToHex(this.encryptionKeyPair.publicKey);
  }

  matchesIdentity(runtimeId: string, signerId?: string): boolean {
    return this.runtimeId === runtimeId && (!signerId || this.signerId === signerId);
  }

  updateConfig(config: P2PConfig) {
    if (config.seedRuntimeIds) {
      this.seedRuntimeIds = unique(config.seedRuntimeIds);
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
      const nextUrls = unique(config.relayUrls);
      if (!isSameList(nextUrls, this.relayUrls)) {
        this.relayUrls = nextUrls;
        this.reconnect();
        return;
      }
    }
    this.announceLocalProfiles();
  }

  connect() {
    console.log(`[P2P] RuntimeP2P.connect() called, connecting to ${this.relayUrls.length} relays: ${this.relayUrls.join(', ')}`);
    this.closeClients();
    this.registerVisibilityReconnect();
    this.startPolling();
    this.startRetryLoop();
    for (const url of this.relayUrls) {
      const runtimeSeed = this.env.runtimeSeed;
      const isBrowserRuntime = typeof window !== 'undefined';
      const client = new RuntimeWsClient({
        url,
        runtimeId: this.runtimeId,
        signerId: this.signerId,
        ...(runtimeSeed ? { seed: runtimeSeed } : {}),  // Pass seed for hello auth signing if available
        encryptionKeyPair: this.encryptionKeyPair, // Pass our keypair for encryption/decryption
        onPeerEncryptionKey: (fromRuntimeId: string, pubKeyHex: string) => {
          const normalizedRuntimeId = normalizeRuntimeId(fromRuntimeId);
          const normalizedKey = typeof pubKeyHex === 'string'
            ? (pubKeyHex.startsWith('0x') ? pubKeyHex.toLowerCase() : `0x${pubKeyHex.toLowerCase()}`)
            : '';
          if (!normalizedRuntimeId) return;
          if (!/^0x[0-9a-f]{64}$/.test(normalizedKey)) return;
          this.peerRuntimeEncPubKeys.set(normalizedRuntimeId, normalizedKey);
        },
        getTargetEncryptionKey: (targetRuntimeId: string) => {
          return this.resolveTargetEncryptionKey(targetRuntimeId);
        },
        onOpen: () => {
          this.flushPending();
          // ALWAYS request gossip on connect (even if periodic polling is disabled)
          this.requestSeedGossip('full');
          this.announceLocalProfiles();
          this.syncDirectPeerConnections();
        },
        onEntityInput: async (from, input, timestamp) => {
          this.prefetchProfilesForInput(input);
          this.onEntityInput(from, input, timestamp);
        },
        onGossipRequest: (from, payload) => this.handleGossipRequest(from, payload),
        onGossipResponse: (from, payload) => this.handleGossipResponse(from, payload),
        onGossipAnnounce: (from, payload) => this.handleGossipAnnounce(from, payload),
        onError: (error) => {
          this.env.warn('network', 'WS_CLIENT_ERROR', { relay: url, error: error.message });
        },
        // Browser UX: stop after bounded attempts.
        // Server/hub runtime: keep reconnecting to avoid dead relay state after transient boot races.
        maxReconnectAttempts: 0,
      });
      this.clients.push(client);
      client.connect().catch(error => {
        this.env.warn('network', 'WS_CONNECT_FAILED', { relay: url, error: error.message });
      });
    }
  }

  close() {
    this.stopPolling();
    this.stopRetryLoop();
    this.unregisterVisibilityReconnect();
    this.peerRuntimeEncPubKeys.clear();
    if (this.announceTimer) {
      clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }
    this.pendingAnnounceEntities.clear();
    this.closeClients();
    this.closeDirectClients();
    this.pendingByRuntime.clear();
  }

  private startPolling() {
    if (this.pollInterval) {
      // Already polling
      return;
    }
    console.log(`[P2P] startPolling: Starting polling every ${this.gossipPollMs}ms`);
    // Request immediately, then periodically
    setTimeout(() => {
      this.requestSeedGossip('incremental');
      void this.maybeHeartbeatAnnounce();
    }, 100);
    this.pollInterval = setInterval(() => {
      this.requestSeedGossip('incremental');
      void this.maybeHeartbeatAnnounce();
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
        console.log('[P2P] Tab is in standby; suppressing visibility-triggered reconnect');
        return;
      }
      const activeClient = !!this.getActiveClient();
      console.log(
        `[P2P] visibilitychange state=${document.visibilityState} activeClient=${activeClient ? 1 : 0} ` +
          `pendingTargets=${this.pendingByRuntime.size}`,
      );
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (!activeClient) {
        console.warn('[P2P] Tab resumed with no active WS client — forcing reconnect');
        this.reconnect();
        return;
      }
      this.requestSeedGossip('incremental');
      this.flushPending();
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

  private startRetryLoop() {
    if (this.retryInterval) return;
    this.retryInterval = setInterval(() => {
      if (this.pendingByRuntime.size > 0) {
        this.flushPending();
      }
    }, 10_000);
  }

  private stopRetryLoop() {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
  }

  getQueueState(): { targetCount: number; totalMessages: number; oldestEntryAge: number; perTarget: Record<string, number> } {
    let totalMessages = 0;
    let oldestAt = Infinity;
    const perTarget: Record<string, number> = {};
    for (const [targetId, queue] of this.pendingByRuntime.entries()) {
      totalMessages += queue.length;
      if (queue.length > 0) perTarget[targetId] = queue.length;
      for (const entry of queue) {
        if (entry.enqueuedAt < oldestAt) oldestAt = entry.enqueuedAt;
      }
    }
    return {
      targetCount: this.pendingByRuntime.size,
      totalMessages,
      oldestEntryAge: totalMessages > 0 ? Date.now() - oldestAt : 0,
      perTarget,
    };
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
    console.log(`[P2P] reconnect() called — closing existing clients and reconnecting`);
    this.closeClients();
    this.connect();
  }

  getDirectPeerState(): Array<{ runtimeId: string; endpoint: string; open: boolean }> {
    const rows: Array<{ runtimeId: string; endpoint: string; open: boolean }> = [];
    for (const [runtimeId, client] of this.directClients.entries()) {
      rows.push({
        runtimeId,
        endpoint: this.directClientUrls.get(runtimeId) || client.getUrl(),
        open: client.isOpen(),
      });
    }
    return rows.sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
  }

  enqueueEntityInput(targetRuntimeId: string, input: RoutedEntityInput, ingressTimestamp?: number) {
    try {
      failfastAssert(typeof targetRuntimeId === 'string' && targetRuntimeId.length > 0, 'P2P_TARGET_RUNTIME_INVALID', 'targetRuntimeId is required');
      failfastAssert(typeof input?.entityId === 'string' && input.entityId.length > 0, 'P2P_ENTITY_INPUT_INVALID', 'entity_input missing entityId', { targetRuntimeId });
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

    this.ensureRelayConnectionsForEntity(input.entityId);

    const normalizedTargetRuntimeId = normalizeRuntimeId(targetRuntimeId);
    failfastAssert(
      !!normalizedTargetRuntimeId,
      'P2P_TARGET_RUNTIME_INVALID',
      'targetRuntimeId must be signer EOA',
      { targetRuntimeId },
    );
    const { client, transport } = this.resolveTransportClient(normalizedTargetRuntimeId);
    if (client && client.isOpen()) {
      try {
        const sent = client.sendEntityInput(normalizedTargetRuntimeId, input, ingressTimestamp);
        console.log(
          `[P2P] enqueueEntityInput attempt target=${normalizedTargetRuntimeId} entity=${input.entityId.slice(-4)} ` +
            `transport=${transport} sent=${sent ? 1 : 0} open=${client.isOpen() ? 1 : 0}`,
        );
        if (sent) return;
        console.warn(`P2P-SEND-FAILED: Client.send returned false for ${normalizedTargetRuntimeId}`);
      } catch (error) {
        const message = (error as Error).message || String(error);
        if (message.includes('P2P_NO_PUBKEY')) {
          this.sendDebugEvent({
            level: 'warn',
            code: 'P2P_NO_PUBKEY_QUEUE',
            message,
            targetRuntimeId: normalizedTargetRuntimeId,
            entityId: input.entityId,
          });
          this.refreshGossip();
        } else {
          this.sendDebugEvent({
            level: 'error',
            code: 'P2P_SEND_THROW',
            message,
            targetRuntimeId: normalizedTargetRuntimeId,
            entityId: input.entityId,
          });
        }
      }
    } else {
      console.warn(
        `P2P-NO-CLIENT: No active ${transport} connection, queueing for ${normalizedTargetRuntimeId}`,
      );
    }

    const queue = this.pendingByRuntime.get(normalizedTargetRuntimeId) || [];
    queue.push({ input, enqueuedAt: Date.now(), ingressTimestamp });
    // Enforce queue size limit to prevent memory exhaustion
    while (queue.length > MAX_QUEUE_PER_RUNTIME) queue.shift();
    if (queue.length >= MAX_QUEUE_PER_RUNTIME) {
      this.sendDebugEvent({
        level: 'warn',
        code: 'P2P_QUEUE_PRESSURE',
        message: 'Pending queue at cap',
        targetRuntimeId: normalizedTargetRuntimeId,
        queueSize: queue.length,
      });
    }
    this.pendingByRuntime.set(normalizedTargetRuntimeId, queue);
    console.log(`P2P-QUEUED: ${normalizedTargetRuntimeId}, queue size: ${queue.length}`);
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

  announceProfilesTo(runtimeId: string, profiles: Profile[]) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedRuntimeId) return;
    const client = this.getActiveClient();
    if (!client) return;
    client.sendGossipAnnounce(normalizedRuntimeId, { profiles } satisfies GossipResponsePayload);
  }

  isConnected(): boolean {
    return !!this.getActiveClient();
  }

  sendDebugEvent(payload: unknown): boolean {
    const client = this.getActiveClient();
    if (!client) return false;
    return client.sendDebugEvent(payload);
  }

  private getActiveClient(): RuntimeWsClient | null {
    return this.clients.find(client => client.isOpen()) || null;
  }

  private getActiveDirectClient(runtimeId: string): RuntimeWsClient | null {
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
    const requireDirect = this.hasDirectPeerEndpoint(runtimeId);
    if (requireDirect) {
      this.ensureDirectClientForRuntime(runtimeId);
    }
    return {
      client: requireDirect ? this.getDirectClientForRuntime(runtimeId) : this.getActiveClient(),
      transport: requireDirect ? 'direct' : 'relay',
    };
  }

  private flushPending() {
    for (const [targetRuntimeId, queue] of this.pendingByRuntime.entries()) {
      const { client, transport } = this.resolveTransportClient(targetRuntimeId);
      if (!client || !client.isOpen()) continue;
      const remaining: { input: RoutedEntityInput, enqueuedAt: number, ingressTimestamp?: number }[] = [];
      for (const entry of queue) {
        try {
          const sent = client.sendEntityInput(targetRuntimeId, entry.input, entry.ingressTimestamp);
          console.log(
            `[P2P] flushPending target=${targetRuntimeId} entity=${entry.input.entityId.slice(-4)} ` +
              `transport=${transport} sent=${sent ? 1 : 0} open=${client.isOpen() ? 1 : 0}`,
          );
          if (!sent) remaining.push(entry);
        } catch {
          remaining.push(entry);
        }
      }
      if (remaining.length > 0) {
        this.pendingByRuntime.set(targetRuntimeId, remaining);
      } else {
        this.pendingByRuntime.delete(targetRuntimeId);
      }
    }
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

  private prefetchProfilesForInput(input: RoutedEntityInput): void {
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

    const missingEntities = Array.from(entitiesToCheck).filter(entityId => !this.hasProfileForEntity(entityId));
    if (missingEntities.length === 0) return;
    console.log(`P2P_FETCH_PROFILE: ${missingEntities.map(entityId => entityId.slice(-4)).join(',')} (not in cache)`);
    void this.ensureProfiles(missingEntities).catch(error => {
      console.warn(`P2P_FETCH_PROFILE_FAILED: ${(error as Error).message}`);
    });
  }

  // Call this to refresh profiles from relay
  refreshGossip() {
    this.requestSeedGossip('full');
    void this.maybeHeartbeatAnnounce();
  }

  async syncProfiles(): Promise<boolean> {
    return this.fetchProfilesWithRetry([]);
  }

  async ensureProfiles(entityIds: string[]): Promise<boolean> {
    const requestedEntityIds = unique(entityIds.map(normalizeId)).filter(Boolean);
    if (requestedEntityIds.length === 0) return true;
    const startedAt = Date.now();
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
    const hubCount = this.env.gossip?.getHubs?.().length || 0;
    console.log(
      `[P2P] ensureProfiles requested=${requestedEntityIds.length} required=${requiredEntityIds.length} ` +
        `missing=${missingEntityIds.length} hubs=${hubCount} resolved=${resolved ? 1 : 0} elapsed=${Date.now() - startedAt}ms`,
    );
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

  // Fetch profiles from relay with bounded retry for cold or stale caches.
  private async fetchProfilesWithRetry(missingEntityIds: string[] = []): Promise<boolean> {
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
      await new Promise(resolve => setTimeout(resolve, waitMs));
      const profiles = this.env.gossip?.getProfiles?.() || [];
      const hasAllMissing = missingEntityIds.length > 0 && missingEntityIds.every((entityId) => this.hasProfileForEntity(entityId));
      if (profiles.length > startCount || hasAllMissing) {
        console.log(
          `P2P_FETCH: profiles=${profiles.length} delta=${profiles.length - startCount} ` +
            `elapsed=${Date.now() - startedAt}ms`,
        );
        return missingEntityIds.length === 0 ? profiles.length > startCount : hasAllMissing;
      }
    }
    console.log(`P2P_FETCH: No new profiles after ${Date.now() - startedAt}ms (have ${startCount})`);
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
    const profiles = await this.getLocalProfilesForEntities();
    if (profiles.length === 0) return;
    for (const profile of profiles) {
      this.env.gossip?.announce?.(profile);
    }

    // ALWAYS announce to relay for storage (relay stores regardless of 'to' field)
    const client = this.getActiveClient();
    if (client) {
      client.sendGossipAnnounce(this.runtimeId, { profiles });
    }

    // Also send to specific seeds if configured (for direct peer notification)
    for (const seedId of this.seedRuntimeIds) {
      this.announceProfilesTo(seedId, profiles);
    }
  }

  announceProfilesForEntities(entityIds: string[], reason: string = 'runtime-change') {
    if (!entityIds || entityIds.length === 0) return;
    for (const entityId of entityIds) {
      if (!entityId) continue;
      this.pendingAnnounceEntities.add(normalizeId(entityId));
    }
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => {
      const targets = Array.from(this.pendingAnnounceEntities);
      this.pendingAnnounceEntities.clear();
      this.announceTimer = null;
      this.announceProfilesNow(targets, reason).catch(error => {
        console.warn(`P2P_ANNOUNCE_FAILED (${reason}): ${(error as Error).message}`);
      });
    }, PROFILE_ANNOUNCE_DEBOUNCE_MS);
  }

  private async announceProfilesNow(entityIds: string[], reason: string) {
    const profiles = await this.getLocalProfilesForEntities(entityIds);
    if (profiles.length === 0) return;
    for (const profile of profiles) {
      this.env.gossip?.announce?.(profile);
    }
    const client = this.getActiveClient();
    if (client) {
      client.sendGossipAnnounce(this.runtimeId, { profiles });
    }
    for (const seedId of this.seedRuntimeIds) {
      this.announceProfilesTo(seedId, profiles);
    }
    console.log(`P2P_PROFILE_ANNOUNCE: reason=${reason} count=${profiles.length}`);
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
      let entityId: string;
      try {
        entityId = extractEntityId(replicaKey);
      } catch {
        continue;
      }
      const replicaSignerId = getReplicaSignerId(replicaKey);
      // Only advertise entities we can actually sign for.
      // This excludes imported/foreign replicas in browser runtimes while still
      // allowing server runtimes (runtimeId may differ from signer addresses).
      if (!replicaSignerId) {
        continue;
      }
      try {
        getSignerPrivateKey(this.env, replicaSignerId);
      } catch {
        continue;
      }
      const normalizedEntityId = normalizeId(entityId);
      if (seen.has(normalizedEntityId)) continue;
      if (advertisedSet && !advertisedSet.has(normalizedEntityId)) continue;
      if (targetSet && !targetSet.has(normalizedEntityId)) continue;
      seen.add(normalizedEntityId);

      // MONOTONIC TIMESTAMP: Ensure timestamp grows even if env.timestamp doesn't change
      // Get last announced timestamp for this entity from gossip
      const existingProfile = this.env.gossip?.getProfiles?.().find((profile) => profile.entityId === entityId);
      const lastTimestamp = existingProfile?.lastUpdated || 0;
      const monotonicTimestamp = Math.max(lastTimestamp + 1, this.env.timestamp);
      const profile = buildLocalEntityProfile(this.env, replica.state, monotonicTimestamp);
      profile.runtimeId = this.runtimeId;
      profile.wsUrl = this.wsUrl;
      profile.relays = this.relayUrls;
      const firstValidator = replica.state.config.validators[0];
      if (!firstValidator) {
        throw new Error(`P2P_PROFILE_SIGNER_REQUIRED: entity=${entityId}`);
      }
      const signedProfile = await signProfile(this.env as Env, profile, firstValidator);
      profiles.push(signedProfile);
    }
    return profiles;
  }

  private handleGossipRequest(from: string, payload: unknown) {
    if (!this.env.gossip?.getProfiles) return;
    const request = payload as GossipProfileBatchRequest;
    const profiles = this.getLocalProfileBatch(request);

    const client = this.getActiveClient();
    if (!client) return;
    client.sendGossipResponse(from, { profiles } satisfies GossipResponsePayload);
  }

  private getLocalProfileBatch(request: GossipProfileBatchRequest = {}): Profile[] {
    const allProfiles = this.env.gossip?.getProfiles?.() || [];
    return selectProfileBatch(allProfiles, request, DEFAULT_GOSSIP_BATCH_LIMIT);
  }

  private handleGossipResponse(from: string, payload: unknown) {
    const response = payload as GossipResponsePayload;
    const profiles = Array.isArray(response?.profiles) ? response.profiles : [];
    this.applyIncomingProfiles(from, profiles).catch(err => {
      console.warn(`P2P_APPLY_PROFILES_ERROR: ${err.message}`);
    });
  }

  private handleGossipAnnounce(from: string, payload: unknown) {
    const response = payload as GossipResponsePayload;
    const profiles = Array.isArray(response?.profiles) ? response.profiles : [];
    this.applyIncomingProfiles(from, profiles).catch(err => {
      console.warn(`P2P_APPLY_PROFILES_ERROR: ${err.message}`);
    });
  }

  private async applyIncomingProfiles(from: string, profiles: Profile[]) {
    if (profiles.length === 0) return;
    let verified = 0;
    let skipped = 0;
    let accepted = 0;
    const acceptedProfiles: Profile[] = [];
    for (const profile of profiles) {
      const { profile: sanitized, error: malformedReason } = sanitizeIncomingProfile(profile);
      if (!sanitized) {
        skipped++;
        const entityId = typeof profile === 'object' && profile !== null && 'entityId' in profile
          ? String((profile as { entityId?: unknown }).entityId || 'unknown')
          : 'unknown';
        console.warn(
          `P2P_PROFILE_DROPPED_MALFORMED: from=${from} entity=${entityId} reason=${malformedReason || 'unknown'}`,
        );
        continue;
      }
      // Skip profiles we already have at the same or newer timestamp (avoids re-verification)
      const existingProfiles = this.env.gossip?.getProfiles?.() || [];
      const existing = existingProfiles.find((existingProfile) => existingProfile.entityId === sanitized.entityId);
      if (existing && existing.lastUpdated >= sanitized.lastUpdated) {
        skipped++;
        continue;
      }

      // Verify profile signature if present (anti-spoofing)
      // Hanko is self-contained: claims embed the board, signatures prove identity
      const hasHanko = sanitized.metadata.profileHanko;
      if (!hasHanko) {
        skipped++;
        console.warn(`P2P_PROFILE_DROPPED_UNSIGNED: from=${from} entity=${sanitized.entityId}`);
        continue;
      }
      {
        const result = await verifyProfileSignature(sanitized, this.env);
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
              reconstructedBoardHash: details.claims[0]?.reconstructedBoardHash,
            };
          } catch (error) {
            hankoInspect = {
              recoveredAddresses: [`inspect_failed:${(error as Error).message}`],
            };
          }
          console.error(
            `P2P_PROFILE_INVALID_SIGNATURE: ${sanitized.entityId.slice(-4)} from=${from.slice(-6)}`,
            {
              reason: result.reason,
              hash: result.hash?.slice(0, 18),
              signerId: result.signerId,
              hanko: typeof hasHanko === 'string' ? hasHanko.slice(0, 30) + '...' : !!hasHanko,
              entityPublicKey: entityPublicKey.slice(0, 20) + '...',
              boardPublicKey: hasBoardKey ? 'yes' : 'no',
              validators: boardValidators.length,
              boardSigners: boardValidators.map((validator) => String(validator.signerId || validator.signer)).filter(Boolean),
              recoveredAddresses: hankoInspect?.recoveredAddresses ?? [],
              reconstructedBoardHash: hankoInspect?.reconstructedBoardHash,
              runtimeId: sanitized.runtimeId,
              name: sanitized.name,
            }
          );
          continue; // Skip invalid profiles
        }
        verified++;
      }

      // Store in local gossip cache
      this.env.gossip?.announce?.(sanitized);
      accepted++;
      acceptedProfiles.push(sanitized);

      // Register validator public keys from profile board (for account signature verification)
      for (const validator of sanitized.metadata.board.validators) {
        const signerId = validator.signerId;
        const publicKey = validator.publicKey;
        if (signerId && publicKey && isHexPublicKey(publicKey)) {
          registerSignerPublicKey(signerId, publicKey);
        }
      }

      // Register public key for signature verification
      const publicKey = getBoardPrimaryPublicKey(sanitized.metadata.board, sanitized.entityId);
      if (publicKey && isHexPublicKey(publicKey)) {
        registerSignerPublicKey(sanitized.entityId, publicKey);
      }
    }
    if (verified > 0) console.log(`P2P_PROFILE_NEW from=${from} verified=${verified} skipped=${skipped}`);
    if (accepted > 0 && this.pendingByRuntime.size > 0) {
      this.flushPending();
    }
    if (accepted > 0) {
      this.syncDirectPeerConnections();
    }
    this.onGossipProfiles(from, acceptedProfiles);
  }

  private closeClients() {
    for (const client of this.clients) {
      client.close();
    }
    this.clients = [];
  }

  private closeDirectClients() {
    for (const client of this.directClients.values()) {
      client.close();
    }
    this.directClients.clear();
    this.directClientUrls.clear();
  }

  private getDirectPeerEndpoint(runtimeId: string): string | null {
    const normalizedTargetRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedTargetRuntimeId || normalizedTargetRuntimeId === this.runtimeId) return null;
    const profiles = this.env.gossip?.getProfiles?.() || [];
    for (const profile of profiles) {
      if (normalizeRuntimeId(profile.runtimeId || '') !== normalizedTargetRuntimeId) continue;
      const endpoint = normalizeOptionalWsUrl(profile.wsUrl);
      if (endpoint) return endpoint;
    }
    return null;
  }

  private resolveTargetEncryptionKey(targetRuntimeId: string): Uint8Array | null {
    const normalizedTargetRuntimeId = normalizeRuntimeId(targetRuntimeId);
    if (!normalizedTargetRuntimeId) return null;
    const hintedKey = this.peerRuntimeEncPubKeys.get(normalizedTargetRuntimeId);
    if (hintedKey) {
      try {
        return hexToPubKey(hintedKey);
      } catch {
        this.peerRuntimeEncPubKeys.delete(normalizedTargetRuntimeId);
      }
    }
    const profiles = this.env.gossip?.getProfiles?.() || [];
    const keyStats = new Map<string, { count: number; latestTs: number }>();
    for (const profile of profiles) {
      if (normalizeRuntimeId(profile.runtimeId || '') !== normalizedTargetRuntimeId) continue;
      const rawKey = profile.runtimeEncPubKey;
      if (typeof rawKey !== 'string' || rawKey.length === 0) continue;
      const normalizedKey = rawKey.startsWith('0x') ? rawKey.toLowerCase() : `0x${rawKey.toLowerCase()}`;
      if (!/^0x[0-9a-f]{64}$/.test(normalizedKey)) continue;
      const ts = Number(profile.lastUpdated || 0);
      const prev = keyStats.get(normalizedKey);
      if (!prev) {
        keyStats.set(normalizedKey, { count: 1, latestTs: ts });
      } else {
        prev.count += 1;
        if (ts > prev.latestTs) prev.latestTs = ts;
      }
    }
    let selectedKey: string | null = null;
    let selectedCount = -1;
    let selectedTs = -1;
    for (const [key, stat] of keyStats.entries()) {
      if (
        stat.count > selectedCount ||
        (stat.count === selectedCount && stat.latestTs > selectedTs)
      ) {
        selectedKey = key;
        selectedCount = stat.count;
        selectedTs = stat.latestTs;
      }
    }
    if (!selectedKey) return null;
    try {
      return hexToPubKey(selectedKey);
    } catch {
      return null;
    }
  }

  private ensureDirectClientForRuntime(runtimeId: string): void {
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
    }
    const client = new RuntimeWsClient({
      url: endpoint,
      runtimeId: this.runtimeId,
      signerId: this.signerId,
      ...(this.env.runtimeSeed ? { seed: this.env.runtimeSeed } : {}),
      encryptionKeyPair: this.encryptionKeyPair,
      getTargetEncryptionKey: (targetRuntimeId: string) => {
        return this.resolveTargetEncryptionKey(targetRuntimeId);
      },
      onPeerEncryptionKey: (fromRuntimeId: string, pubKeyHex: string) => {
        const normalizedRuntimeId = normalizeRuntimeId(fromRuntimeId);
        const normalizedKey = typeof pubKeyHex === 'string'
          ? (pubKeyHex.startsWith('0x') ? pubKeyHex.toLowerCase() : `0x${pubKeyHex.toLowerCase()}`)
          : '';
        if (!normalizedRuntimeId) return;
        if (!/^0x[0-9a-f]{64}$/.test(normalizedKey)) return;
        this.peerRuntimeEncPubKeys.set(normalizedRuntimeId, normalizedKey);
      },
      onOpen: () => {
        this.flushPending();
      },
      onEntityInput: async (from, input, timestamp) => {
        this.prefetchProfilesForInput(input);
        this.onEntityInput(from, input, timestamp);
      },
      onError: (error) => {
        this.env.warn('network', 'WS_DIRECT_ERROR', {
          endpoint,
          targetRuntimeId: normalizedTargetRuntimeId,
          error: error.message,
        });
      },
      maxReconnectAttempts: 0,
    });
    this.directClients.set(normalizedTargetRuntimeId, client);
    this.directClientUrls.set(normalizedTargetRuntimeId, endpoint);
    client.connect().catch(error => {
      this.env.warn('network', 'WS_DIRECT_CONNECT_FAILED', {
        endpoint,
        targetRuntimeId: normalizedTargetRuntimeId,
        error: (error as Error).message,
      });
    });
  }

  private syncDirectPeerConnections(): void {
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
