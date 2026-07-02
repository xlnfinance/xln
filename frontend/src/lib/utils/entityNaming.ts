import type { Profile as GossipProfile } from '@xln/runtime/xln-api';
import { formatEntityId } from './format';

type GossipSource = {
  gossip?: {
    getProfiles?: () => GossipProfile[];
    profiles?: GossipProfile[] | Map<string, GossipProfile>;
  };
} | GossipProfile[] | null | undefined;

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

export function getGossipProfiles(source: GossipSource): GossipProfile[] {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (typeof source.gossip?.getProfiles === 'function') {
    return source.gossip.getProfiles();
  }
  if (source.gossip?.profiles instanceof Map) {
    return Array.from(source.gossip.profiles.values());
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
  return profiles.find((profile) => normalizeId(profile.entityId) === id) || null;
}

export function sanitizeEntityDisplayName(value: string): string {
  return String(value || '')
    .replace(/\s*\((?:local\s+)?anvil\)\s*/gi, ' ')
    .replace(/\s+local\s+anvil\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function resolveEntityName(entityId: string, source: GossipSource): string {
  const profile = getGossipProfile(entityId, source);
  return profile ? sanitizeEntityDisplayName(profile.name) : '';
}

type EntityNameOptions = {
  source: GossipSource;
  selfEntityId?: string | null;
  selfLabel?: string;
  fallback?: string;
};

export function getEntityDisplayName(entityId: string, options: EntityNameOptions): string {
  const raw = String(entityId || '').trim();
  if (!raw) return options.fallback || 'Unknown';
  const normalized = normalizeId(raw);

  const selfEntityId = String(options.selfEntityId || '').trim();
  if (selfEntityId && normalized === normalizeId(selfEntityId)) {
    return options.selfLabel || 'You';
  }

  const resolved = resolveEntityName(raw, options.source).trim();
  if (resolved) return resolved;
  return formatEntityId(raw);
}
