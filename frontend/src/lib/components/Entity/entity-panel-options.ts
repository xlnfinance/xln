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

export function normalizeWorkspaceAccountId(raw: string, workspaceAccountIds: readonly string[]): string {
  const nextRaw = String(raw || '').trim();
  const matched = workspaceAccountIds.find((id) => String(id).toLowerCase() === nextRaw.toLowerCase());
  return matched || nextRaw;
}

export function buildMoveHubEntityOptions(input: {
  targetEntityId: string;
  selfEntityId: string;
  workspaceAccountIds: readonly string[];
  profiles: ReadonlyArray<{
    entityId?: string;
    accounts?: readonly { counterpartyId?: unknown }[];
  }>;
}): string[] {
  const ids = new Map<string, string>();
  const recipientEntityId = String(input.targetEntityId || input.selfEntityId || '').trim().toLowerCase();
  const selfEntityId = String(input.selfEntityId || '').trim().toLowerCase();
  const recipientProfile = input.profiles.find(
    (profile) => String(profile.entityId || '').trim().toLowerCase() === recipientEntityId,
  );
  for (const account of Array.isArray(recipientProfile?.accounts) ? recipientProfile.accounts : []) {
    addFullEntityId(ids, account?.counterpartyId);
  }
  if (recipientEntityId === selfEntityId) {
    for (const id of input.workspaceAccountIds) addFullEntityId(ids, id);
  }
  return Array.from(ids.values()).sort();
}

export function resolveMoveTargetHubEntityId(input: {
  currentTargetHubId: string;
  workspaceAccountId: string;
  options: readonly string[];
  manualOverride: boolean;
}): string {
  const normalizedTargetHub = String(input.currentTargetHubId || '').trim().toLowerCase();
  if (!normalizedTargetHub) return input.workspaceAccountId || input.options[0] || '';
  if (!input.manualOverride && input.options.length > 0 && !input.options.includes(normalizedTargetHub)) {
    return input.workspaceAccountId && input.options.includes(input.workspaceAccountId)
      ? input.workspaceAccountId
      : input.options[0] || '';
  }
  return normalizedTargetHub;
}

export function buildConfigureTokenOptions(input: {
  reserveTokenIds: Iterable<unknown>;
  getTokenInfo: (tokenId: number) => { symbol?: string };
  compareSymbols: (left: string, right: string) => number;
}): Array<{ id: number; symbol: string }> {
  const ids = new Set<number>([1, 2, 3]);
  for (const tokenId of input.reserveTokenIds) {
    const numericId = Number(tokenId);
    if (Number.isFinite(numericId) && numericId > 0) ids.add(numericId);
  }
  return Array.from(ids).sort((leftId, rightId) => {
    const leftInfo = input.getTokenInfo(leftId);
    const rightInfo = input.getTokenInfo(rightId);
    return input.compareSymbols(leftInfo.symbol || `TKN${leftId}`, rightInfo.symbol || `TKN${rightId}`);
  }).map((id) => {
    const info = input.getTokenInfo(id);
    return { id, symbol: info.symbol || `TKN${id}` };
  });
}

export function resolveConfigureTokenId(
  currentTokenId: number,
  options: readonly { id: number }[],
  fallbackTokenId = 1,
): number {
  return options.some((opt) => opt.id === currentTokenId)
    ? currentTokenId
    : options[0]?.id ?? fallbackTokenId;
}
