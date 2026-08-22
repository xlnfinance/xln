/**
 * Bounded Entity-owned AccountReplica shell.
 * Growing Patricia collections stay shared; only known envelope fields are copied.
 */
import type { AccountFrame, AccountInput, AccountReplica, AccountState, SettlementWorkspace } from '../../types/account';
import { isPersistentAccountStateMap } from './persistent-state-map';
import { createStructuredLogger } from '../../support/logger';
import { transferAccountStateRootMemo } from '../commitment/state-root';
import { cloneIsolatedAccountTx } from '../../protocol/state/account-input-clone';

const shellLog = createStructuredLogger('entity.account.shell');

const ACCOUNT_STATE_COLLECTIONS = [
  'deltas',
  'locks',
  'swapOffers',
  'pulls',
  'subcontracts',
  'lendingIntents',
  'requestedRebalance',
  'requestedRebalanceFeeState',
  'rebalanceFeePolicies',
] as const satisfies readonly (keyof AccountState)[];

const copyRecord = <T extends object>(value: T): T => ({ ...value });

const copyArray = <T>(value: readonly T[]): T[] => [...value];

// Committed frames are values: nothing mutates a frame's txs/deltas in place
// after it is built, so a shell shares them and only owns the top-level record.
const copyFrame = (frame: AccountFrame): AccountFrame => ({ ...frame });

/** Shell of a cached outbound input: witnesses are attached on the shell's own proposal/ack records. */
const forkAccountInputShell = <T extends AccountInput>(input: T): T => {
  const shell = { ...input } as T & { proposal?: { frame: AccountFrame; disputeSeal?: object }; ack?: { disputeSeal?: object } };
  if ('proposal' in shell && shell.proposal) {
    shell.proposal = {
      ...shell.proposal,
      frame: copyFrame(shell.proposal.frame),
      ...(shell.proposal.disputeSeal ? { disputeSeal: { ...shell.proposal.disputeSeal } } : {}),
    };
  }
  if ('ack' in shell && shell.ack) {
    shell.ack = {
      ...shell.ack,
      ...(shell.ack.disputeSeal ? { disputeSeal: { ...shell.ack.disputeSeal } } : {}),
    };
  }
  return shell as T;
};

const copyWorkspace = (workspace: SettlementWorkspace): SettlementWorkspace => ({
  ...workspace,
  ops: copyArray(workspace.ops),
  ...(workspace.compiledDiffs === undefined ? {} : { compiledDiffs: copyArray(workspace.compiledDiffs) }),
  ...(workspace.compiledForgiveTokenIds === undefined
    ? {}
    : { compiledForgiveTokenIds: copyArray(workspace.compiledForgiveTokenIds) }),
  ...(workspace.postSettlementDisputeProof === undefined
    ? {}
    : { postSettlementDisputeProof: copyRecord(workspace.postSettlementDisputeProof) }),
});

const requireSharedCollection = (state: AccountState, field: (typeof ACCOUNT_STATE_COLLECTIONS)[number]): void => {
  const value = state[field];
  if (value === undefined) return;
  if (!isPersistentAccountStateMap(value)) {
    throw new Error(`ACCOUNT_STATE_COLLECTION_NOT_PERSISTENT:${field}`);
  }
};

const forkAccountStateShell = (state: AccountState): AccountState => {
  for (const field of ACCOUNT_STATE_COLLECTIONS) requireSharedCollection(state, field);
  const shell: AccountState = {
    ...state,
    domain: copyRecord(state.domain),
    disputeConfig: copyRecord(state.disputeConfig),
    leftPendingJClaims: copyRecord(state.leftPendingJClaims),
    rightPendingJClaims: copyRecord(state.rightPendingJClaims),
    ...(state.settlementWorkspace === undefined
      ? {}
      : { settlementWorkspace: copyWorkspace(state.settlementWorkspace) }),
  };
  // AccountState roots are derived caches, not protocol state. Preserve a
  // warm root only across this exact value fork; replacement of any committed
  // collection/scalar invalidates it structurally in computeAccountStateRoot.
  transferAccountStateRootMemo(state, shell);
  return shell;
};

const forkShadow = (shadow: AccountReplica['shadow']): AccountReplica['shadow'] => {
  return {
    rebalance: {
      policy: shadow.rebalance.policy,
      submittedAtByToken: shadow.rebalance.submittedAtByToken,
      ...(shadow.rebalance.activeQuote === undefined
        ? {}
        : { activeQuote: copyRecord(shadow.rebalance.activeQuote) }),
      ...(shadow.rebalance.pendingRequest === undefined
        ? {}
        : { pendingRequest: copyRecord(shadow.rebalance.pendingRequest) }),
    },
    ...(shadow.rejectedFrameEvidence === undefined
      ? {}
      : {
          rejectedFrameEvidence: {
            ...shadow.rejectedFrameEvidence,
            frame: copyFrame(shadow.rejectedFrameEvidence.frame),
          },
        }),
  };
};

/** Entity-frame write shell. Patricia Account collections remain structurally shared. */
export const forkAccountReplicaShell = (base: AccountReplica): AccountReplica => {
  if (!base.state || typeof base.state !== 'object') return { ...base };
  if (!isPersistentAccountStateMap(base.pendingWithdrawals)) {
    throw new Error('ACCOUNT_ENVELOPE_COLLECTION_NOT_PERSISTENT:pendingWithdrawals');
  }
  if (!isPersistentAccountStateMap(base.shadow.rebalance.policy)) {
    throw new Error('ACCOUNT_ENVELOPE_COLLECTION_NOT_PERSISTENT:rebalanceShadowPolicy');
  }
  if (!isPersistentAccountStateMap(base.shadow.rebalance.submittedAtByToken)) {
    throw new Error('ACCOUNT_ENVELOPE_COLLECTION_NOT_PERSISTENT:rebalanceShadowSubmitted');
  }
  const shell: AccountReplica = {
    ...base,
    state: forkAccountStateShell(base.state),
    mempool: base.mempool.map(cloneIsolatedAccountTx),
    currentFrame: copyFrame(base.currentFrame),
    proofHeader: copyRecord(base.proofHeader),
    pendingWithdrawals: base.pendingWithdrawals,
    shadow: forkShadow(base.shadow),
  };
  if (base.pendingFrame) shell.pendingFrame = copyFrame(base.pendingFrame);
  if (base.pendingAccountInput) shell.pendingAccountInput = forkAccountInputShell(base.pendingAccountInput);
  if (base.lastOutboundFrameAck) {
    shell.lastOutboundFrameAck = {
      ...base.lastOutboundFrameAck,
      response: forkAccountInputShell(base.lastOutboundFrameAck.response),
    };
  }
  if (base.boardResealMigration) shell.boardResealMigration = copyRecord(base.boardResealMigration);
  if (base.counterpartyBoardReseal) shell.counterpartyBoardReseal = copyRecord(base.counterpartyBoardReseal);
  if (base.disputePrepare) {
    shell.disputePrepare = {
      ...base.disputePrepare,
      ...(base.disputePrepare.pendingOrderbookRemovalIds === undefined
        ? {}
        : { pendingOrderbookRemovalIds: copyArray(base.disputePrepare.pendingOrderbookRemovalIds) }),
      ...(base.disputePrepare.startIntent === undefined
        ? {}
        : { startIntent: copyRecord(base.disputePrepare.startIntent) }),
      ...(base.disputePrepare.crossJurisdictionRecovery === undefined
        ? {}
        : {
            crossJurisdictionRecovery: {
              ...base.disputePrepare.crossJurisdictionRecovery,
              requiredPullIds: copyArray(base.disputePrepare.crossJurisdictionRecovery.requiredPullIds),
              resultsByPullId: copyRecord(base.disputePrepare.crossJurisdictionRecovery.resultsByPullId),
            },
          }),
    };
  }
  if (base.activeDispute) {
    shell.activeDispute = {
      ...base.activeDispute,
      ...(base.activeDispute.crossJurisdictionRecovery === undefined
        ? {}
        : {
            crossJurisdictionRecovery: {
              ...base.activeDispute.crossJurisdictionRecovery,
              requiredPullIds: copyArray(base.activeDispute.crossJurisdictionRecovery.requiredPullIds),
              resultsByPullId: copyRecord(base.activeDispute.crossJurisdictionRecovery.resultsByPullId),
            },
          }),
    };
  }
  if (base.pendingForwards) {
    shell.pendingForwards = base.pendingForwards.map(forward => ({
      ...forward,
      route: copyArray(forward.route),
    }));
  }
  shellLog.debug('replica.forked', {
    from: base.proofHeader.fromEntity.slice(-8),
    to: base.proofHeader.toEntity.slice(-8),
    height: base.currentHeight,
  });
  return shell;
};
