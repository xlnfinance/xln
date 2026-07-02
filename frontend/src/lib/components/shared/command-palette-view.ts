import { compareStableText } from '$lib/utils/stableSort';
import type { RuntimeAdapterViewFrame } from '@xln/runtime/xln-api';

export type CommandPaletteEntity = {
  id: string;
  name: string;
  isHub: boolean;
};

export type CommandPaletteView = {
  entities: CommandPaletteEntity[];
};

export const emptyCommandPaletteView = (): CommandPaletteView => ({
  entities: [],
});

type EnvLike = {
  gossip?: {
    getProfiles?: () => unknown[];
    validatedProfiles?: unknown;
    profiles?: unknown;
  };
  eReplicas?: unknown;
};

const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
const readRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

function addEntity(
  entities: CommandPaletteEntity[],
  seen: Set<string>,
  input: { id: unknown; name: unknown; isHub?: unknown },
): void {
  const id = normalizeEntityId(input.id);
  const name = String(input.name || '').trim();
  if (!id || !name || seen.has(id)) return;
  seen.add(id);
  entities.push({ id, name, isHub: input.isHub === true });
}

function readProfiles(gossip: EnvLike['gossip']): unknown[] {
  if (!gossip) return [];
  if (typeof gossip.getProfiles === 'function') return gossip.getProfiles();
  const profiles = gossip.validatedProfiles ?? gossip.profiles;
  if (profiles instanceof Map) return Array.from(profiles.values());
  if (Array.isArray(profiles)) return profiles;
  return [];
}

export function buildCommandPaletteView(env: EnvLike | null | undefined): CommandPaletteView {
  const entities: CommandPaletteEntity[] = [];
  const seen = new Set<string>();

  for (const profileRaw of readProfiles(env?.gossip)) {
    const profile = readRecord(profileRaw);
    const metadata = readRecord(profile['metadata']);
    addEntity(entities, seen, {
      id: profile['entityId'],
      name: profile['name'] || metadata['name'],
      isHub: metadata['isHub'],
    });
  }

  if (env?.eReplicas instanceof Map) {
    for (const [key, replicaRaw] of env.eReplicas.entries()) {
      const state = readRecord(readRecord(replicaRaw)['state']);
      const profile = readRecord(state['profile']);
      const metadata = readRecord(profile['metadata']);
      const id = normalizeEntityId(String(key).split(':')[0]);
      addEntity(entities, seen, {
        id,
        name: profile['name'] || metadata['name'] || state['entityId'] || id.slice(0, 8),
        isHub: false,
      });
    }
  }

  entities.sort((a, b) => compareStableText(a.name, b.name));
  return { entities };
}

export function buildCommandPaletteViewFromRuntimeView(
  frame: RuntimeAdapterViewFrame | null | undefined,
): CommandPaletteView {
  const entities: CommandPaletteEntity[] = [];
  const seen = new Set<string>();

  for (const summary of frame?.entities ?? []) {
    addEntity(entities, seen, {
      id: summary.entityId,
      name: summary.label || String(summary.entityId || '').slice(0, 8),
      isHub: summary.isHub,
    });
  }

  const active = frame?.activeEntity;
  if (active) {
    const core = readRecord(active.core);
    const profile = readRecord(core['profile']);
    addEntity(entities, seen, {
      id: active.summary?.entityId || core['entityId'] || frame?.activeEntityId,
      name: profile['name'] || active.summary?.label || core['entityId'],
      isHub: active.summary?.isHub === true || profile['isHub'] === true || Boolean(core['orderbookHubProfile']),
    });
  }

  entities.sort((a, b) => compareStableText(a.name, b.name));
  return { entities };
}

export function findCommandPaletteEntities(
  query: string,
  view: CommandPaletteView,
): CommandPaletteEntity[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const results = view.entities.filter((entity) =>
    entity.name.toLowerCase().includes(normalized) || entity.id.includes(normalized),
  );
  results.sort((a, b) => {
    const aPrefix = a.name.toLowerCase().startsWith(normalized) ? 0 : 1;
    const bPrefix = b.name.toLowerCase().startsWith(normalized) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    return compareStableText(a.name, b.name);
  });
  return results;
}
