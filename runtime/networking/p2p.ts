import type { Env, EntityInput } from '../types';
import type { Profile } from './gossip';
import { RuntimeWsClient } from './ws-client';
import { buildEntityProfile } from './gossip-helper';
import { extractEntityId } from '../ids';
import { getCachedSignerPublicKey, registerSignerPublicKey } from '../account-crypto';

const DEFAULT_RELAY_URL = 'wss://xln.finance/relay';

export type P2PConfig = {
  relayUrls?: string[];
  seedRuntimeIds?: string[];
  runtimeId?: string;
  signerId?: string;
  advertiseEntityIds?: string[];
  isHub?: boolean;
  profileName?: string;
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
  private profileName?: string;
  private onEntityInput: (from: string, input: EntityInput) => void;
  private onGossipProfiles: (from: string, profiles: Profile[]) => void;
  private clients: RuntimeWsClient[] = [];
  private pendingByRuntime = new Map<string, EntityInput[]>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: RuntimeP2POptions) {
    this.env = options.env;
    this.runtimeId = options.runtimeId;
    this.signerId = options.signerId || '1';
    this.relayUrls = unique(options.relayUrls || [DEFAULT_RELAY_URL]);
    this.seedRuntimeIds = unique(options.seedRuntimeIds || []);
    this.advertiseEntityIds = options.advertiseEntityIds || null;
    this.isHub = options.isHub ?? false;
    this.profileName = options.profileName;
    this.onEntityInput = options.onEntityInput;
    this.onGossipProfiles = options.onGossipProfiles;
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
    this.closeClients();
    this.startPolling();
    for (const url of this.relayUrls) {
      const client = new RuntimeWsClient({
        url,
        runtimeId: this.runtimeId,
        signerId: this.signerId,
        seed: this.env.runtimeSeed,  // Pass seed for hello auth signing
        onOpen: () => {
          this.flushPending();
          this.requestSeedGossip();
          this.announceLocalProfiles();
        },
        onEntityInput: async (from, input) => {
          // Ensure we have sender's profile before processing
          const senderEntity = input.entityId;
          if (senderEntity && !this.hasProfileForEntity(senderEntity)) {
            console.log(`P2P_FETCH_PROFILE: ${senderEntity.slice(-4)} (not in cache)`);
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
    if (this.pollInterval) return;
    // Request immediately, then periodically
    setTimeout(() => this.requestSeedGossip(), 100);
    this.pollInterval = setInterval(() => {
      this.requestSeedGossip();
    }, GOSSIP_POLL_MS);
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
    // Request profiles multiple times with delays
    for (let i = 0; i < 3; i++) {
      this.requestSeedGossip();
      await new Promise(resolve => setTimeout(resolve, 500));
      // Check if profiles arrived
      const profiles = this.env.gossip?.getProfiles?.() || [];
      console.log(`P2P_FETCH_RETRY: attempt ${i + 1}, got ${profiles.length} profiles`);
    }
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

      const profile = buildEntityProfile(replica.state, this.profileName, monotonicTimestamp);
      profile.runtimeId = this.runtimeId;
      if (this.isHub) {
        profile.capabilities = Array.from(new Set([...(profile.capabilities || []), 'hub', 'relay']));
        profile.metadata = { ...(profile.metadata || {}), isHub: true };
        if (this.relayUrls.length > 0) {
          profile.endpoints = this.relayUrls;
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
      profiles.push(profile);
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
    this.applyIncomingProfiles(from, profiles);
  }

  private handleGossipAnnounce(from: string, payload: unknown) {
    const response = payload as GossipResponsePayload;
    const profiles = Array.isArray(response?.profiles) ? response.profiles : [];
    this.applyIncomingProfiles(from, profiles);
  }

  private applyIncomingProfiles(from: string, profiles: Profile[]) {
    if (profiles.length === 0) return;
    for (const profile of profiles) {
      // Store in local gossip cache
      this.env.gossip?.announce?.(profile);

      // Register public key for signature verification
      const publicKey = profile.metadata?.entityPublicKey;
      if (publicKey && typeof publicKey === 'string' && isHexPublicKey(publicKey)) {
        registerSignerPublicKey(profile.entityId, publicKey);
      }
    }
    console.log(`P2P_PROFILE_RECEIVED from=${from.slice(0, 10)} profiles=${profiles.length}`);
    this.onGossipProfiles(from, profiles);
  }

  private closeClients() {
    for (const client of this.clients) {
      client.close();
    }
    this.clients = [];
  }
}
