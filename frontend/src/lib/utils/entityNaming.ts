import { get } from 'svelte/store';
import type { Profile as GossipProfile } from '@xln/runtime/xln-api';
import type { Env } from '@xln/runtime/xln-api';
import { getXLN, xlnEnvironment } from '../stores/xlnStore';
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

const ENTITY_ID_RE = /^0x[0-9a-f]{64}$/;
const PROFILE_FETCH_THROTTLE_MS = 1000;
const PROFILE_FETCH_BATCH_DELAY_MS = 20;
const scheduledProfileFetchIds = new Set<string>();
const lastProfileFetchAt = new Map<string, number>();
let scheduledProfileFetchTimer: ReturnType<typeof setTimeout> | null = null;

const flushScheduledProfileFetches = async (): Promise<void> => {
  scheduledProfileFetchTimer = null;
  const entityIds = Array.from(scheduledProfileFetchIds);
  scheduledProfileFetchIds.clear();
  if (entityIds.length === 0) return;
  const env: Env | null = get(xlnEnvironment);
  if (!env) return;
  try {
    const xln = await getXLN();
    await xln.ensureGossipProfiles?.(env, entityIds);
  } catch {
    // best effort only
  }
};

export function scheduleGossipProfileFetch(entityIds: string[]): void {
  const now = Date.now();
  let queued = false;
  for (const rawEntityId of entityIds) {
    const entityId = normalizeId(rawEntityId);
    if (!ENTITY_ID_RE.test(entityId)) continue;
    const lastFetchAt = lastProfileFetchAt.get(entityId) ?? 0;
    if (now - lastFetchAt < PROFILE_FETCH_THROTTLE_MS) continue;
    lastProfileFetchAt.set(entityId, now);
    scheduledProfileFetchIds.add(entityId);
    queued = true;
  }
  if (!queued || scheduledProfileFetchTimer) return;
  scheduledProfileFetchTimer = setTimeout(() => {
    void flushScheduledProfileFetches();
  }, PROFILE_FETCH_BATCH_DELAY_MS);
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
  const found = profiles.find((profile) => normalizeId(profile.entityId) === id);
  if (!found) {
    scheduleGossipProfileFetch([id]);
  }
  return found || null;
}

export function resolveEntityName(entityId: string, source: GossipSource): string {
  const profile = getGossipProfile(entityId, source);
  return profile ? profile.name.trim() : '';
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
