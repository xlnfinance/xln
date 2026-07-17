import type { JAdapterFailure } from './jurisdiction-runtime';

export type EntityProviderExecutableActionKind = 'entityTransferTokens' | 'releaseControlShares';
export type EntityProviderActionKind = EntityProviderExecutableActionKind | 'cancelPendingAction';

export type EntityProviderTransferPayload = Readonly<{
  to: string;
  tokenId: bigint;
  amount: bigint;
}>;

export type EntityProviderReleaseControlSharesPayload = Readonly<{
  controlAmount: bigint;
  dividendAmount: bigint;
  purpose: string;
}>;

export type EntityProviderActionPayload =
  | Readonly<{
      kind: 'entityTransferTokens';
      transfer: EntityProviderTransferPayload;
    }>
  | Readonly<{
      kind: 'releaseControlShares';
      release: EntityProviderReleaseControlSharesPayload & {
        depositoryAddress: string;
      };
    }>
  | Readonly<{
      kind: 'cancelPendingAction';
      cancel: {
        cancelledActionHash: string;
        cancelledActionKind: 0 | 1;
      };
    }>;

/** Exact consensus intent. The domain is derived from trusted Entity config. */
export type EntityProviderActionIntent = Readonly<{
  version: 1;
  entityId: string;
  entityNumber: bigint;
  chainId: bigint;
  entityProviderAddress: string;
  boardEpoch: bigint;
  actionNonce: bigint;
  actionHash: string;
  generation: number;
  createdAt: number;
  payload: EntityProviderActionPayload;
}>;

/** Bounded Entity-consensus state: at most one action can be in flight. */
export type EntityProviderActionState = {
  version: 1;
  confirmedNonce: bigint;
  generation: number;
  pending?: EntityProviderActionIntent;
};

export type EntityProviderActionSubmitAttempt = Readonly<{
  attemptId: string;
  attemptNumber: number;
  attemptedAt: number;
  generation: number;
}>;

export type EntityProviderActionJTxData = {
  intent: EntityProviderActionIntent;
  signerId: string;
  hankoSignature?: string;
  runtimeSubmitAttempt?: EntityProviderActionSubmitAttempt;
};

export type EntityProviderActionSubmitOutcome =
  | 'submitted'
  | 'transientFailure'
  | 'terminalFailure'
  | 'reconciled';

/** Validator-local receipt state; never included in Entity consensus roots. */
export type EntityProviderActionSubmitState = {
  jurisdictionName: string;
  actionHash: string;
  actionNonce: bigint;
  generation: number;
  submitAttempts: number;
  lastSubmittedAt: number;
  txHash?: string;
  lastFailure?: {
    message: string;
    failedAt: number;
    adapterFailure?: JAdapterFailure;
  };
  terminalFailure?: {
    message: string;
    failedAt: number;
    adapterFailure?: JAdapterFailure;
  };
  lastResultAttemptId?: string;
  lastResultAt?: number;
  lastResultOutcome?: EntityProviderActionSubmitOutcome;
  lastResultFingerprint?: string;
  resultFingerprints?: Record<string, string>;
  resultFingerprintOrder?: string[];
};

export type RetryEntityProviderActionData = {
  entityId: string;
  signerId: string;
  jurisdictionName: string;
  actionHash: string;
  actionNonce: bigint;
  generation: number;
};

export type RecordEntityProviderActionSubmitResultData = RetryEntityProviderActionData & {
  attemptId: string;
  attemptNumber: number;
  attemptedAt: number;
  outcome: EntityProviderActionSubmitOutcome;
  message?: string;
  adapterFailure?: JAdapterFailure;
  txHash?: string;
};

export type EntityProviderActionExecutedData = {
  entityId: string;
  actionNonce: string | bigint;
  actionHash: string;
  actionKind: 0 | 1;
};

export type EntityProviderActionCancelledData = {
  entityId: string;
  actionNonce: string | bigint;
  cancelledActionHash: string;
  cancelledActionKind: 0 | 1;
  cancelHash: string;
};
