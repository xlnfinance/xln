import { getSignerAddress, getSignerPrivateKeyIfAvailable } from '../../../account/crypto';
import type { RuntimeReplica } from '../../../runtime/types';
import { compareStableText } from '../../../protocol/serialization';
import { buildLocalEntityProfile } from './helper';
import {
  computeProfileHash,
  hasCurrentProfileBoardAuthority,
  signProfileRuntimeRoute,
} from '../../../entity/profile/profile-signing';
import type { EntityReplica } from '../../../entity/types';

const normalize = (value: string): string => value.trim().toLowerCase();

export const hasCurrentBoardProfileRouteAuthority = async (
  env: RuntimeReplica,
  replica: EntityReplica,
  signerId: string,
): Promise<boolean> => {
  const defaultSignerId = replica.state.config.validators[0];
  if (!defaultSignerId) return false;
  const expectedAddress = getSignerAddress(env, defaultSignerId)?.toLowerCase();
  if (!expectedAddress || getSignerAddress(env, signerId)?.toLowerCase() !== expectedAddress) return false;
  if (getSignerPrivateKeyIfAvailable(env, signerId) === null) return false;
  return hasCurrentProfileBoardAuthority(env, replica.state);
};

const defaultRouteReplica = async (
  env: RuntimeReplica,
  candidates: readonly EntityReplica[],
): Promise<EntityReplica | undefined> => {
  for (const candidate of candidates) {
    if (await hasCurrentBoardProfileRouteAuthority(env, candidate, candidate.signerId)) return candidate;
  }
  return undefined;
};

/** Publish the EntityState-owned public key through one signed gossip route. */
export const announceCertifiedLocalProfiles = async (
  env: RuntimeReplica,
  entityIds: readonly string[],
): Promise<number> => {
  let announced = 0;
  for (const entityId of [...new Set(entityIds.map(normalize))].sort(compareStableText)) {
    const candidates = [...env.state.eReplicas.values()]
      .filter(candidate => normalize(candidate.entityId) === entityId)
      .sort((left, right) => compareStableText(left.signerId, right.signerId));
    const replica = await defaultRouteReplica(env, candidates);
    if (!replica) continue;
    const profile = buildLocalEntityProfile(env, replica.state);
    const certification = replica.hankoWitness?.get(computeProfileHash(profile));
    if (!certification || certification.type !== 'profile') continue;
    profile.metadata.profileHanko = certification.hanko;
    env.gossip.announce(await signProfileRuntimeRoute(env, profile, replica.signerId));
    announced += 1;
  }
  return announced;
};
