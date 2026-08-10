import type { CliSession } from './session';

export const ensureCliProfiles = async (
  session: CliSession,
  entityIds: readonly string[],
  context: string,
): Promise<void> => {
  const p2p = session.env.infrastructure?.p2p;
  if (typeof p2p?.ensureProfiles !== 'function') {
    throw new Error(`${context}_PROFILE_TRANSPORT_UNAVAILABLE`);
  }
  const targets = Array.from(new Set(entityIds.map(id => id.toLowerCase()).filter(Boolean)));
  if (!(await p2p.ensureProfiles(targets))) {
    throw new Error(`${context}_PROFILES_UNAVAILABLE:${targets.join(',')}`);
  }
};
