import { getSignerPrivateKeyIfAvailable } from '../../../account/crypto';
import type { RuntimeReplica } from '../../../runtime/types';
import { compareStableText } from '../../../protocol/serialization';
import { buildLocalEntityProfile } from './helper';
import { signProfileRuntimeRoute } from '../../../entity/profile/profile-signing';
import { computeProfileHash } from '../../../entity/profile/profile-signing';

const normalize = (value: string): string => value.trim().toLowerCase();

/** Publish the EntityState-owned public key through one signed gossip route. */
export const announceCertifiedLocalProfiles = async (
  env: RuntimeReplica,
  entityIds: readonly string[],
): Promise<number> => {
  let announced = 0;
  for (const entityId of [...new Set(entityIds.map(normalize))].sort(compareStableText)) {
    const replica = [...env.state.eReplicas.values()]
      .filter(candidate => normalize(candidate.entityId) === entityId)
      .filter(candidate => getSignerPrivateKeyIfAvailable(env, candidate.signerId) !== null)
      .sort((left, right) => compareStableText(left.signerId, right.signerId))[0];
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
