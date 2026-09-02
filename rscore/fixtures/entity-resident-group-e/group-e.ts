import { generateLazyEntityId } from '../../../core/entity/factory';
import { createEmptyEnv } from '../../../core/runtime';
import { TsAccountWorkerAuthority } from '../../../core/rscore/ts-worker/provider';
import { applyCertifiedEntityHeadPlan, buildCertifiedEntityHeadPlan } from '../../../core/storage/replica/entity-head';
import type { EntityTx } from '../../../core/types/entity-tx';
import type { RuntimeReplica } from '../../../core/runtime/types';
import {
  addReplica,
  getTestAccountForWrite,
  installJurisdictions,
  makeJurisdiction,
  makeState,
  registerTestSigner,
} from '../../../core/__tests__/helpers/cross-j';
import { executeFrame, projectInitialRuntime, registerRoute } from './runtime-vector';

const SEED = 'entity-resident-group-e-v1';
const TIMESTAMP = 10_000;

type Side = Readonly<{
  env: RuntimeReplica;
  authority: TsAccountWorkerAuthority;
  entityId: string;
  signerId: string;
}>;

const entityState = (side: Side) => {
  const replica = [...side.env.state.eReplicas.values()].find(row =>
    row.entityId === side.entityId && row.signerId === side.signerId);
  if (!replica) throw new Error(`GROUP_E_ENTITY_MISSING:${side.entityId}`);
  return replica.state;
};

const buildSide = (
  suffix: string,
  label: string,
  jurisdiction: ReturnType<typeof makeJurisdiction>,
) => {
  const env = createEmptyEnv(`${SEED}-${suffix}`);
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.state.timestamp = TIMESTAMP;
  installJurisdictions(env, jurisdiction);
  for (const replica of env.state.jReplicas.values()) {
    replica.blockNumber = 0n;
    replica.stateRoot = null;
    replica.mempool = [];
    replica.blockDelayMs = 0;
    replica.lastBlockTimestamp = 0;
    replica.position = { x: 0, y: 0, z: 0 };
  }
  const authority = new TsAccountWorkerAuthority(env, 1);
  env.accountAuthorityExecutionMode = 'cutover';
  env.accountAuthorityEntityStageProvider = authority.provider;
  const signerId = registerTestSigner(env, SEED, label);
  return { env, authority, signerId };
};

const buildSides = () => {
  const jurisdiction = makeJurisdiction('GroupE', 31_337, '81', '82');
  const first = buildSide('first', 'first', jurisdiction);
  const second = buildSide('second', 'second', jurisdiction);
  const firstId = generateLazyEntityId([first.signerId], 1n).toLowerCase();
  const secondId = generateLazyEntityId([second.signerId], 1n).toLowerCase();
  const [left, right] = firstId < secondId
    ? [{ ...first, entityId: firstId }, { ...second, entityId: secondId }]
    : [{ ...second, entityId: secondId }, { ...first, entityId: firstId }];
  const leftState = makeState(left.entityId, left.signerId, jurisdiction, right.entityId);
  const rightState = makeState(right.entityId, right.signerId, jurisdiction, left.entityId);
  for (const [state, peer] of [[leftState, right.entityId], [rightState, left.entityId]] as const) {
    state.height = 0;
    state.timestamp = TIMESTAMP;
    state.prevFrameHash = 'genesis';
    getTestAccountForWrite(state, peer).proofHeader.nextProofNonce = 1;
  }
  addReplica(left.env, leftState, left.signerId);
  addReplica(right.env, rightState, right.signerId);
  registerRoute(left.env, right.entityId, right.signerId, right.env.runtimeId!);
  registerRoute(right.env, left.entityId, left.signerId, left.env.runtimeId!);
  applyCertifiedEntityHeadPlan(left.env, buildCertifiedEntityHeadPlan(left.env));
  applyCertifiedEntityHeadPlan(right.env, buildCertifiedEntityHeadPlan(right.env));
  return { left, right };
};

const localInput = (side: Side, tx: EntityTx) => [{
  entityId: side.entityId,
  signerId: side.signerId,
  entityTxs: [tx],
}];

const executeAccountRoundTrip = async (
  proposer: Side,
  peer: Side,
  tx: EntityTx,
) => {
  const stage = async <T>(name: string, execute: () => Promise<T>): Promise<T> => {
    try {
      return await execute();
    } catch (error) {
      throw new Error(`GROUP_E_${tx.type}_${name}`, { cause: error });
    }
  };
  const local = await stage('LOCAL', () => executeFrame(proposer.env, localInput(proposer, tx), peer.env));
  if (local.outputs.length === 0) throw new Error(`GROUP_E_PROPOSAL_OUTPUT_MISSING:${tx.type}`);
  const projections = [local.projection];
  let outputs = local.outputs;
  let target = peer;
  let counter = proposer;
  for (let hop = 1; outputs.length > 0; hop += 1) {
    if (hop > 8) throw new Error(`GROUP_E_ACCOUNT_DRAIN_LIMIT:${tx.type}`);
    const applied = await stage(`HOP_${hop}`, () => executeFrame(target.env, outputs, counter.env));
    projections.push(applied.projection);
    outputs = applied.outputs;
    [target, counter] = [counter, target];
  }
  return projections;
};

const workspaceHash = (side: Side, peer: Side): string => {
  const workspace = entityState(side).accounts.get(peer.entityId)?.state.settlementWorkspace;
  if (!workspace) throw new Error(`GROUP_E_WORKSPACE_MISSING:${side.entityId}`);
  return workspace.workspaceHash;
};

const assertSettlementReady = (left: Side, right: Side): void => {
  const leftWorkspace = entityState(left).accounts.get(right.entityId)?.state.settlementWorkspace;
  const rightWorkspace = entityState(right).accounts.get(left.entityId)?.state.settlementWorkspace;
  if (leftWorkspace?.status !== 'ready_to_submit' || rightWorkspace?.status !== 'ready_to_submit') {
    throw new Error(
      `GROUP_E_SETTLEMENT_NOT_READY:${leftWorkspace?.status ?? 'missing'}:${rightWorkspace?.status ?? 'missing'}`,
    );
  }
};

export const executeEntityResidentGroupEVector = async () => {
  const { left, right } = buildSides();
  const initial = { left: projectInitialRuntime(left.env), right: projectInitialRuntime(right.env) };
  const frames = [];
  try {
    frames.push(...await executeAccountRoundTrip(left, right, {
      type: 'settle_propose',
      data: {
        counterpartyEntityId: right.entityId,
        // Forgiveness is never auto-approved: both board-authorized Hanko
        // transitions therefore execute explicitly in this parity vector.
        ops: [{ type: 'forgive', tokenId: 1 }],
        executorIsLeft: true,
        memo: 'group-e-v1',
      },
    }));
    const rightHash = workspaceHash(right, left);
    frames.push(...await executeAccountRoundTrip(right, left, {
      type: 'settle_approve',
      data: { counterpartyEntityId: left.entityId, workspaceHash: rightHash },
    }));
    // Committing the non-executor's Hanko causes the executor's canonical
    // counter-Hanko followup; the bounded drain above carries both to H1.
    assertSettlementReady(left, right);
    const execute = await executeFrame(left.env, localInput(left, {
      type: 'settle_execute',
      data: { counterpartyEntityId: right.entityId, disableC2RShortcut: true },
    }));
    frames.push(execute.projection);
    return {
      version: 1,
      canonicalSource: 'TypeScript full Runtime resident signed settlement cascade',
      setup: {
        seed: SEED,
        timestamp: TIMESTAMP,
        leftEntityId: left.entityId,
        leftSignerId: left.signerId,
        rightEntityId: right.entityId,
        rightSignerId: right.signerId,
        leftRuntimeId: left.env.runtimeId,
        rightRuntimeId: right.env.runtimeId,
        initial,
      },
      frames,
    };
  } finally {
    await left.authority.close();
    await right.authority.close();
  }
};
