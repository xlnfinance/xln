import type { AccountPeerInput, RuntimeOverlayRecord } from '../../../types/account';
import type { EntityCandidateEffect, EntityOutput, EntityState, HashType } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { AccountConsensusContext } from '../../../account/consensus/context';
import type { JInput } from '../../../jurisdiction/machine/input';
import type { EntityTx } from '../../../types/entity-tx';
import type {
  AccountJClaimNode,
  AccountJClaimNodeStore,
} from '../../../types/finance/account-j-claims';
import type {
  SwapCancelEvent,
  SwapCancelRequestEvent,
  SwapOfferEvent,
} from '../../tx/handlers/account';
import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { PreparedHtlcEntry } from '../../../types/entity/htlc-infra-context';
import type { ProposableAccountMap } from '../account/canonical-worklist';

export type ApplyEntityTxsInOrderContext = {
  env: EntityRuntimeContext;
  entityContext: EntityInfraContext;
  /** Frame-local O(1) view over the already validated HTLC infra entries. */
  preparedHtlcEntriesByBinding: ReadonlyMap<string, PreparedHtlcEntry>;
  accountConsensusContext: AccountConsensusContext;
  entityTxs: EntityTx[];
  currentEntityState: EntityState;
  allOutputs: EntityOutput[];
  allJOutputs: JInput[];
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>;
  collectedHashManifest: Map<string, { type: HashType; context: string }>;
  proposableAccounts: ProposableAccountMap;
  /** Exact forced peer responses produced by Account transitions in this frame. */
  forcedAccountInputs: Map<string, AccountPeerInput>;
  allSwapOffersCreated: SwapOfferEvent[];
  allSwapCancelRequests: SwapCancelRequestEvent[];
  allSwapOffersCancelled: SwapCancelEvent[];
  frameProfileTxTotals: Map<string, { count: number; elapsedMs: number }>;
  accountJClaimNewNodes: Map<string, AccountJClaimNode>;
  accountJClaimReplacedNodeHashes: Set<string>;
  accountJClaimNodeStore: AccountJClaimNodeStore;
  candidateEffects: EntityCandidateEffect[];
  storageChanges: RuntimeOverlayRecord[];
  authorizedCommand?: true | undefined;
  authorizedCollective?: true | undefined;
  authorizedRuntimeOutput?: true | undefined;
  /** Exact authority proven from this frame's contiguous BoardActivated chain. */
  authorizedBoardHandoverConfig?: EntityState['config'];
};
