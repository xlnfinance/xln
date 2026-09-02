import { createHash } from 'node:crypto';

import { computeAccountStateRoot } from '../../../core/account/commitment/state-root';
import { computeCanonicalEntityConsensusStateHash } from '../../../core/entity/consensus/state-root';
import { getEffectiveEntityInputTxs } from '../../../core/entity/consensus/output/envelope';
import { clearRuntimeFrameEvents, readRuntimeFrameEvents } from '../../../core/runtime/observability/env-events';
import { beginRuntimeParityEvidence, finishRuntimeParityEvidence } from '../../../core/runtime/observability/parity-evidence';
import { applyRuntimeInput } from '../../../core/runtime';
import { safeStringify } from '../../../core/protocol/serialization';
import { prepareRuntimeOutputRows } from '../../../core/storage/wal/outbox-payload';
import type { RoutedEntityInput, RuntimeReplica } from '../../../core/runtime/types';
import { buildHltEntityEffectEvidence } from '../../../core/scripts/operations/hlt/replay/entity-effect-evidence';
import { buildHltEntityFrameEventEvidenceFromEvents } from '../../../core/scripts/operations/hlt/replay/entity-frame-event-evidence';

const orderedDigest = (value: unknown): string => `0x${createHash('sha256')
  .update(safeStringify(value)).digest('hex')}`;

export const registerRoute = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
  runtimeId: string,
): void => {
  env.infrastructure!.verifiedProfileRoutes ??= new Map();
  env.infrastructure!.verifiedProfileRoutes.set(entityId, {
    runtimeId,
    runtimeSignerId: signerId,
    runtimeEncPubKey: '',
    lastUpdated: env.state.timestamp,
  });
};

export const projectInitialRuntime = (env: RuntimeReplica) => ({
  entities: [...env.state.eReplicas.values()].map(replica => ({
    entityId: replica.entityId,
    signerId: replica.signerId,
    timestamp: replica.state.timestamp,
    entityEncryptionPublicKey: replica.state.entityEncryptionPublicKey,
    jurisdiction: replica.state.config.jurisdiction,
    accountsRoot: replica.state.accounts.rootHash(),
    entityRoot: computeCanonicalEntityConsensusStateHash(replica.state),
    accounts: [...replica.state.accounts].map(([counterpartyEntityId, account]) => ({
      counterpartyEntityId,
      chainId: account.state.domain.chainId,
      depositoryAddress: account.state.domain.depositoryAddress,
      watchSeed: account.state.watchSeed,
      root: computeAccountStateRoot(account.state),
    })),
  })),
});

const projectAccountInput = (output: RoutedEntityInput): unknown => {
  const tx = getEffectiveEntityInputTxs(output).find(candidate => candidate.type === 'accountInput');
  return tx?.type === 'accountInput' ? tx.data : null;
};

const projectFrame = (
  env: RuntimeReplica,
  inputs: readonly RoutedEntityInput[],
  outputs: readonly RoutedEntityInput[],
  capture: ReturnType<typeof finishRuntimeParityEvidence>,
) => {
  const height = env.state.height;
  const logs = readRuntimeFrameEvents(env);
  const projection = {
    runtimeHeight: height,
    canonicalEntityInputs: inputs,
    entityFrames: capture.entityFrames.map(({ entityId, signerId, accountsRoot, link }) => ({
      entityId, signerId, accountsRoot,
      height: link.frame.height,
      hash: link.frame.hash,
      parentFrameHash: link.frame.parentFrameHash,
      stateRoot: link.frame.stateRoot,
      authorityRoot: link.frame.authorityRoot,
      txs: link.frame.txs,
      events: link.frame.events,
    })),
    entityRoots: [...env.state.eReplicas.values()].map(replica => ({
      entityId: replica.entityId,
      signerId: replica.signerId,
      height: replica.state.height,
      root: computeCanonicalEntityConsensusStateHash(replica.state),
    })),
    accounts: [...env.state.eReplicas.values()].flatMap(replica =>
      [...replica.state.accounts].map(([counterpartyEntityId, account]) => ({
        entityId: replica.entityId,
        counterpartyEntityId,
        root: computeAccountStateRoot(account.state),
        currentHeight: account.currentHeight,
        currentFrameHash: account.currentFrame.stateHash,
        pendingHeight: account.pendingFrame?.height ?? null,
        mempoolTxTypes: account.mempool.map(tx => tx.type),
        workspace: account.state.settlementWorkspace ?? null,
      }))),
    events: buildHltEntityFrameEventEvidenceFromEvents(height, capture.entityFrameEvents),
    effects: buildHltEntityEffectEvidence(height, logs),
    outbox: {
      ...prepareRuntimeOutputRows(height, outputs).commitment,
      walOutputs: outputs,
      outputs: outputs.map(output => ({
        entityId: output.entityId,
        signerId: output.signerId,
        accountInput: projectAccountInput(output),
      })),
    },
  };
  clearRuntimeFrameEvents(env);
  return { ...projection, projectionDigest: orderedDigest(projection) };
};

const bindOutputs = (
  outputs: readonly RoutedEntityInput[],
  source: RuntimeReplica,
  target?: RuntimeReplica,
): RoutedEntityInput[] => outputs.map(output => ({
  ...structuredClone(output),
  ...(source.runtimeId ? { from: source.runtimeId } : {}),
  ...(target?.runtimeId ? { runtimeId: target.runtimeId } : {}),
  sourceRuntimeFrame: { height: source.state.height, timestamp: source.state.timestamp },
}));

export const executeFrame = async (
  env: RuntimeReplica,
  entityInputs: RoutedEntityInput[],
  target?: RuntimeReplica,
) => {
  beginRuntimeParityEvidence(env);
  const result = await applyRuntimeInput(env, { runtimeTxs: [], entityInputs });
  const capture = finishRuntimeParityEvidence(env);
  const outputs = bindOutputs(result.entityOutbox, env, target);
  return {
    outputs,
    projection: projectFrame(env, result.appliedRuntimeInput.entityInputs, outputs, capture),
  };
};
