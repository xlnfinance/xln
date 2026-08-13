import { getSignerAddress, getSignerPrivateKeyIfAvailable } from '../../../account/crypto';
import type { RuntimeReplica } from '../../../runtime/types';
import { compareStableText } from '../../../protocol/serialization';
import { buildLocalEntityProfile } from './helper';
import { signProfileRuntimeRoute } from '../../../entity/profile/profile-signing';
import { computeProfileHash } from '../../../entity/profile/profile-signing';
import type { EntityReplica } from '../../../entity/types';

const normalize = (value: string): string => value.trim().toLowerCase();

const defaultRouteReplica = (
  env: RuntimeReplica,
  candidates: readonly EntityReplica[],
): EntityReplica | undefined => {
  const defaultSignerId = candidates[0]?.state.config.validators[0];
  if (!defaultSignerId) return undefined;
  const expectedAddress = getSignerAddress(env, defaultSignerId)?.toLowerCase();
  if (!expectedAddress) return undefined;
  return candidates.find(candidate =>
    getSignerAddress(env, candidate.signerId)?.toLowerCase() === expectedAddress
    && getSignerPrivateKeyIfAvailable(env, candidate.signerId) !== null);
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
    const replica = defaultRouteReplica(env, candidates);
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
