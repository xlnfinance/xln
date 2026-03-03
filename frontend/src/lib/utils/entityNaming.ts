type GossipProfile = {
  entityId?: string;
  runtimeId?: string;
  metadata?: {
    name?: string;
    isHub?: boolean;
  };
  capabilities?: string[];
};

type GossipSource = {
  gossip?: {
    getProfiles?: () => GossipProfile[];
    profiles?: GossipProfile[];
  };
} | GossipProfile[] | null | undefined;

function normalizeId(value: string): string {
  return String(value || '').toLowerCase();
}

export function getGossipProfiles(source: GossipSource): GossipProfile[] {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (typeof source.gossip?.getProfiles === 'function') {
    return source.gossip.getProfiles();
  }
  if (Array.isArray(source.gossip?.profiles)) {
    return source.gossip.profiles;
  }
  return [];
}

export function getGossipProfile(entityId: string, source: GossipSource): GossipProfile | null {
  const id = normalizeId(entityId);
  if (!id) return null;
  const profiles = getGossipProfiles(source);
  const found = profiles.find((profile) => normalizeId(String(profile?.entityId || '')) === id);
  return found || null;
}

export function resolveEntityName(entityId: string, source: GossipSource): string {
  const profile = getGossipProfile(entityId, source);
  return String(profile?.metadata?.name || '').trim();
}
