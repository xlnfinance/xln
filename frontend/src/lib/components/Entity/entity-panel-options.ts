import type { Profile as GossipProfile } from '@xln/runtime/xln-api';
import type { EntityReplica } from '$lib/types/ui';

export function isFullEntityId(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || '').trim());
}

function addFullEntityId(ids: Map<string, string>, candidate: unknown): void {
  const raw = String(candidate || '').trim();
  if (!isFullEntityId(raw)) return;
  const normalized = raw.toLowerCase();
  if (!ids.has(normalized)) ids.set(normalized, normalized);
}

export function buildOpenAccountEntityOptions(input: {
  replica: EntityReplica | null | undefined;
  tabEntityId: string;
  accountIds: readonly string[];
  activeReplicas: Map<string, EntityReplica> | null | undefined;
  profiles: readonly Pick<GossipProfile, 'entityId'>[];
}): string[] {
  const ids = new Map<string, string>();
  const selfId = String(input.replica?.state?.entityId || input.tabEntityId || '').trim().toLowerCase();
  const existingAccountIds = new Set(input.accountIds.map((id) => String(id || '').trim().toLowerCase()));
  const add = (candidate: unknown) => {
    const raw = String(candidate || '').trim();
    if (!isFullEntityId(raw)) return;
    const normalized = raw.toLowerCase();
    if (!normalized || normalized === selfId || existingAccountIds.has(normalized)) return;
    if (!ids.has(normalized)) ids.set(normalized, normalized);
  };

  for (const key of input.activeReplicas?.keys?.() || []) add(String(key).split(':')[0]);
  for (const profile of input.profiles) add(profile.entityId);
  return Array.from(ids.values()).sort();
}

export function buildMoveEntityOptions(input: {
  replica: EntityReplica | null | undefined;
  tabEntityId: string;
  accountIds: readonly string[];
  openAccountEntityOptions: readonly string[];
  activeReplicas: Map<string, EntityReplica> | null | undefined;
  profiles: readonly Pick<GossipProfile, 'entityId'>[];
}): string[] {
  const ids = new Map<string, string>();
  const selfId = String(input.replica?.state?.entityId || input.tabEntityId || '').trim().toLowerCase();

  if (selfId) addFullEntityId(ids, selfId);
  for (const id of input.accountIds) addFullEntityId(ids, id);
  for (const id of input.openAccountEntityOptions) addFullEntityId(ids, id);
  for (const key of input.activeReplicas?.keys?.() || []) addFullEntityId(ids, String(key).split(':')[0]);
  for (const profile of input.profiles) addFullEntityId(ids, profile.entityId);
  return Array.from(ids.values());
}

export function buildMoveSourceAccountOptions(input: {
  workspaceAccountIds: readonly string[];
  accountIds: readonly string[];
}): string[] {
  const ordered = new Map<string, string>();
  for (const id of input.workspaceAccountIds) {
    const normalized = String(id || '').trim().toLowerCase();
    if (normalized && !ordered.has(normalized)) ordered.set(normalized, normalized);
  }
  for (const id of input.accountIds) {
    const normalized = String(id || '').trim().toLowerCase();
    if (normalized && !ordered.has(normalized)) ordered.set(normalized, normalized);
  }
  return Array.from(ordered.values());
}
