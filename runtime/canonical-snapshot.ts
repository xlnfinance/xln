import type {
  AccountMachine,
  AccountTx,
  EntityReplica,
  EntityState,
  Env,
  EnvSnapshot,
  JReplica,
  Profile,
  RoutedEntityInput,
  RuntimeInput,
} from './types';

const cloneHankoWitness = (
  hankoWitness?: EntityReplica['hankoWitness'],
): EntityReplica['hankoWitness'] | undefined => {
  if (!(hankoWitness instanceof Map) || hankoWitness.size === 0) return undefined;
  return new Map(
    Array.from(hankoWitness.entries()).map(([hash, entry]) => [
      hash,
      {
        hanko: entry.hanko,
        type: entry.type,
        entityHeight: entry.entityHeight,
        createdAt: entry.createdAt,
      },
    ]),
  );
};

const cloneNestedBigIntMap = <V>(
  value: Map<string, Map<number, V>> | undefined,
  cloneLeaf: (leaf: V) => V,
): Map<string, Map<number, V>> | undefined => {
  if (!(value instanceof Map) || value.size === 0) return undefined;
  return new Map(
    Array.from(value.entries()).map(([outerKey, innerMap]) => [
      outerKey,
      new Map(Array.from(innerMap.entries()).map(([innerKey, leaf]) => [innerKey, cloneLeaf(leaf)])),
    ]),
  );
};

export const buildCanonicalEntityReplicaSnapshot = (replica: EntityReplica): EntityReplica => ({
  entityId: replica.entityId,
  signerId: replica.signerId,
  state: buildCanonicalEntityStateSnapshot(replica.state),
  mempool: [],
  isProposer: replica.isProposer,
  ...(replica.position ? { position: { ...replica.position } } : {}),
  ...(cloneHankoWitness(replica.hankoWitness) ? { hankoWitness: cloneHankoWitness(replica.hankoWitness) } : {}),
});

const cloneAccountTxs = (txs: AccountTx[]): AccountTx[] => txs.map((tx) => structuredClone(tx));

const cloneAccountMachineSnapshot = (account: AccountMachine): AccountMachine => {
  const snapshot: AccountMachine = {
    leftEntity: account.leftEntity,
    rightEntity: account.rightEntity,
    status: account.status,
    mempool: [],
    currentFrame: structuredClone(account.currentFrame),
    deltas: new Map(Array.from(account.deltas.entries()).map(([tokenId, delta]) => [tokenId, structuredClone(delta)])),
    locks: new Map(Array.from(account.locks.entries()).map(([lockId, lock]) => [lockId, structuredClone(lock)])),
    swapOffers: new Map(
      Array.from(account.swapOffers.entries()).map(([offerId, offer]) => [offerId, structuredClone(offer)]),
    ),
    globalCreditLimits: structuredClone(account.globalCreditLimits),
    currentHeight: account.currentHeight,
    rollbackCount: account.rollbackCount,
    leftJObservations: structuredClone(account.leftJObservations),
    rightJObservations: structuredClone(account.rightJObservations),
    jEventChain: structuredClone(account.jEventChain),
    lastFinalizedJHeight: account.lastFinalizedJHeight,
    proofHeader: structuredClone(account.proofHeader),
    proofBody: structuredClone(account.proofBody),
    disputeConfig: structuredClone(account.disputeConfig),
    onChainSettlementNonce: account.onChainSettlementNonce,
    frameHistory: [],
    pendingWithdrawals: new Map(
      Array.from(account.pendingWithdrawals.entries()).map(([requestId, entry]) => [requestId, structuredClone(entry)]),
    ),
    requestedRebalance: new Map(
      Array.from(account.requestedRebalance.entries()).map(([tokenId, amount]) => [tokenId, BigInt(amount)]),
    ),
    requestedRebalanceFeeState: new Map(
      Array.from(account.requestedRebalanceFeeState.entries()).map(([tokenId, entry]) => [
        tokenId,
        structuredClone(entry),
      ]),
    ),
    rebalancePolicy: new Map(
      Array.from(account.rebalancePolicy.entries()).map(([tokenId, entry]) => [tokenId, structuredClone(entry)]),
    ),
  };

  if (account.lastRollbackFrameHash) snapshot.lastRollbackFrameHash = account.lastRollbackFrameHash;
  if (account.abiProofBody) snapshot.abiProofBody = structuredClone(account.abiProofBody);
  if (account.currentFrameHanko) snapshot.currentFrameHanko = account.currentFrameHanko;
  if (account.counterpartyFrameHanko) snapshot.counterpartyFrameHanko = account.counterpartyFrameHanko;
  if (account.currentDisputeProofHanko) snapshot.currentDisputeProofHanko = account.currentDisputeProofHanko;
  if (account.currentDisputeProofNonce !== undefined) snapshot.currentDisputeProofNonce = account.currentDisputeProofNonce;
  if (account.currentDisputeProofBodyHash) snapshot.currentDisputeProofBodyHash = account.currentDisputeProofBodyHash;
  if (account.currentDisputeHash) snapshot.currentDisputeHash = account.currentDisputeHash;
  if (account.counterpartyDisputeProofHanko) {
    snapshot.counterpartyDisputeProofHanko = account.counterpartyDisputeProofHanko;
  }
  if (account.counterpartyDisputeProofNonce !== undefined) {
    snapshot.counterpartyDisputeProofNonce = account.counterpartyDisputeProofNonce;
  }
  if (account.counterpartyDisputeProofBodyHash) {
    snapshot.counterpartyDisputeProofBodyHash = account.counterpartyDisputeProofBodyHash;
  }
  if (account.counterpartyDisputeHash) snapshot.counterpartyDisputeHash = account.counterpartyDisputeHash;
  if (account.counterpartySettlementHanko) snapshot.counterpartySettlementHanko = account.counterpartySettlementHanko;
  if (account.disputeProofNoncesByHash) {
    snapshot.disputeProofNoncesByHash = structuredClone(account.disputeProofNoncesByHash);
  }
  if (account.disputeProofBodiesByHash) {
    snapshot.disputeProofBodiesByHash = structuredClone(account.disputeProofBodiesByHash);
  }
  if (account.settlementWorkspace) snapshot.settlementWorkspace = structuredClone(account.settlementWorkspace);
  if (account.activeDispute) snapshot.activeDispute = structuredClone(account.activeDispute);
  if (account.hankoSignature) snapshot.hankoSignature = account.hankoSignature;
  if (account.pendingForward) snapshot.pendingForward = structuredClone(account.pendingForward);
  if (account.counterpartyRebalanceFeePolicy) {
    snapshot.counterpartyRebalanceFeePolicy = structuredClone(account.counterpartyRebalanceFeePolicy);
  }
  if (account.activeRebalanceQuote) snapshot.activeRebalanceQuote = structuredClone(account.activeRebalanceQuote);
  if (account.pendingRebalanceRequest) {
    snapshot.pendingRebalanceRequest = structuredClone(account.pendingRebalanceRequest);
  }

  return snapshot;
};

const buildCanonicalOrderbookSnapshot = (entityState: EntityState): EntityState['orderbookExt'] | undefined => {
  const ext = entityState.orderbookExt;
  if (!ext || !ext.hubProfile) return undefined;
  return {
    books: new Map(),
    referrals: new Map(),
    hubProfile: structuredClone(ext.hubProfile),
  };
};

const buildCanonicalEntityStateSnapshot = (entityState: EntityState): EntityState => {
  const snapshot: EntityState = {
    entityId: entityState.entityId,
    height: entityState.height,
    timestamp: entityState.timestamp,
    nonces: new Map(Array.from(entityState.nonces.entries())),
    messages: [...entityState.messages],
    proposals: new Map(
      Array.from(entityState.proposals.entries()).map(([proposalId, proposal]) => [
        proposalId,
        {
          ...structuredClone(proposal),
          votes: new Map(Array.from(proposal.votes.entries()).map(([voter, vote]) => [voter, structuredClone(vote)])),
        },
      ]),
    ),
    config: structuredClone(entityState.config),
    reserves: new Map(Array.from(entityState.reserves.entries()).map(([tokenId, amount]) => [tokenId, BigInt(amount)])),
    accounts: new Map(
      Array.from(entityState.accounts.entries()).map(([accountId, account]) => [
        accountId,
        cloneAccountMachineSnapshot(account),
      ]),
    ),
    lastFinalizedJHeight: entityState.lastFinalizedJHeight,
    jBlockObservations: structuredClone(entityState.jBlockObservations),
    jBlockChain: structuredClone(entityState.jBlockChain),
    entityEncPubKey: entityState.entityEncPubKey,
    entityEncPrivKey: entityState.entityEncPrivKey,
    profile: structuredClone(entityState.profile),
    htlcRoutes: new Map(
      Array.from(entityState.htlcRoutes.entries()).map(([hashlock, route]) => [hashlock, structuredClone(route)]),
    ),
    htlcFeesEarned: BigInt(entityState.htlcFeesEarned),
    swapBook: new Map(),
    lockBook: new Map(),
  };

  if (entityState.prevFrameHash) snapshot.prevFrameHash = entityState.prevFrameHash;
  if (entityState.crontabState) snapshot.crontabState = structuredClone(entityState.crontabState);
  if (entityState.debts) snapshot.debts = structuredClone(entityState.debts);
  if (entityState.orderbookExt) snapshot.orderbookExt = buildCanonicalOrderbookSnapshot(entityState);
  if (entityState.swapTradingPairs) snapshot.swapTradingPairs = structuredClone(entityState.swapTradingPairs);
  if (entityState.pendingSwapFillRatios) {
    snapshot.pendingSwapFillRatios = new Map(Array.from(entityState.pendingSwapFillRatios.entries()));
  }
  if (entityState.hubRebalanceConfig) snapshot.hubRebalanceConfig = structuredClone(entityState.hubRebalanceConfig);

  return snapshot;
};

export const buildCanonicalJReplicaSnapshot = (jr: JReplica): JReplica => ({
  name: jr.name,
  blockNumber: jr.blockNumber,
  stateRoot: new Uint8Array(jr.stateRoot),
  mempool: [],
  blockDelayMs: jr.blockDelayMs,
  lastBlockTimestamp: jr.lastBlockTimestamp,
  ...(jr.rpcs ? { rpcs: [...jr.rpcs] } : {}),
  ...(jr.chainId !== undefined ? { chainId: jr.chainId } : {}),
  position: { ...jr.position },
  ...(jr.depositoryAddress ? { depositoryAddress: jr.depositoryAddress } : {}),
  ...(jr.entityProviderAddress ? { entityProviderAddress: jr.entityProviderAddress } : {}),
  ...(jr.contracts
    ? {
        contracts: {
          ...(jr.contracts.depository ? { depository: jr.contracts.depository } : {}),
          ...(jr.contracts.entityProvider ? { entityProvider: jr.contracts.entityProvider } : {}),
          ...(jr.contracts.account ? { account: jr.contracts.account } : {}),
          ...(jr.contracts.deltaTransformer ? { deltaTransformer: jr.contracts.deltaTransformer } : {}),
        },
      }
    : {}),
  ...(cloneNestedBigIntMap(jr.reserves, (leaf) => BigInt(leaf as bigint))
    ? { reserves: cloneNestedBigIntMap(jr.reserves, (leaf) => BigInt(leaf as bigint)) }
    : {}),
  ...(cloneNestedBigIntMap(jr.collaterals, (leaf) => ({
      collateral: BigInt((leaf as { collateral: bigint }).collateral),
      ondelta: BigInt((leaf as { ondelta: bigint }).ondelta),
    }))
    ? {
        collaterals: cloneNestedBigIntMap(jr.collaterals, (leaf) => ({
          collateral: BigInt((leaf as { collateral: bigint }).collateral),
          ondelta: BigInt((leaf as { ondelta: bigint }).ondelta),
        })),
      }
    : {}),
  ...(jr.registeredEntities
    ? {
        registeredEntities: new Map(
          Array.from(jr.registeredEntities.entries()).map(([entityId, value]) => [
            entityId,
            {
              name: value.name,
              quorum: [...value.quorum],
              threshold: value.threshold,
            },
          ]),
        ),
      }
    : {}),
});

const cloneRuntimeInput = (runtimeInput: RuntimeInput): RuntimeInput => ({
  runtimeTxs: [...runtimeInput.runtimeTxs],
  entityInputs: runtimeInput.entityInputs.map(input => ({
    entityId: input.entityId,
    signerId: input.signerId,
    ...(input.entityTxs ? { entityTxs: [...input.entityTxs] } : {}),
    ...(input.hashPrecommits
      ? { hashPrecommits: new Map(Array.from(input.hashPrecommits.entries()).map(([key, value]) => [key, [...value]])) }
      : {}),
    ...(input.proposedFrame ? { proposedFrame: input.proposedFrame } : {}),
  })),
});

const cloneRuntimeOutputs = (runtimeOutputs: RoutedEntityInput[]): RoutedEntityInput[] =>
  runtimeOutputs.map(output => ({
    entityId: output.entityId,
    signerId: output.signerId,
    ...(output.entityTxs ? { entityTxs: [...output.entityTxs] } : {}),
    ...(output.hashPrecommits
      ? { hashPrecommits: new Map(Array.from(output.hashPrecommits.entries()).map(([key, value]) => [key, [...value]])) }
      : {}),
    ...(output.proposedFrame ? { proposedFrame: output.proposedFrame } : {}),
  }));

const cloneProfiles = (profiles: Profile[] | undefined): Profile[] | undefined => {
  if (!profiles || profiles.length === 0) return undefined;
  return profiles.map(profile => structuredClone(profile));
};

const cloneLogs = (logs: Env['frameLogs'] | undefined): Env['frameLogs'] | undefined => {
  if (!Array.isArray(logs) || logs.length === 0) return undefined;
  return logs.map(entry => ({ ...entry }));
};

export const buildCanonicalRuntimeStateSnapshot = (
  env: Env,
  options?: {
    browserVMState?: Env['browserVMState'];
  },
): Record<string, unknown> => ({
  height: env.height,
  timestamp: env.timestamp,
  ...(env.runtimeSeed !== undefined && env.runtimeSeed !== null ? { runtimeSeed: env.runtimeSeed } : {}),
  ...(env.runtimeId ? { runtimeId: env.runtimeId } : {}),
  ...(env.dbNamespace ? { dbNamespace: env.dbNamespace } : {}),
  ...(env.activeJurisdiction ? { activeJurisdiction: env.activeJurisdiction } : {}),
  ...(options?.browserVMState ?? env.browserVMState ? { browserVMState: options?.browserVMState ?? env.browserVMState } : {}),
  eReplicas: Array.from(env.eReplicas.entries()).map(([replicaKey, replica]) => [
    replicaKey,
    buildCanonicalEntityReplicaSnapshot(replica),
  ]),
  jReplicas: Array.from((env.jReplicas || new Map()).entries()).map(([replicaKey, jr]) => [
    replicaKey,
    buildCanonicalJReplicaSnapshot(jr),
  ]),
});

export const buildCanonicalEnvSnapshot = (
  env: Env,
  options: {
    runtimeInput: RuntimeInput;
    runtimeOutputs: RoutedEntityInput[];
    description: string;
    meta?: EnvSnapshot['meta'];
    browserVMState?: Env['browserVMState'];
    gossipProfiles?: Profile[];
    logs?: Env['frameLogs'];
  },
): EnvSnapshot => {
  const core = buildCanonicalRuntimeStateSnapshot(env, { browserVMState: options.browserVMState }) as {
    height: number;
    timestamp: number;
    runtimeSeed?: string;
    runtimeId?: string;
    browserVMState?: Env['browserVMState'];
    eReplicas: Array<[string, EntityReplica]>;
    jReplicas: Array<[string, JReplica]>;
  };

  const logs = cloneLogs(options.logs);
  return {
    height: core.height,
    timestamp: core.timestamp,
    ...(core.runtimeSeed !== undefined && core.runtimeSeed !== null ? { runtimeSeed: core.runtimeSeed } : {}),
    ...(core.runtimeId ? { runtimeId: core.runtimeId } : {}),
    eReplicas: new Map(core.eReplicas),
    jReplicas: core.jReplicas.map(([, replica]) => replica),
    ...(core.browserVMState ? { browserVMState: core.browserVMState } : {}),
    runtimeInput: cloneRuntimeInput(options.runtimeInput),
    runtimeOutputs: cloneRuntimeOutputs(options.runtimeOutputs),
    description: options.description,
    ...(cloneProfiles(options.gossipProfiles) ? { gossip: { profiles: cloneProfiles(options.gossipProfiles)! } } : {}),
    ...(options.meta
      ? {
          meta: {
            ...(options.meta.title ? { title: options.meta.title } : {}),
            ...(options.meta.subtitle ? { subtitle: structuredClone(options.meta.subtitle) } : {}),
            ...(options.meta.displayMs !== undefined ? { displayMs: options.meta.displayMs } : {}),
          },
        }
      : {}),
    ...(logs ? { logs } : {}),
  };
};
