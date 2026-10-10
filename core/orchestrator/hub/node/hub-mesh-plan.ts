import { defaultAccountDisputeConfigForRoleEvidence } from '../../../account/config/dispute-config';
import { committedAccountRoleEvidence } from '../../../account/config/role-evidence';
import type { EntityInput } from '../../../entity/types';
import { getJurisdictionIdentityRef } from '../../../jurisdiction/machine/jurisdiction-runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import type { ConfiguredPeerIdentity, HubMeshPeer } from '../../mesh/hub-mesh-peers';
import {
  DEFAULT_ACCOUNT_TOKEN_IDS,
  getAccountReplica,
  getBootstrapCreditAmount,
  getCreditGrantedByEntity,
  getEntityReplicaById,
  HUB_MESH_TOKEN_ID,
  hasAccount,
  hasPairMutualCredits,
  hasQueuedOpenAccount,
} from '../../mesh/mesh-common';
import type { VisibleHubProfile } from '../hub-visible-profiles';
import type { HubBootstrapEntry, HubPairHealth } from './hub-node-types';
import { tokenIdsForHubJurisdiction } from './token-catalog';

const sameJurisdictionRef = (left: unknown, right: unknown): boolean => {
  const leftRef = getJurisdictionIdentityRef(left);
  const rightRef = getJurisdictionIdentityRef(right);
  return Boolean(leftRef && rightRef && leftRef === rightRef);
};

const configuredSupportPeers = (
  identities: ConfiguredPeerIdentity[],
  selfEntityId: string,
  jurisdiction: unknown,
): ConfiguredPeerIdentity[] => identities.filter(identity =>
  identity.entityId.toLowerCase() !== selfEntityId.toLowerCase() &&
  sameJurisdictionRef(identity, jurisdiction),
);

type HubMeshInputPlan = {
  openInputs: EntityInput[];
  creditInputs: EntityInput[];
};

const planSupportAccountSetupInputs = (
  env: RuntimeReplica,
  owner: Pick<
    HubBootstrapEntry,
    'entityId' | 'signerId' | 'jurisdictionName' | 'chainId' | 'depositoryAddress'
  >,
  supportPeerIdentities: ConfiguredPeerIdentity[],
): HubMeshInputPlan => {
  const creditInputs: EntityInput[] = [];
  const tokenIds = tokenIdsForHubJurisdiction(owner);
  // The configured identity selects the managed peer; the committed Account is
  // the financial authority. Gossip is discovery only and must not gate credit.
  const peers = configuredSupportPeers(
    supportPeerIdentities,
    owner.entityId,
    owner,
  );
  for (const peer of peers) {
    const account = getAccountReplica(env, owner.entityId, peer.entityId);
    const canWrite =
      !account?.pendingFrame && Number(account?.mempool?.length || 0) === 0;
    // Managed MM identities exclusively open their Accounts and therefore own
    // the genesis watchSeed. The Hub only grants reciprocal credit after the
    // allowlisted Account exists; this prevents two competing H=1 frames.
    if (!account || !canWrite) continue;
    const missingTokenIds = tokenIds.filter(
      tokenId =>
        getCreditGrantedByEntity(account, owner.entityId, tokenId) <
        getBootstrapCreditAmount(tokenId),
    );
    if (missingTokenIds.length === 0) continue;
    creditInputs.push({
      entityId: owner.entityId,
      signerId: owner.signerId,
      entityTxs: missingTokenIds.map(tokenId => ({
        type: 'extendCredit' as const,
        data: {
          counterpartyEntityId: peer.entityId,
          tokenId,
          amount: getBootstrapCreditAmount(tokenId),
        },
      })),
    });
  }
  return { openInputs: [], creditInputs };
};

const planHubAccountSetupInputs = (
  env: RuntimeReplica,
  bootstrap: Pick<HubBootstrapEntry, 'entityId' | 'signerId'>,
  ownerIndex: number,
  meshPeers: HubMeshPeer<VisibleHubProfile>[],
): HubMeshInputPlan => {
  const openInputs: EntityInput[] = [];
  const creditInputs: EntityInput[] = [];
  const ownerReplica = getEntityReplicaById(env, bootstrap.entityId);
  if (!ownerReplica) throw new Error(`HUB_PEER_OWNER_ROLE_COMMITTED_MISSING:${bootstrap.entityId}`);
  const ownerRole = committedAccountRoleEvidence(
    bootstrap.entityId,
    ownerReplica.state.profile.isHub === true,
  );
  for (const { profile: peer, meshIndex } of meshPeers) {
    const account = getAccountReplica(env, bootstrap.entityId, peer.entityId);
    const canWrite =
      !account?.pendingFrame && Number(account?.mempool?.length || 0) === 0;
    if (
      // The configured mesh order owns every genesis: H2/H3 open toward H1 and H3
      // opens toward H2. H3 may propose both independent Accounts in one
      // Entity/Runtime frame; only reciprocal credit waits for their ACKs.
      ownerIndex > meshIndex &&
      !hasAccount(env, bootstrap.entityId, peer.entityId) &&
      !hasQueuedOpenAccount(env, bootstrap.entityId, peer.entityId) &&
      canWrite
    ) {
      openInputs.push({
        entityId: bootstrap.entityId,
        signerId: bootstrap.signerId,
        entityTxs: [
          {
            type: 'openAccount',
            data: {
              targetEntityId: peer.entityId,
              disputeConfig: defaultAccountDisputeConfigForRoleEvidence(
                ownerRole,
                peer.roleEvidence,
                new Map([[ownerRole.entityId, ownerRole.isHub]]),
              ),
              tokenId: HUB_MESH_TOKEN_ID,
              creditAmount: getBootstrapCreditAmount(HUB_MESH_TOKEN_ID),
            },
          },
          ...DEFAULT_ACCOUNT_TOKEN_IDS.slice(1).map(tokenId => ({
            type: 'extendCredit' as const,
            data: {
              counterpartyEntityId: peer.entityId,
              tokenId,
              amount: getBootstrapCreditAmount(tokenId),
            },
          })),
        ],
      });
    }
    if (!account || !canWrite) continue;
    const missingTokenIds = DEFAULT_ACCOUNT_TOKEN_IDS.filter(
      tokenId =>
        getCreditGrantedByEntity(account, bootstrap.entityId, tokenId) <
        getBootstrapCreditAmount(tokenId),
    );
    if (missingTokenIds.length === 0) continue;
    creditInputs.push({
      entityId: bootstrap.entityId,
      signerId: bootstrap.signerId,
      entityTxs: missingTokenIds.map(tokenId => ({
        type: 'extendCredit' as const,
        data: {
          counterpartyEntityId: peer.entityId,
          tokenId,
          amount: getBootstrapCreditAmount(tokenId),
        },
      })),
    });
  }
  return { openInputs, creditInputs };
};

export const planMeshBootstrapInputs = (
  env: RuntimeReplica,
  bootstrap: Pick<HubBootstrapEntry, 'entityId' | 'signerId'>,
  hubBootstraps: HubBootstrapEntry[],
  ownerIndex: number,
  peers: HubMeshPeer<VisibleHubProfile>[],
  supportPeerIdentities: ConfiguredPeerIdentity[],
): HubMeshInputPlan => {
  const plans = [
    planHubAccountSetupInputs(env, bootstrap, ownerIndex, peers),
    ...hubBootstraps.map(owner =>
      planSupportAccountSetupInputs(
        env,
        owner,
        supportPeerIdentities,
      ),
    ),
  ];
  return {
    openInputs: plans.flatMap(plan => plan.openInputs),
    creditInputs: plans.flatMap(plan => plan.creditInputs),
  };
};

export const supportPeerProvisioningReady = (
  env: RuntimeReplica,
  hubBootstraps: HubBootstrapEntry[],
  identities: ConfiguredPeerIdentity[],
): boolean => hubBootstraps.every(owner => {
  const peers = configuredSupportPeers(identities, owner.entityId, owner);
  const tokenIds = tokenIdsForHubJurisdiction(owner);
  return peers.every(peer => {
    const account = getAccountReplica(env, owner.entityId, peer.entityId);
    if (!account || account.pendingFrame || account.mempool.length > 0) return false;
    return tokenIds.every(tokenId =>
      getCreditGrantedByEntity(account, owner.entityId, tokenId) >=
      getBootstrapCreditAmount(tokenId),
    );
  });
});

export const buildPairHealth = (env: RuntimeReplica, selfEntityId: string, peers: Array<{ name: string; entityId: string }>): HubPairHealth[] => {
  return peers.map(peer => {
    const account = getAccountReplica(env, selfEntityId, peer.entityId);
    const grantedByMe = account ? getCreditGrantedByEntity(account, selfEntityId, HUB_MESH_TOKEN_ID) : 0n;
    const grantedByPeer = account ? getCreditGrantedByEntity(account, peer.entityId, HUB_MESH_TOKEN_ID) : 0n;
    return {
      counterpartyId: peer.entityId,
      counterpartyName: peer.name,
      hasAccount: hasAccount(env, selfEntityId, peer.entityId),
      currentHeight: Number(account?.currentHeight ?? 0),
      pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height) : null,
      pendingFrameHash: account?.pendingFrame?.stateHash ?? null,
      grantedByMe: grantedByMe.toString(),
      grantedByPeer: grantedByPeer.toString(),
      ready: hasPairMutualCredits(env, selfEntityId, peer.entityId, DEFAULT_ACCOUNT_TOKEN_IDS, getBootstrapCreditAmount),
    };
  });
};
