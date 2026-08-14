/**
 * Process-local profile dissemination and route discovery.
 *
 * Profile schema, canonicalization and certification belong to Entity and are
 * imported here. Networking owns only the live cache and transport-facing
 * graph. This direction keeps deterministic Entity admission independent from
 * process-local networking.
 */
import { logDebug } from '../../../infra/logger';
import { buildNetworkGraph } from '../../../routing/graph';
import { PathFinder, type PaymentRoute } from '../../../routing/pathfinding';
import {
  canonicalizeProfile,
  isHubProfile,
  type Profile,
} from '../../../entity/profile';
import {
  computeJurisdictionGossipHash,
  decodeJurisdictionGossipAnnouncement,
  MAX_JURISDICTION_GOSSIP_RECORDS,
  type JurisdictionGossipAnnouncement,
} from '../../../jurisdiction/gossip/announcement';

export interface GossipLayer {
  profiles: Map<string, Profile>;
  jurisdictions: Map<string, JurisdictionGossipAnnouncement>;
  announce: (profile: Profile) => void;
  announceJurisdiction: (
    announcement: JurisdictionGossipAnnouncement,
    officialFoundationSignerId?: string,
  ) => boolean;
  getProfiles: () => Profile[];
  getJurisdictions: () => JurisdictionGossipAnnouncement[];
  getHubs: () => Profile[];
  setProfiles?: (incoming: Iterable<Profile>) => void;
  setJurisdictions?: (
    incoming: Iterable<JurisdictionGossipAnnouncement>,
    officialFoundationSignerId?: string,
  ) => void;
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

  const announce = (profile: Profile): void => {
    logDebug('GOSSIP', `📢 gossip.announce INPUT: ${profile.entityId.slice(-4)} accounts=${profile.accounts.length}`);
    const existing = profiles.get(profile.entityId);
    const normalized = canonicalizeProfile(profile);
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
    profiles.set(profile.entityId, normalized);
    logDebug('GOSSIP', `📡 Gossip SAVED: ${profile.entityId.slice(-4)} ts=${newTimestamp} accounts=${normalized.accounts.length}`);
    try {
      options.onAnnounce?.(normalized);
    } catch (error) {
      console.warn(
        `[GOSSIP] persist callback failed for ${profile.entityId.slice(-8)}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const getProfiles = (): Profile[] => Array.from(profiles.values());
  const announceJurisdiction = (
    value: JurisdictionGossipAnnouncement,
    officialFoundationSignerId = options.officialFoundationSignerId,
  ): boolean => {
    const announcement = decodeJurisdictionGossipAnnouncement(value, officialFoundationSignerId);
    const id = computeJurisdictionGossipHash(announcement);
    if (jurisdictions.has(id)) return false;
    if (jurisdictions.size >= MAX_JURISDICTION_GOSSIP_RECORDS) {
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
    for (const profile of incoming) announce(profile);
  };
  const setJurisdictions = (
    incoming: Iterable<JurisdictionGossipAnnouncement>,
    officialFoundationSignerId = options.officialFoundationSignerId,
  ): void => {
    jurisdictions.clear();
    for (const announcement of incoming) announceJurisdiction(announcement, officialFoundationSignerId);
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
    announceJurisdiction,
    getProfiles,
    getJurisdictions,
    getHubs,
    setProfiles,
    setJurisdictions,
    getProfileBundle,
    getNetworkGraph,
  };
}
