/**
 * Process-local profile dissemination and route discovery.
 *
 * Profile schema, canonicalization and certification belong to Entity and are
 * imported here. Networking owns only the live cache and transport-facing
 * graph. This direction keeps deterministic Entity admission independent from
 * process-local networking.
 */
import { logDebug } from '../../../support/logger';
import { buildNetworkGraph } from '../../../pathfinding/graph';
import { PathFinder, type PaymentRoute } from '../../../pathfinding/pathfinding';
import {
  canonicalizeProfile,
  isHubProfile,
  type Profile,
} from '../../../entity/profile';
import {
  computeJurisdictionGossipHash,
  decodeJurisdictionGossipAnnouncement,
  jurisdictionGossipScopeIsFull,
  type JurisdictionGossipAnnouncement,
} from '../../../jurisdiction/gossip/announcement';

export interface GossipLayer {
  profiles: Map<string, Profile>;
  jurisdictions: Map<string, JurisdictionGossipAnnouncement>;
  announce: (profile: Profile) => void;
  /** Canonical X25519 binding for a peer: read from its admitted profile. */
  encryptionKeyForRuntime: (runtimeId: string) => string | null;
  announceJurisdiction: (
    announcement: JurisdictionGossipAnnouncement,
    officialFoundationSignerId?: string,
  ) => boolean;
  /** O(1) canonical profile lookup; hot routing must never copy+scan the cache. */
  getProfile: (entityId: string) => Profile | undefined;
  /** O(1) direct transport lookup by authenticated Runtime id. */
  getProfileByRuntimeId: (runtimeId: string) => Profile | undefined;
  getProfiles: () => Profile[];
  getJurisdictions: () => JurisdictionGossipAnnouncement[];
  getHubs: () => Profile[];
  setProfiles?: (incoming: Iterable<Profile>) => void;
  getProfileBundle?: (entityId: string) => { profile?: Profile; peers: Profile[] };
  getNetworkGraph: () => {
    findPaths: (source: string, target: string, amount?: bigint, tokenId?: number) => Promise<PaymentRoute[]>;
  };
}

type GossipLayerOptions = {
  onAnnounce?: (profile: Profile) => void;
  getLiveProfiles?: () => Profile[];
  officialFoundationSignerId?: string;
};

export function createGossipLayer(options: GossipLayerOptions = {}): GossipLayer {
  const profiles = new Map<string, Profile>();
  const jurisdictions = new Map<string, JurisdictionGossipAnnouncement>();
  // runtimeId -> X25519 pub key. One admission path (announce) maintains it;
  // sends resolve peer keys from profiles, never from a transport socket map.
  const runtimeKeys = new Map<string, string>();
  const runtimeProfiles = new Map<string, Map<string, Profile>>();
  const normalizeRuntimeIdKey = (value: string): string => String(value || '').trim().toLowerCase();
  const validX25519Hex = (value: string): boolean => /^0x[0-9a-f]{64}$/.test(value);
  const indexRuntimeKey = (profile: Profile): void => {
    const runtimeId = normalizeRuntimeIdKey(profile.runtimeId || '');
    const key = String((profile as { runtimeEncPubKey?: unknown }).runtimeEncPubKey || '');
    if (runtimeId && validX25519Hex(key)) runtimeKeys.set(runtimeId, key);
  };
  const encryptionKeyForRuntime = (runtimeId: string): string | null =>
    runtimeKeys.get(normalizeRuntimeIdKey(runtimeId)) ?? null;

  const installProfile = (profile: Profile, publish: boolean): void => {
    logDebug('GOSSIP', `📢 gossip.announce INPUT: ${profile.entityId.slice(-4)} accounts=${profile.accounts.length}`);
    const normalized = canonicalizeProfile(profile);
    const existing = profiles.get(normalized.entityId);
    const newTimestamp = normalized.lastUpdated;
    const existingTimestamp = existing?.lastUpdated || 0;
    const shouldUpdate = !existing
      || newTimestamp > existingTimestamp
      || (newTimestamp === existingTimestamp && (
        existing.runtimeId !== normalized.runtimeId
        || existing.entityEncryptionPublicKey !== normalized.entityEncryptionPublicKey
        || existing.accounts.length !== normalized.accounts.length
      ));

    if (!shouldUpdate) {
      logDebug('GOSSIP', `📡 Gossip REJECTED: ${profile.entityId.slice(-4)} ts=${newTimestamp}<=${existingTimestamp}`);
      return;
    }
    if (existing?.runtimeId) {
      const previousRuntimeId = normalizeRuntimeIdKey(existing.runtimeId);
      const previousRuntimeProfiles = runtimeProfiles.get(previousRuntimeId);
      previousRuntimeProfiles?.delete(existing.entityId);
      if (previousRuntimeProfiles?.size === 0) runtimeProfiles.delete(previousRuntimeId);
    }
    profiles.set(normalized.entityId, normalized);
    if (normalized.runtimeId) {
      const runtimeId = normalizeRuntimeIdKey(normalized.runtimeId);
      const byEntity = runtimeProfiles.get(runtimeId) ?? new Map<string, Profile>();
      byEntity.set(normalized.entityId, normalized);
      runtimeProfiles.set(runtimeId, byEntity);
    }
    indexRuntimeKey(normalized);
    logDebug('GOSSIP', `📡 Gossip SAVED: ${profile.entityId.slice(-4)} ts=${newTimestamp} accounts=${normalized.accounts.length}`);
    if (!publish) return;
    try {
      options.onAnnounce?.(normalized);
    } catch (error) {
      console.warn(
        `[GOSSIP] persist callback failed for ${profile.entityId.slice(-8)}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const announce = (profile: Profile): void => installProfile(profile, true);

  const getProfiles = (): Profile[] => Array.from(profiles.values());
  const getProfile = (entityId: string): Profile | undefined =>
    profiles.get(String(entityId || '').trim().toLowerCase());
  const getProfileByRuntimeId = (runtimeId: string): Profile | undefined => {
    const candidates = runtimeProfiles.get(normalizeRuntimeIdKey(runtimeId));
    if (!candidates) return undefined;
    let first: Profile | undefined;
    for (const candidate of candidates.values()) {
      first ??= candidate;
      if (isHubProfile(candidate)) return candidate;
    }
    return first;
  };
  const announceJurisdiction = (
    value: JurisdictionGossipAnnouncement,
    officialFoundationSignerId = options.officialFoundationSignerId,
  ): boolean => {
    const announcement = decodeJurisdictionGossipAnnouncement(value, officialFoundationSignerId);
    const id = computeJurisdictionGossipHash(announcement);
    if (jurisdictions.has(id)) return false;
    if (jurisdictionGossipScopeIsFull(jurisdictions.values(), announcement.scope)) {
      throw new Error('JURISDICTION_GOSSIP_RECORD_CAP_EXCEEDED');
    }
    jurisdictions.set(id, announcement);
    return true;
  };
  const getJurisdictions = (): JurisdictionGossipAnnouncement[] => Array.from(jurisdictions.values());
  const getHubs = (): Profile[] => getProfiles().filter(isHubProfile);
  const getProfileBundle = (entityId: string): { profile?: Profile; peers: Profile[] } => {
    const profile = profiles.get(entityId);
    if (!profile) return { peers: [] };
    const peers = profile.publicAccounts
      .map(id => profiles.get(id))
      .filter((peer): peer is Profile => peer !== undefined);
    return { profile, peers };
  };
  const setProfiles = (incoming: Iterable<Profile>): void => {
    profiles.clear();
    runtimeKeys.clear();
    runtimeProfiles.clear();
    // Snapshot hydration reconstructs the live cache. It must not re-publish
    // every already-durable profile through the external persistence callback.
    for (const profile of incoming) installProfile(profile, false);
  };
  const getNetworkGraph = () => ({
    findPaths: async (source: string, target: string, amount?: bigint, tokenId = 1) => {
      const graphProfiles = new Map(profiles);
      for (const liveProfile of options.getLiveProfiles?.() || []) {
        graphProfiles.set(liveProfile.entityId, canonicalizeProfile(liveProfile));
      }
      const finder = new PathFinder(buildNetworkGraph(graphProfiles, tokenId));
      return finder.findRoutes(source, target, amount ?? 1n, tokenId, 100);
    },
  });

  return {
    profiles,
    jurisdictions,
    announce,
    encryptionKeyForRuntime,
    announceJurisdiction,
    getProfile,
    getProfileByRuntimeId,
    getProfiles,
    getJurisdictions,
    getHubs,
    setProfiles,
    getProfileBundle,
    getNetworkGraph,
  };
}
