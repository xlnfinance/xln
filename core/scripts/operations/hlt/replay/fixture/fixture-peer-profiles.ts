/**
 * Canonical gossip profile publication for RAM-only fixture peers.
 *
 * Each bare peer profile is built from its signing EntityState, certified with
 * a real profile Hanko from the peer's registered signer key, runtime-route
 * signed, and verified against the H1 observer before installation. No route
 * map entry is ever injected without a passing verifyProfileSignature.
 */

import {
  computeProfileHash,
  signProfileRuntimeRoute,
  verifyProfileSignature,
} from '../../../../../entity/profile/profile-signing';
import type { Profile } from '../../../../../entity/profile';
import type { EntityState } from '../../../../../entity/types';
import { signEntityHashes } from '../../../../../hanko/signing';
import { buildLocalEntityProfile } from '../../../../../network/p2p/gossip/helper';
import type { ManagedEntityIdentity } from '../../../../../orchestrator/daemon-control';
import type { RuntimeReplica } from '../../../../../runtime/types';

export type PeerProfileSource = Readonly<{
  identity: ManagedEntityIdentity;
  state: EntityState;
}>;

export const installVerifiedPeerProfiles = async (args: Readonly<{
  main: () => RuntimeReplica;
  signingEnv: RuntimeReplica;
  peers: readonly PeerProfileSource[];
  timestamp: number;
}>): Promise<void> => {
  const verified: Array<{ profile: Profile; signerId: string }> = [];
  for (const peer of args.peers) {
    const profile = buildLocalEntityProfile(args.signingEnv, peer.state, args.timestamp);
    if (profile.entityId.toLowerCase() !== peer.identity.entityId.toLowerCase()) {
      throw new Error(`FIXTURE_PROFILE_ENTITY_MISMATCH:${profile.entityId}:${peer.identity.entityId}`);
    }
    const hankos = await signEntityHashes(
      args.signingEnv, peer.identity.entityId, peer.identity.signerId, [computeProfileHash(profile)],
    );
    const hanko = hankos[0];
    if (!hanko) throw new Error(`FIXTURE_PROFILE_HANKO_MISSING:${peer.identity.entityId}`);
    profile.metadata.profileHanko = hanko;
    const routed = await signProfileRuntimeRoute(args.signingEnv, profile, peer.identity.signerId);
    const verification = await verifyProfileSignature(routed, args.main());
    if (!verification.valid || !verification.signerId) {
      throw new Error(`FIXTURE_PROFILE_VERIFY_FAILED:${peer.identity.entityId}:${verification.reason ?? 'invalid'}`);
    }
    if (verification.signerId.toLowerCase() !== peer.identity.signerId.toLowerCase()) {
      throw new Error(`FIXTURE_PROFILE_SIGNER_MISMATCH:${peer.identity.entityId}:${verification.signerId}`);
    }
    verified.push({ profile: routed, signerId: verification.signerId });
  }
  const observer = args.main();
  if (!observer.gossip.setProfiles) throw new Error('FIXTURE_PROFILE_GOSSIP_SET_PROFILES_MISSING');
  observer.gossip.setProfiles(verified.map(entry => entry.profile));
  observer.infrastructure ??= {};
  observer.infrastructure.verifiedProfileRoutes ??= new Map();
  for (const { profile, signerId } of verified) {
    observer.infrastructure.verifiedProfileRoutes.set(profile.entityId.toLowerCase(), {
      runtimeId: profile.runtimeId.toLowerCase(),
      runtimeSignerId: signerId.toLowerCase(),
      runtimeEncPubKey: profile.runtimeEncPubKey,
      lastUpdated: profile.lastUpdated,
    });
  }
};
