import type { AccountPeerInput, RuntimeOverlayRecord } from '../../types/account';
import type { EntityCandidateEffect, EntityOutput, EntityState, HashType } from '../types';
import type { EntityRuntimeContext } from '../runtime-context';
import type { AccountConsensusContext } from '../../account/consensus/context';
import type { JInput } from '../../jurisdiction/machine/input';
import type { EntityTx } from '../../types/entity-tx';
import type {
  AccountJClaimNode,
  AccountJClaimNodeStore,
} from '../../types/account-j-claims';
import type { ConsumptionNode } from '../consumption-accumulator';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from '../tx/handlers/account';
import type { VerifiedCertifiedEntityOutput } from './output-certification';

export type ApplyEntityTxsInOrderContext = {
  env: EntityRuntimeContext;
  accountConsensusContext: AccountConsensusContext;
  entityTxs: EntityTx[];
  currentEntityState: EntityState;
  allOutputs: EntityOutput[];
  allJOutputs: JInput[];
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>;
  proposableAccounts: Set<string>;
  requiredAccountResponses: Map<string, AccountPeerInput>;
  allSwapOffersCreated: SwapOfferEvent[];
  allSwapCancelRequests: SwapCancelRequestEvent[];
  allSwapOffersCancelled: SwapCancelEvent[];
  frameProfileTxTotals: Map<string, { count: number; elapsedMs: number }>;
  consumptionNewNodes: Map<string, ConsumptionNode>;
  consumptionReplacedNodeHashes: Set<string>;
  accountJClaimNewNodes: Map<string, AccountJClaimNode>;
  accountJClaimReplacedNodeHashes: Set<string>;
  accountJClaimNodeStore: AccountJClaimNodeStore;
  candidateEffects: EntityCandidateEffect[];
  storageChanges: RuntimeOverlayRecord[];
  verifiedCertifiedOutputs: Map<
    Extract<EntityTx, { type: 'consensusOutput' }>,
    VerifiedCertifiedEntityOutput
  >;
  authorizedCommand?: true | undefined;
  authorizedCollective?: true | undefined;
  authorizedCertifiedOutput?: true | undefined;
  authorizedRuntimeOutput?: true | undefined;
};
