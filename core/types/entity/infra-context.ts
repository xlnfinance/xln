import type { Profile } from '../../entity/profile';
import type { HtlcPreparedInfraContext } from './htlc-infra-context';

/**
 * Deterministic, public infrastructure facts committed for one EntityReplica.
 * Private Entity key material must never enter this frame-owned context.
 */
export type EntityInfraContext = Readonly<{
  version: 1;
  proposerReplicaId: string;
  entityId: string;
  proposerSignerId: string;
  parentFrameHash: string;
  height: number;
  gossipProfiles: Profile[];
  /** Unverified proposer liveness assertions for exactly the referenced peers. */
  peerAssertions: ReadonlyArray<Readonly<{
    entityId: string;
    online: boolean;
  }>>;
  htlc: HtlcPreparedInfraContext;
}>;
