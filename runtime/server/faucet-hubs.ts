import type { Env } from '../types';
import type { Profile } from '../networking/gossip';

export const getFaucetHubProfiles = (env: Env, activeHubEntityIds: string[]): Profile[] => {
  const activeSet = new Set(activeHubEntityIds.map(id => id.toLowerCase()));
  const selected: Profile[] = [];
  for (const profile of env.gossip?.getProfiles?.() || []) {
    const entityId = String(profile?.entityId || '').toLowerCase();
    if (profile.metadata.isHub !== true || !activeSet.has(entityId)) continue;
    selected.push(profile);
  }
  selected.sort((a, b) => {
    const aActive = activeSet.has(String(a?.entityId || '').toLowerCase()) ? 1 : 0;
    const bActive = activeSet.has(String(b?.entityId || '').toLowerCase()) ? 1 : 0;
    return bActive - aActive;
  });
  return selected;
};
