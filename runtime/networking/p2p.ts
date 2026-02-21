/**
 * XLN P2P Overlay Network
 *
 * ARCHITECTURE: Transport layer for entity communication via relay servers.
 *
 * SECURITY MODEL - P2P is a "dumb pipe":
 * - NO replay protection here - accountFrame heights handle that in consensus layer
 * - Profile signatures prevent spoofing (entityPublicKey bound to board validators)
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
 * - Invalid signatures rejected; unsigned profiles accepted with warning (migration)
 */

import type { Env, RoutedEntityInput } from '../types';
import type { Profile } from './gossip';
import { RuntimeWsClient } from './ws-client';
import { buildEntityProfile, mergeProfileWithExisting } from './gossip-helper';
import { extractEntityId } from '../ids';
import { getCachedSignerPrivateKey, getCachedSignerPublicKey, registerSignerPublicKey } from '../account-crypto';
import { signProfile, verifyProfileSignature } from './profile-signing';
import { deriveEncryptionKeyPair, pubKeyToHex, hexToPubKey, type P2PKeyPair } from './p2p-crypto';
import { asFailFastPayload, failfastAssert } from './failfast';
import { normalizeRuntimeId, isRuntimeId } from './runtime-id';

const DEFAULT_RELAY_URL = 'wss://xln.finance/relay';
const MAX_QUEUE_PER_RUNTIME = 100; // Prevent memory exhaustion (DoS protection)

export type P2PConfig = {
  relayUrls?: string[];
  seedRuntimeIds?: string[];
  runtimeId?: string;
  signerId?: string;
  advertiseEntityIds?: string[];
  isHub?: boolean;
  profileName?: string;
  gossipPollMs?: number;
};

type RuntimeP2POptions = {
  env: Env;
  runtimeId: string;
  signerId?: string;
  relayUrls?: string[];
  seedRuntimeIds?: string[];
  advertiseEntityIds?: string[];
  isHub?: boolean;
  profileName?: string;
  gossipPollMs?: number;
  onEntityInput: (from: string, input: RoutedEntityInput) => void;
  onGossipProfiles: (from: string, profiles: Profile[]) => void;
};

type GossipRequestPayload = {
  scope?: 'all' | 'bundle';
  entityId?: string;
};

type GossipResponsePayload = {
  profiles: Profile[];
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

const unique = (items: string[]): string[] => Array.from(new Set(items.filter(Boolean)));

const isSameList = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const aSorted = [...a].sort();
  const bSorted = [...b].sort();
  return aSorted.every((value, index) => value === bSorted[index]);
};

const isHexPublicKey = (value: string): boolean => {
  if (!value.startsWith('0x')) return false;
  const hex = value.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
  return hex.length === 66 || hex.length === 130;
};

const normalizeX25519PubKey = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-fA-F]{64}$/.test(prefixed) ? prefixed.toLowerCase() : null;
};

const sanitizeIncomingProfile = (profile: Profile): Profile | null => {
  const entityId = String(profile?.entityId || '').trim();
  if (!entityId) return null;
  const metadata = (profile?.metadata || {}) as Record<string, unknown>;
  const normalizedRuntimeId = normalizeRuntimeId(profile?.runtimeId ?? metadata.runtimeId);
  if (!normalizedRuntimeId) return null;
  const normalizedName = typeof metadata.name === 'string' && metadata.name.trim().length > 0
    ? metadata.name.trim()
    : `Entity ${entityId.slice(-4)}`;
  // Keep entity-level HTLC key and runtime transport key distinct.
  // `cryptoPublicKey` is used for HTLC envelope encryption (entity scoped).
  // `encryptionPublicKey` is used for relay transport encryption (runtime scoped).
  const normalizedCryptoKey = normalizeX25519PubKey(metadata.cryptoPublicKey);
  const normalizedEncryptionKey =
    normalizeX25519PubKey(metadata.encryptionPublicKey)
    ?? normalizedCryptoKey;
  const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities : [];
  const claimsHub =
    metadata.isHub === true || capabilities.includes('hub') || capabilities.includes('routing');
  if (claimsHub && !normalizedEncryptionKey) {
    return null;
  }
  return {
    ...profile,
    runtimeId: normalizedRuntimeId,
    capabilities,
    metadata: {
      ...metadata,
      runtimeId: normalizedRuntimeId,
      name: normalizedName,
      ...(normalizedCryptoKey ? { cryptoPublicKey: normalizedCryptoKey } : {}),
      ...(normalizedEncryptionKey ? { encryptionPublicKey: normalizedEncryptionKey } : {}),
    } as any,
  };
};

const normalizeId = (value: string): string => value.toLowerCase();
const getReplicaSignerId = (replicaKey: string): string => {
  const idx = replicaKey.lastIndexOf(':');
  return idx === -1 ? '' : replicaKey.slice(idx + 1);
};

const GOSSIP_POLL_MS = 5000; // Poll relay every 5s by default to avoid relay spam

export class RuntimeP2P {
  private env: Env;
  private runtimeId: string;
  private signerId: string;
  private relayUrls: string[];
  private seedRuntimeIds: string[];
  private advertiseEntityIds: string[] | null;
  private isHub: boolean;
  private profileName: string | undefined;
  private gossipPollMs: number;
  private onEntityInput: (from: string, input: RoutedEntityInput) => void;
  private onGossipProfiles: (from: string, profiles: Profile[]) => void;
  private clients: RuntimeWsClient[] = [];
  private pendingByRuntime = new Map<string, { input: RoutedEntityInput, enqueuedAt: number }[]>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private retryInterval: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private encryptionKeyPair: P2PKeyPair;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAnnounceEntities = new Set<string>();

  constructor(options: RuntimeP2POptions) {
    this.env = options.env;
    failfastAssert(isRuntimeId(options.runtimeId), 'P2P_RUNTIME_ID_INVALID', 'RuntimeP2P runtimeId must be signer EOA');
    this.runtimeId = normalizeRuntimeId(options.runtimeId);
    this.signerId = options.signerId || '1';
    this.relayUrls = unique(options.relayUrls || [DEFAULT_RELAY_URL]);
    this.seedRuntimeIds = unique(options.seedRuntimeIds || []);
    this.advertiseEntityIds = options.advertiseEntityIds || null;
    this.isHub = options.isHub ?? false;
    this.profileName = options.profileName;
    this.gossipPollMs = options.gossipPollMs ?? GOSSIP_POLL_MS;
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
    if (config.advertiseEntityIds) {
      this.advertiseEntityIds = config.advertiseEntityIds;
    }
    if (config.isHub !== undefined) {
      this.isHub = config.isHub;
    }
    if (config.profileName !== undefined) {
      this.profileName = config.profileName;
    }
    if (config.gossipPollMs !== undefined) {
      const prevPollMs = this.gossipPollMs;
      this.gossipPollMs = config.gossipPollMs;
      if (this.gossipPollMs <= 0) {
        this.stopPolling();
      } else if (!this.pollInterval) {
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
        getTargetEncryptionKey: (targetRuntimeId: string) => {
          // Lookup target's public key from gossip
          const profiles = this.env.gossip?.getProfiles?.() || [];
          const targetRuntimeIdNorm = normalizeRuntimeId(targetRuntimeId);
          if (!targetRuntimeIdNorm) return null;
          const targetProfiles = profiles.filter((p: any) =>
            normalizeRuntimeId(String(p.runtimeId || '')) === targetRuntimeIdNorm,
          );
          if (targetProfiles.length === 0) return null;
          // Pick the most common valid key among profiles for this runtimeId; break ties by latest lastUpdated.
          const keyStats = new Map<string, { count: number; latestTs: number }>();
          for (const profile of targetProfiles) {
            const rawKey = profile?.metadata?.encryptionPublicKey;
            if (typeof rawKey !== 'string' || rawKey.length === 0) continue;
            const normalizedKey = rawKey.startsWith('0x') ? rawKey.toLowerCase() : `0x${rawKey.toLowerCase()}`;
            if (!/^0x[0-9a-f]{64}$/.test(normalizedKey)) continue;
            const ts = Number(profile?.metadata?.lastUpdated || 0);
            const prev = keyStats.get(normalizedKey);
            if (!prev) {
              keyStats.set(normalizedKey, { count: 1, latestTs: ts });
            } else {
              prev.count += 1;
              if (ts > prev.latestTs) prev.latestTs = ts;
            }
          }
          if (keyStats.size === 0) return null;
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
        },
        onOpen: () => {
          this.flushPending();
          // ALWAYS request gossip on connect (even if periodic polling is disabled)
          this.requestSeedGossip();
          this.announceLocalProfiles();
        },
        onEntityInput: async (from, input) => {
          // Collect all entity IDs that need profiles before we can process
          const entitiesToCheck = new Set<string>();

          // Target entity
          if (input.entityId) entitiesToCheck.add(input.entityId);

          // Extract sender entities from accountInput and openAccount transactions
          if (input.entityTxs) {
            for (const tx of input.entityTxs) {
              if (tx.type === 'accountInput' && tx.data) {
                const accountInput = tx.data as { fromEntityId?: string; toEntityId?: string };
                if (accountInput.fromEntityId) entitiesToCheck.add(accountInput.fromEntityId);
                if (accountInput.toEntityId) entitiesToCheck.add(accountInput.toEntityId);
              }
              // CRITICAL: openAccount response needs sender's profile to route ACK back
              if (tx.type === 'openAccount' && tx.data) {
                const openAccount = tx.data as { targetEntityId?: string };
                if (openAccount.targetEntityId) entitiesToCheck.add(openAccount.targetEntityId);
              }
            }
          }

          // Fetch profiles for any missing entities
          const missingEntities = Array.from(entitiesToCheck).filter(e => !this.hasProfileForEntity(e));
          if (missingEntities.length > 0) {
            console.log(`P2P_FETCH_PROFILE: ${missingEntities.map(e => e.slice(-4)).join(',')} (not in cache)`);
            await this.fetchProfilesWithRetry(missingEntities);
          }

          this.onEntityInput(from, input);
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
    if (this.announceTimer) {
      clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }
    this.pendingAnnounceEntities.clear();
    this.closeClients();
    this.pendingByRuntime.clear();
  }

  private startPolling() {
    if (this.pollInterval) {
      // Already polling
      return;
    }
    if (this.gossipPollMs <= 0) {
      console.log('[P2P] startPolling: Gossip polling disabled (manual refresh only)');
      return;
    }
    console.log(`[P2P] startPolling: Starting polling every ${this.gossipPollMs}ms`);
    // Request immediately, then periodically
    setTimeout(() => this.requestSeedGossip(), 100);
    this.pollInterval = setInterval(() => {
      this.requestSeedGossip();
    }, this.gossipPollMs);
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
    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      if (!this.getActiveClient()) {
        console.warn('[P2P] Tab resumed with no active WS client — forcing reconnect');
        this.reconnect();
        return;
      }
      this.requestSeedGossip();
      this.flushPending();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private unregisterVisibilityReconnect() {
    if (typeof document === 'undefined') return;
    if (!this.visibilityHandler) return;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
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

  enqueueEntityInput(targetRuntimeId: string, input: RoutedEntityInput) {
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
    const client = this.getActiveClient();
    if (client && client.isOpen()) {
      try {
        const sent = client.sendEntityInput(normalizedTargetRuntimeId, input);
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
      console.warn(`P2P-NO-CLIENT: No active relay connection, queueing for ${normalizedTargetRuntimeId}`);
    }

    const queue = this.pendingByRuntime.get(normalizedTargetRuntimeId) || [];
    queue.push({ input, enqueuedAt: Date.now() });
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
    client.sendGossipRequest(normalizedRuntimeId, { scope: 'all' } satisfies GossipRequestPayload);
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

  private flushPending() {
    const client = this.getActiveClient();
    if (!client || !client.isOpen()) return;
    for (const [targetRuntimeId, queue] of this.pendingByRuntime.entries()) {
      const remaining: { input: RoutedEntityInput, enqueuedAt: number }[] = [];
      for (const entry of queue) {
        try {
          const sent = client.sendEntityInput(targetRuntimeId, entry.input);
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

  private requestSeedGossip() {
    const client = this.getActiveClient();
    if (!client) return;

    // Request all profiles from relay (simple polling)
    client.sendGossipRequest(this.runtimeId, { scope: 'all' } satisfies GossipRequestPayload);
  }

  private ensureRelayConnectionsForEntity(entityId: string): void {
    // Single-relay mode: never auto-discover/switch relays from gossip profiles.
    // This prevents split-brain routing where different entities publish different relay hints.
    void entityId;
  }

  // Call this to refresh profiles from relay
  refreshGossip() {
    this.requestSeedGossip();
  }

  // Check if we have a profile for an entity in local gossip cache
  private hasProfileForEntity(entityId: string): boolean {
    const profiles = this.env.gossip?.getProfiles?.() || [];
    const targetEntityId = normalizeId(entityId);
    return profiles.some((p: any) => normalizeId(String(p.entityId || '')) === targetEntityId);
  }

  // Fetch profiles from relay with retry
  private async fetchProfilesWithRetry(missingEntityIds: string[] = []): Promise<void> {
    const startCount = this.env.gossip?.getProfiles?.()?.length || 0;

    // Request profiles multiple times with delays
    for (let i = 0; i < 5; i++) {
      this.requestSeedGossip();
      await new Promise(resolve => setTimeout(resolve, 300));
      const profiles = this.env.gossip?.getProfiles?.() || [];
      const hasAllMissing = missingEntityIds.length === 0 || missingEntityIds.every((entityId) => this.hasProfileForEntity(entityId));
      if (profiles.length > startCount || hasAllMissing) {
        console.log(`P2P_FETCH: Got ${profiles.length - startCount} new profiles (total: ${profiles.length})`);
        return;
      }
    }
    console.log(`P2P_FETCH: No new profiles after 5 retries (have ${startCount})`);
    if (missingEntityIds.length > 0) {
      this.env.warn('network', 'GOSSIP_PROFILE_MISS', {
        missingEntityIds,
        retries: 5,
      });
      this.sendDebugEvent({
        level: 'warn',
        code: 'GOSSIP_PROFILE_MISS',
        missingEntityIds,
        retries: 5,
      });
    }
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
    }, 150);
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
      if (!replicaSignerId || !getCachedSignerPrivateKey(replicaSignerId)) {
        continue;
      }
      const normalizedEntityId = normalizeId(entityId);
      if (seen.has(normalizedEntityId)) continue;
      if (advertisedSet && !advertisedSet.has(normalizedEntityId)) continue;
      if (targetSet && !targetSet.has(normalizedEntityId)) continue;
      seen.add(normalizedEntityId);

      // MONOTONIC TIMESTAMP: Ensure timestamp grows even if env.timestamp doesn't change
      // Get last announced timestamp for this entity from gossip
      const existingProfile = this.env.gossip?.getProfiles?.().find((p: any) => p.entityId === entityId);
      const lastTimestamp = existingProfile?.metadata?.lastUpdated || 0;
      const monotonicTimestamp = Math.max(lastTimestamp + 1, this.env.timestamp);
      // Monotonic timestamp: ensures profiles always advance

      const existingName = existingProfile?.metadata?.name;
      const profile = buildEntityProfile(replica.state, this.profileName ?? existingName, monotonicTimestamp);
      profile.runtimeId = this.runtimeId;
      if (this.isHub) {
        profile.capabilities = Array.from(new Set([...(profile.capabilities || []), 'hub', 'relay', 'routing', 'faucet']));
        profile.metadata = { ...(profile.metadata || {}), isHub: true };
        if (this.relayUrls.length > 0) {
          profile.endpoints = this.relayUrls;
          profile.relays = this.relayUrls;
        }
      }
      if (this.profileName) {
        profile.metadata = { ...(profile.metadata || {}), name: this.profileName };
      }

      // Get public key from first validator (superset approach - works for single/multi-signer)
      const firstValidator = replica.state.config.validators[0];
      const publicKey = firstValidator ? getCachedSignerPublicKey(firstValidator) : null;
      if (publicKey) {
        profile.metadata = {
          ...(profile.metadata || {}),
          entityPublicKey: `0x${toHex(publicKey)}`,
        };
      }

      // Add X25519 encryption public key for E2E messaging
      profile.metadata = {
        ...(profile.metadata || {}),
        encryptionPublicKey: this.getEncryptionPublicKeyHex(),
      };

      // Preserve existing hub metadata + custom fields
      const merged = mergeProfileWithExisting(profile, existingProfile);

      // Sign profile using Hanko mechanism (same as accountFrames)
      let signedProfile = merged;
      if (firstValidator && this.env.runtimeSeed) {
        try {
          signedProfile = await signProfile(this.env as Env, merged, firstValidator);
        } catch (error) {
          console.warn(`P2P_PROFILE_SIGN_FAILED: ${entityId.slice(-4)} - ${(error as Error).message}`);
        }
      }
      profiles.push(signedProfile);
    }
    return profiles;
  }

  private handleGossipRequest(from: string, payload: unknown) {
    if (!this.env.gossip?.getProfiles) return;
    const request = payload as GossipRequestPayload;
    let profiles: Profile[] = [];

    if (request?.scope === 'bundle' && request.entityId && this.env.gossip.getProfileBundle) {
      const bundle = this.env.gossip.getProfileBundle(request.entityId);
      profiles = [...(bundle.profile ? [bundle.profile] : []), ...bundle.peers];
    } else {
      profiles = this.env.gossip.getProfiles();
    }

    const client = this.getActiveClient();
    if (!client) return;
    client.sendGossipResponse(from, { profiles } satisfies GossipResponsePayload);
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
    let unsigned = 0;
    let skipped = 0;
    let accepted = 0;
    for (const profile of profiles) {
      const sanitized = sanitizeIncomingProfile(profile);
      if (!sanitized) {
        skipped++;
        console.warn(`P2P_PROFILE_DROPPED_MALFORMED: from=${from} entity=${String(profile?.entityId || 'unknown')}`);
        continue;
      }
      // Skip profiles we already have at the same or newer timestamp (avoids re-verification)
      const existingProfiles = this.env.gossip?.getProfiles?.() || [];
      const existing = existingProfiles.find((p: any) => p.entityId === sanitized.entityId);
      if (existing && existing.metadata?.lastUpdated >= (sanitized.metadata?.lastUpdated || 0)) {
        skipped++;
        continue;
      }

      // Verify profile signature if present (anti-spoofing)
      // Hanko is self-contained: claims embed the board, signatures prove identity
      const hasHanko = sanitized.metadata?.['profileHanko'];
      if (hasHanko) {
        const result = await verifyProfileSignature(sanitized, this.env);
        if (!result.valid) {
          const board = sanitized.metadata?.board;
          const boardValidators = board && typeof board === 'object' && 'validators' in board ? board.validators : undefined;
          const hasBoardKey = Array.isArray(boardValidators) && boardValidators.some(v => typeof v?.publicKey === 'string');
          const hasEntityKey = typeof profile.metadata?.entityPublicKey === 'string';
          console.error(
            `P2P_PROFILE_INVALID_SIGNATURE: ${profile.entityId.slice(-4)} from=${from.slice(-6)}`,
            {
              reason: result.reason,
              hash: result.hash?.slice(0, 18),
              signerId: result.signerId,
              hanko: typeof hasHanko === 'string' ? hasHanko.slice(0, 30) + '...' : !!hasHanko,
              entityPublicKey: hasEntityKey ? (profile.metadata?.entityPublicKey as string).slice(0, 20) + '...' : 'none',
              boardPublicKey: hasBoardKey ? 'yes' : 'no',
              validators: Array.isArray(boardValidators) ? boardValidators.length : 0,
              runtimeId: sanitized.runtimeId,
              name: sanitized.metadata?.name,
            }
          );
          continue; // Skip invalid profiles
        }
        verified++;
      } else {
        // Warn but accept unsigned profiles for migration
        unsigned++;
      }

      // Store in local gossip cache
      this.env.gossip?.announce?.(sanitized);
      accepted++;

      // Register validator public keys from profile board (for account signature verification)
      const board2 = sanitized.metadata?.board;
      const boardValidators = board2 && typeof board2 === 'object' && 'validators' in board2 ? board2.validators : undefined;
      if (Array.isArray(boardValidators)) {
        for (const validator of boardValidators) {
          const signerId = validator?.signerId;
          const publicKey = validator?.publicKey;
          if (signerId && publicKey && typeof publicKey === 'string' && isHexPublicKey(publicKey)) {
            registerSignerPublicKey(signerId, publicKey);
          }
        }
      }

      // Register public key for signature verification
      const publicKey = sanitized.metadata?.entityPublicKey;
      if (publicKey && typeof publicKey === 'string' && isHexPublicKey(publicKey)) {
        registerSignerPublicKey(sanitized.entityId, publicKey);
      }
    }
    if (verified > 0 || unsigned > 0) console.log(`P2P_PROFILE_NEW from=${from} verified=${verified} unsigned=${unsigned} skipped=${skipped}`);
    if (accepted > 0 && this.pendingByRuntime.size > 0) {
      this.flushPending();
    }
    this.onGossipProfiles(from, profiles);
  }

  private closeClients() {
    for (const client of this.clients) {
      client.close();
    }
    this.clients = [];
  }
}
