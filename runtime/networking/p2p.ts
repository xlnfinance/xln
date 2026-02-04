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

import type { Env, EntityInput } from '../types';
import type { Profile } from './gossip';
import { RuntimeWsClient } from './ws-client';
import { buildEntityProfile, mergeProfileWithExisting } from './gossip-helper';
import { extractEntityId } from '../ids';
import { getCachedSignerPublicKey, registerSignerPublicKey } from '../account-crypto';
import { signProfileSync, verifyProfileSignature } from './profile-signing';
import { deriveEncryptionKeyPair, pubKeyToHex, hexToPubKey, type P2PKeyPair } from './p2p-crypto';

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
  onEntityInput: (from: string, input: EntityInput) => void;
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

const GOSSIP_POLL_MS = 1000; // Poll relay every second

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
  private onEntityInput: (from: string, input: EntityInput) => void;
  private onGossipProfiles: (from: string, profiles: Profile[]) => void;
  private clients: RuntimeWsClient[] = [];
  private pendingByRuntime = new Map<string, EntityInput[]>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private encryptionKeyPair: P2PKeyPair;

  constructor(options: RuntimeP2POptions) {
    this.env = options.env;
    this.runtimeId = options.runtimeId;
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
  getEncryptionPubKeyHex(): string {
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
      this.gossipPollMs = config.gossipPollMs;
      if (this.gossipPollMs <= 0) {
        this.stopPolling();
      } else if (!this.pollInterval) {
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
    this.startPolling();
    for (const url of this.relayUrls) {
      const runtimeSeed = this.env.runtimeSeed;
      const client = new RuntimeWsClient({
        url,
        runtimeId: this.runtimeId,
        signerId: this.signerId,
        ...(runtimeSeed ? { seed: runtimeSeed } : {}),  // Pass seed for hello auth signing if available
        encryptionKeyPair: this.encryptionKeyPair, // Pass our keypair for encryption/decryption
        getTargetEncryptionKey: (targetRuntimeId: string) => {
          // Lookup target's public key from gossip
          const profiles = this.env.gossip?.getProfiles?.() || [];
          const targetProfile = profiles.find((p: any) => p.runtimeId === targetRuntimeId);
          if (!targetProfile?.metadata?.encryptionPubKey) return null;
          try {
            const hexToPubKey = require('./p2p-crypto').hexToPubKey;
            return hexToPubKey(targetProfile.metadata.encryptionPubKey);
          } catch {
            return null;
          }
        },
        onOpen: () => {
          this.flushPending();
          if (this.gossipPollMs > 0) {
            this.requestSeedGossip();
          }
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
            await this.fetchProfilesWithRetry();
          }

          this.onEntityInput(from, input);
        },
        onGossipRequest: (from, payload) => this.handleGossipRequest(from, payload),
        onGossipResponse: (from, payload) => this.handleGossipResponse(from, payload),
        onGossipAnnounce: (from, payload) => this.handleGossipAnnounce(from, payload),
        onError: (error) => {
          this.env.warn('network', 'WS_CLIENT_ERROR', { relay: url, error: error.message });
        },
      });
      this.clients.push(client);
      client.connect().catch(error => {
        this.env.warn('network', 'WS_CONNECT_FAILED', { relay: url, error: error.message });
      });
    }
  }

  close() {
    this.stopPolling();
    this.closeClients();
    this.pendingByRuntime.clear();
  }

  private startPolling() {
    if (this.pollInterval) {
      console.log(`[P2P] startPolling: Already polling, skipping`);
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

  reconnect() {
    this.connect();
  }

  enqueueEntityInput(targetRuntimeId: string, input: EntityInput) {
    console.log(`📨 P2P-ENQUEUE: to=${targetRuntimeId.slice(0,10)} entity=${input.entityId.slice(-4)} txs=${input.entityTxs?.length || 0}`);
    console.log(`📨 P2P-DEBUG: clients=${this.clients.length} open=${this.clients.map(c => c.isOpen())}`);

    const client = this.getActiveClient();
    if (client && client.isOpen()) {
      console.log(`📡 P2P-SEND-NOW: Client is open, sending immediately`);
      const sent = client.sendEntityInput(targetRuntimeId, input);
      if (sent) {
        console.log(`✅ P2P-SENT: Message sent successfully`);
        return;
      }
      console.warn(`⚠️ P2P-SEND-FAILED: Client.send returned false`);
    } else {
      console.warn(`⚠️ P2P-NO-CLIENT: No active client, queueing message`);
    }

    const queue = this.pendingByRuntime.get(targetRuntimeId) || [];
    queue.push(input);
    // Enforce queue size limit to prevent memory exhaustion
    while (queue.length > MAX_QUEUE_PER_RUNTIME) queue.shift();
    this.pendingByRuntime.set(targetRuntimeId, queue);
    console.log(`📥 P2P-QUEUED: Message queued for ${targetRuntimeId.slice(0,10)}, queue size: ${queue.length}`);
  }

  requestGossip(runtimeId: string) {
    const client = this.getActiveClient();
    if (!client) return;
    client.sendGossipRequest(runtimeId, { scope: 'all' } satisfies GossipRequestPayload);
  }

  announceProfilesTo(runtimeId: string, profiles: Profile[]) {
    const client = this.getActiveClient();
    if (!client) return;
    client.sendGossipAnnounce(runtimeId, { profiles } satisfies GossipResponsePayload);
  }

  private getActiveClient(): RuntimeWsClient | null {
    return this.clients.find(client => client.isOpen()) || null;
  }

  private flushPending() {
    const client = this.getActiveClient();
    if (!client || !client.isOpen()) return;
    for (const [targetRuntimeId, queue] of this.pendingByRuntime.entries()) {
      const remaining: EntityInput[] = [];
      for (const input of queue) {
        const sent = client.sendEntityInput(targetRuntimeId, input);
        if (!sent) remaining.push(input);
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
    console.log(`P2P_GOSSIP_REQUEST scope=all`);
  }

  // Call this to refresh profiles from relay
  refreshGossip() {
    this.requestSeedGossip();
  }

  // Check if we have a profile for an entity in local gossip cache
  private hasProfileForEntity(entityId: string): boolean {
    const profiles = this.env.gossip?.getProfiles?.() || [];
    return profiles.some((p: any) => p.entityId === entityId);
  }

  // Fetch profiles from relay with retry
  private async fetchProfilesWithRetry(): Promise<void> {
    const startCount = this.env.gossip?.getProfiles?.()?.length || 0;
    console.log(`P2P_FETCH_PROFILES: Starting fetch, currently have ${startCount} profiles`);

    // Request profiles multiple times with delays
    for (let i = 0; i < 5; i++) {
      this.requestSeedGossip();
      await new Promise(resolve => setTimeout(resolve, 300));
      // Check if new profiles arrived
      const profiles = this.env.gossip?.getProfiles?.() || [];
      const profileIds = profiles.map((p: any) => p.entityId?.slice(-4) || '???').join(',');
      console.log(`P2P_FETCH_RETRY: attempt ${i + 1}, got ${profiles.length} profiles [${profileIds}]`);
      if (profiles.length > startCount) {
        console.log(`P2P_FETCH_SUCCESS: Got ${profiles.length - startCount} new profiles`);
        return;
      }
    }
    console.log(`P2P_FETCH_TIMEOUT: Still have ${this.env.gossip?.getProfiles?.()?.length || 0} profiles after retries`);
  }

  private announceLocalProfiles() {
    const profiles = this.getLocalProfiles();
    if (profiles.length === 0) return;
    for (const profile of profiles) {
      this.env.gossip?.announce?.(profile);
    }

    // ALWAYS announce to relay for storage (relay stores regardless of 'to' field)
    const client = this.getActiveClient();
    if (client) {
      client.sendGossipAnnounce(this.runtimeId, { profiles });
      console.log(`P2P_PROFILE_ANNOUNCE n=${profiles.length}`);
    }

    // Also send to specific seeds if configured (for direct peer notification)
    for (const seedId of this.seedRuntimeIds) {
      this.announceProfilesTo(seedId, profiles);
      console.log(`P2P_PROFILE_SENT from=${this.runtimeId.slice(0, 10)} to=${seedId.slice(0, 10)} profiles=${profiles.length}`);
    }
  }

  private getLocalProfiles(): Profile[] {
    if (!this.env.eReplicas || this.env.eReplicas.size === 0) return [];
    const profiles: Profile[] = [];
    const seen = new Set<string>();
    for (const [replicaKey, replica] of this.env.eReplicas.entries()) {
      let entityId: string;
      try {
        entityId = extractEntityId(replicaKey);
      } catch {
        continue;
      }
      if (seen.has(entityId)) continue;
      if (this.advertiseEntityIds && !this.advertiseEntityIds.includes(entityId)) continue;
      seen.add(entityId);

      // MONOTONIC TIMESTAMP: Ensure timestamp grows even if env.timestamp doesn't change
      // Get last announced timestamp for this entity from gossip
      const existingProfile = this.env.gossip?.getProfiles?.().find((p: any) => p.entityId === entityId);
      const lastTimestamp = existingProfile?.metadata?.lastUpdated || 0;
      const monotonicTimestamp = Math.max(lastTimestamp + 1, this.env.timestamp);
      console.log(`🕐 MONOTONIC: entity=${entityId.slice(-4)} lastTs=${lastTimestamp} envTs=${this.env.timestamp} → ${monotonicTimestamp}`);

      const existingName = existingProfile?.metadata?.name;
      const profile = buildEntityProfile(replica.state, this.profileName ?? existingName, monotonicTimestamp);
      profile.runtimeId = this.runtimeId;
      if (this.isHub) {
        profile.capabilities = Array.from(new Set([...(profile.capabilities || []), 'hub', 'relay']));
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
        encryptionPubKey: this.getEncryptionPubKeyHex(),
      };

      // Preserve existing hub metadata + custom fields
      const merged = mergeProfileWithExisting(profile, existingProfile);

      // Sign profile using same mechanism as accountFrames (Hanko-based)
      // Uses sync version here; async signProfile() available for full Hanko with ABI encoding
      let signedProfile = merged;
      if (firstValidator && this.env.runtimeSeed) {
        try {
          signedProfile = signProfileSync({ runtimeSeed: this.env.runtimeSeed }, profile, firstValidator);
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
    for (const profile of profiles) {
      // Verify profile signature if present (anti-spoofing)
      // Uses same Hanko verification as accountFrames
      const hasHanko = profile.metadata?.['profileHanko'];
      const hasLegacySig = profile.metadata?.['profileSignature'];
      if (hasHanko || hasLegacySig) {
        const valid = await verifyProfileSignature(profile, this.env);
        if (!valid) {
          console.warn(`P2P_PROFILE_INVALID_SIGNATURE: ${profile.entityId.slice(-4)} - rejecting`);
          continue; // Skip invalid profiles
        }
        verified++;
      } else {
        // Warn but accept unsigned profiles for migration
        unsigned++;
      }

      // Store in local gossip cache
      this.env.gossip?.announce?.(profile);

      // Register public key for signature verification
      const publicKey = profile.metadata?.entityPublicKey;
      if (publicKey && typeof publicKey === 'string' && isHexPublicKey(publicKey)) {
        registerSignerPublicKey(profile.entityId, publicKey);
      }
    }
    console.log(`P2P_PROFILE_RECEIVED from=${from.slice(0, 10)} total=${profiles.length} verified=${verified} unsigned=${unsigned}`);
    this.onGossipProfiles(from, profiles);
  }

  private closeClients() {
    for (const client of this.clients) {
      client.close();
    }
    this.clients = [];
  }
}
