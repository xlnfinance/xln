import type {
  AccountInput,
  EntityCandidateEffect,
  EntityInput,
  EntityState,
  EntityTx,
  RuntimeState,
  HashType,
  JInput,
  RuntimeOverlayRecord,
} from '../../types';
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

export type ApplyEntityTxsInOrderContext = {
  env: RuntimeState;
  entityTxs: EntityTx[];
  currentEntityState: EntityState;
  allOutputs: EntityInput[];
  allJOutputs: JInput[];
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>;
  proposableAccounts: Set<string>;
  requiredAccountResponses: Map<string, AccountInput>;
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
  authorizedCommand?: true | undefined;
  authorizedCollective?: true | undefined;
  authorizedCertifiedOutput?: true | undefined;
  authorizedRuntimeOutput?: true | undefined;
};
