import { describe, expect, test } from 'bun:test';
import { join } from 'path';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import { applyEntityInput } from '../entity/consensus';
import {
  buildEntityLeaderVoteBody,
  buildEntityLeaderCertificate,
  hashEntityLeaderVoteBody,
} from '../entity/consensus/leader';
import { generateLazyEntityId } from '../entity/factory';
import { initCrontab } from '../entity/scheduler';
import {
  createDueScheduledWakeInputs,
  refreshScheduledWakeIndex,
} from '../machine/scheduled-wake';
import {
  buildPendingNetworkOutputs,
  dispatchEntityOutputs,
  getNextNetworkRetryTimestamp,
  getReliableOutputIdentity,
  sendEntityInputWithRouting,
  type RuntimeOutputRoutingDeps,
} from '../machine/output-routing';
import {
  applyReliableDeliveryReceipts,
  commitReliableIngress,
  registerReliableIngress,
  releaseUncommittedReliableIngress,
} from '../machine/reliable-delivery';
import { deliveryAccepted, deliveryFailure } from '../protocol/payments/delivery-result';
import { applyRuntimeInput, createEmptyEnv } from '../runtime';
import { buildDurableRuntimeMachineSnapshot, restoreDurableRuntimeSnapshot } from '../wal/snapshot';
import type {
  DeliverableEntityInput,
  EntityLeaderTimeoutVote,
  EntityReplica,
  EntityState,
  Env,
  RuntimeEntityInputsEnvelope,
} from '../types';

const runtime = (seed: string): Env => {
  const env = createEmptyEnv(seed);
  const runtimeId = deriveSignerAddressSync(seed, 'runtime').toLowerCase();
  registerSignerKey(env, runtimeId, deriveSignerKeySync(seed, 'runtime'));
  env.runtimeId = runtimeId;
  env.runtimeSeed = seed;
  env.runtimeState ??= {};
  env.quietRuntimeLogs = true;
  env.warn = () => {};
  return env;
};

const installVoteTarget = (
  env: Env,
  seed: string,
  options: { localSignerIsFallback?: boolean } = {},
): {
  replica: EntityReplica;
  vote: EntityLeaderTimeoutVote;
} => {
  const signerId = deriveSignerAddressSync(seed, 'receiver-signer').toLowerCase();
  const voterId = deriveSignerAddressSync(seed, 'voter').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, 'receiver-signer'));
  registerSignerKey(env, voterId, deriveSignerKeySync(seed, 'voter'));
  const validators = options.localSignerIsFallback
    ? [voterId, signerId]
    : [signerId, voterId];
  const entityId = generateLazyEntityId(validators, 2n, env).toLowerCase();
  const state: EntityState = {
    entityId,
    height: 0,
    timestamp: 0,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 2n,
      validators,
      shares: { [signerId]: 1n, [voterId]: 1n },
    },
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    crontabState: initCrontab(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    entityEncPubKey: `0x${'11'.repeat(32)}`,
    entityEncPrivKey: `0x${'22'.repeat(32)}`,
    profile: { name: 'reliable leader vote', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    htlcNotes: new Map(),
    lockBook: new Map(),
    swapTradingPairs: [],
  };
  const replica: EntityReplica = {
    entityId,
    signerId,
    state,
    mempool: [],
    isProposer: false,
  };
  env.eReplicas.set(`${entityId}:${signerId}`, replica);
  const body = buildEntityLeaderVoteBody(state);
  const vote: EntityLeaderTimeoutVote = {
    ...body,
    voterId,
    signature: signAccountFrame(env, voterId, hashEntityLeaderVoteBody(body)),
  };
  return { replica, vote };
};

const voteOutput = (
  receiver: Env,
  replica: EntityReplica,
  vote: EntityLeaderTimeoutVote,
): DeliverableEntityInput => ({
  runtimeId: receiver.runtimeId!,
  entityId: replica.entityId,
  signerId: replica.signerId,
  sourceRuntimeFrame: { height: vote.targetHeight, timestamp: vote.targetHeight },
  leaderTimeoutVote: vote,
});

const requireOnlyEnvelopeInput = (envelope: RuntimeEntityInputsEnvelope): DeliverableEntityInput => {
  if (envelope.entityInputs.length !== 1 || !envelope.entityInputs[0]) {
    throw new Error(`TEST_EXPECTED_SINGLE_ENTITY_INPUT:${envelope.entityInputs.length}`);
  }
  return envelope.entityInputs[0];
};

const routingDeps = (
  targetRuntimeId: string,
  getP2P: RuntimeOutputRoutingDeps['getP2P'],
): RuntimeOutputRoutingDeps => ({
  ensureRuntimeState: env => env.runtimeState!,
  getP2P,
  enqueueRuntimeInputs: () => {},
  extractEntityId: replicaKey => String(replicaKey).split(':')[0] || '',
  hasLocalSignerForEntity: () => false,
  hasLocalSignerForEntitySigner: () => false,
  resolveSoleLocalSignerForEntity: () => null,
  resolveRuntimeIdForEntity: () => targetRuntimeId,
  resolveRuntimeIdForCrossJurisdictionEntity: () => targetRuntimeId,
});

const applyVote = async (
  receiver: Env,
  output: DeliverableEntityInput,
): Promise<void> => {
  const key = `${output.entityId}:${output.signerId}`;
  const replica = receiver.eReplicas.get(key);
  if (!replica) throw new Error('TEST_LEADER_VOTE_REPLICA_MISSING');
  const applied = await applyEntityInput(receiver, replica, output);
  expect(applied.outcome.kind).toBe('committed');
  receiver.eReplicas.set(key, applied.workingReplica);
};

describe('reliable leader timeout vote delivery', () => {
  test('local scheduled timeout intent is not reclassified as transport ingress', async () => {
    const receiver = runtime('leader-vote-local-intent-receiver');
    const sender = runtime('leader-vote-local-intent-sender');
    receiver.scenarioMode = true;
    receiver.timestamp = 10_000;
    const { replica, vote: unrelatedRemoteVote } = installVoteTarget(
      receiver,
      'leader-vote-local-intent-board',
      { localSignerIsFallback: true },
    );
    replica.lastConsensusProgressAt = 0;
    replica.mempool.push({
      type: 'chat',
      data: { from: replica.signerId, message: 'pending failover work' },
    });
    refreshScheduledWakeIndex(receiver);

    const [scheduledIntent] = createDueScheduledWakeInputs(receiver, receiver.timestamp);
    const localVote = scheduledIntent?.leaderTimeoutVote;
    expect(localVote?.signature).toBe('');
    const localMarker = localVote && Object.getOwnPropertySymbols(localVote)
      .find(symbol => Symbol.keyFor(symbol) === 'xln.entity.leader-timeout.local');
    expect(localMarker).toBeDefined();
    expect(Object.getOwnPropertyDescriptor(localVote!, localMarker!)?.enumerable).toBe(false);

    const unrelatedIngress = voteOutput(receiver, replica, unrelatedRemoteVote);
    expect(registerReliableIngress(receiver, sender.runtimeId!, unrelatedIngress).kind).toBe('enqueue');
    expect(receiver.runtimeState?.pendingReliableIngress?.size).toBe(1);

    const result = await applyRuntimeInput(receiver, {
      runtimeTxs: [],
      entityInputs: [scheduledIntent!],
    });
    expect(result.appliedRuntimeInput.entityInputs[0]?.leaderTimeoutVote?.signature)
      .toMatch(/^0x[0-9a-f]+$/i);
    expect(receiver.runtimeState?.pendingReliableIngress?.size).toBe(1);
  });

  test('unmarked unsigned timeout vote remains invalid transport ingress', () => {
    const receiver = runtime('leader-vote-unmarked-intent-receiver');
    const sender = runtime('leader-vote-unmarked-intent-sender');
    const { replica, vote: unrelatedRemoteVote } = installVoteTarget(
      receiver,
      'leader-vote-unmarked-intent-board',
      { localSignerIsFallback: true },
    );
    const unrelatedIngress = voteOutput(receiver, replica, unrelatedRemoteVote);
    expect(registerReliableIngress(receiver, sender.runtimeId!, unrelatedIngress).kind).toBe('enqueue');

    const unmarkedUnsignedVote: DeliverableEntityInput = {
      runtimeId: receiver.runtimeId!,
      entityId: replica.entityId,
      signerId: replica.signerId,
      leaderTimeoutVote: {
        ...buildEntityLeaderVoteBody(replica.state),
        voterId: replica.signerId,
        signature: '',
      },
    };
    expect(() => releaseUncommittedReliableIngress(receiver, [unmarkedUnsignedVote], []))
      .toThrow('ROUTE_LEADER_VOTE_SIGNATURE_MISSING');
  });

  test('real SIGKILL before receiver WAL leaves the sender vote retryable', async () => {
    const sender = runtime('leader-vote-real-crash-sender');
    const receiverSeed = 'leader-vote-real-crash-receiver';
    const receiver = runtime(receiverSeed);
    const boardSeed = 'leader-vote-real-crash-board';
    const { replica, vote } = installVoteTarget(receiver, boardSeed);
    const output = voteOutput(receiver, replica, vote);
    sender.pendingNetworkOutputs = [structuredClone(output)];
    const senderSnapshot = buildDurableRuntimeMachineSnapshot(sender);
    const fixture = join(import.meta.dir, 'fixtures/leader-timeout-vote-ingress-crash-child.ts');

    const child = Bun.spawn({
      cmd: [
        process.execPath,
        fixture,
        receiverSeed,
        sender.runtimeId!,
        JSON.stringify(output),
      ],
      cwd: join(import.meta.dir, '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(137);
    expect(child.signalCode, `${stdout}\n${stderr}`).toBe('SIGKILL');

    const senderRestarted = runtime('leader-vote-real-crash-sender');
    restoreDurableRuntimeSnapshot(senderRestarted, senderSnapshot);
    expect(senderRestarted.pendingNetworkOutputs).toEqual([output]);
    const receiverRestarted = runtime(receiverSeed);
    installVoteTarget(receiverRestarted, boardSeed);
    expect(registerReliableIngress(receiverRestarted, senderRestarted.runtimeId!, output).kind)
      .toBe('enqueue');
  }, 10_000);

  test('transport acceptance retains a scheduled sender retry until durable ACK', () => {
    const sender = runtime('leader-vote-reliable-retry-sender');
    const receiver = runtime('leader-vote-reliable-retry-receiver');
    const { replica, vote } = installVoteTarget(receiver, 'leader-vote-reliable-retry-board');
    const output = voteOutput(receiver, replica, vote);
    const deps = routingDeps(receiver.runtimeId!, () => ({
      enqueueEntityInputsDelivery: () => deliveryAccepted('TEST_TRANSPORT_HANDOFF_ONLY'),
    }));

    sendEntityInputWithRouting(sender, output, deps);

    expect(sender.pendingNetworkOutputs).toEqual([output]);
    expect(getNextNetworkRetryTimestamp(sender, deps)).not.toBeNull();
  });

  test('transport handoff survives sender and receiver restart until exact durable ACK', async () => {
    const sender = runtime('leader-vote-reliable-sender');
    const receiver = runtime('leader-vote-reliable-receiver');
    const { replica, vote } = installVoteTarget(receiver, 'leader-vote-reliable-board');
    const output = voteOutput(receiver, replica, vote);
    const registrations: string[] = [];

    const deferred = dispatchEntityOutputs(
      sender,
      [{ output, targetRuntimeId: receiver.runtimeId! }],
      routingDeps(receiver.runtimeId!, () => ({
        enqueueEntityInputsDelivery: (_runtimeId, delivered) => {
          registrations.push(registerReliableIngress(
            receiver,
            sender.runtimeId!,
            requireOnlyEnvelopeInput(delivered),
          ).kind);
          return deliveryAccepted('TEST_TRANSPORT_HANDOFF_ONLY');
        },
      })),
    );

    expect(registrations).toEqual(['enqueue']);
    expect(deferred).toEqual([output]);
    sender.pendingNetworkOutputs = deferred;

    const senderRestarted = runtime('leader-vote-reliable-sender');
    restoreDurableRuntimeSnapshot(senderRestarted, buildDurableRuntimeMachineSnapshot(sender));
    expect(senderRestarted.pendingNetworkOutputs).toEqual([output]);

    // The first receiver dies after transport acceptance but before its WAL.
    // A clean process therefore has neither a vote nor a receipt and must accept the retry.
    const receiverRestarted = runtime('leader-vote-reliable-receiver');
    installVoteTarget(receiverRestarted, 'leader-vote-reliable-board');
    expect(registerReliableIngress(receiverRestarted, senderRestarted.runtimeId!, output).kind).toBe('enqueue');
    await applyVote(receiverRestarted, output);
    const commits = commitReliableIngress(receiverRestarted, [output]);
    expect(commits).toHaveLength(1);

    // Receipt state becomes observable to transport only after this snapshot/WAL boundary.
    const durableReceiver = runtime('leader-vote-reliable-receiver');
    installVoteTarget(durableReceiver, 'leader-vote-reliable-board');
    restoreDurableRuntimeSnapshot(durableReceiver, buildDurableRuntimeMachineSnapshot(receiverRestarted));
    const duplicate = registerReliableIngress(durableReceiver, senderRestarted.runtimeId!, output);
    expect(duplicate.kind).toBe('receipt');
    if (duplicate.kind !== 'receipt') throw new Error('TEST_LEADER_VOTE_RECEIPT_MISSING');

    expect(applyReliableDeliveryReceipts(senderRestarted, [duplicate.receipt])).toEqual({ removed: 1 });
    expect(senderRestarted.pendingNetworkOutputs).toEqual([]);
    expect(applyReliableDeliveryReceipts(senderRestarted, [duplicate.receipt])).toEqual({ removed: 0 });
  });

  test('identity binds the full vote body, prepared evidence, voter and signature', () => {
    const receiver = runtime('leader-vote-reliable-identity-receiver');
    const { replica, vote } = installVoteTarget(receiver, 'leader-vote-reliable-identity-board');
    const output = voteOutput(receiver, replica, vote);
    const identity = getReliableOutputIdentity(output);

    expect(identity?.kind).toBe('leader-timeout-vote');
    expect(identity?.height).toBe(vote.targetHeight);
    expect(identity?.frameHash).toBe(hashEntityLeaderVoteBody(vote).toLowerCase());
    expect(identity?.evidenceBindings?.map(binding => binding.subject)).toEqual([vote.voterId]);

    const conflictingSignature = structuredClone(output);
    conflictingSignature.leaderTimeoutVote!.signature = `0x${'ff'.repeat(65)}`;
    expect(() => buildPendingNetworkOutputs([output, conflictingSignature]))
      .toThrow('ROUTE_LEADER_VOTE_EQUIVOCATION');

    const conflictingBody = structuredClone(output);
    conflictingBody.leaderTimeoutVote!.previousFrameHash = `0x${'33'.repeat(32)}`;
    expect(() => buildPendingNetworkOutputs([output, conflictingBody]))
      .toThrow('ROUTE_RELIABLE_LANE_ORDER_CONFLICT');

    const prepared = structuredClone(output);
    prepared.leaderTimeoutVote!.preparedFrame = {
      height: vote.targetHeight,
      parentFrameHash: vote.previousFrameHash,
      stateRoot: `0x${'41'.repeat(32)}`,
      authorityRoot: `0x${'42'.repeat(32)}`,
      timestamp: 1,
      hash: `0x${'43'.repeat(32)}`,
      txs: [],
      leader: { proposerSignerId: vote.previousLeaderId, view: vote.fromView },
      collectedSigs: new Map(),
    };
    expect(getReliableOutputIdentity(prepared)?.frameHash)
      .not.toBe(identity?.frameHash);
    expect(() => buildPendingNetworkOutputs([output, prepared]))
      .toThrow('ROUTE_RELIABLE_LANE_ORDER_CONFLICT');

    const nextView = structuredClone(output);
    nextView.leaderTimeoutVote!.fromView = vote.toView;
    nextView.leaderTimeoutVote!.toView = vote.toView + 1;
    nextView.leaderTimeoutVote!.previousLeaderId = vote.nextLeaderId;
    nextView.leaderTimeoutVote!.nextLeaderId = vote.previousLeaderId;
    nextView.leaderTimeoutVote!.signature = `0x${'44'.repeat(65)}`;
    expect(getReliableOutputIdentity(nextView)?.laneKey).not.toBe(identity?.laneKey);
    expect(buildPendingNetworkOutputs([output, nextView])).toHaveLength(2);
  });

  test('HOL is strict per voter/view lane without globally blocking another voter', () => {
    const receiver = runtime('leader-vote-reliable-hol-receiver');
    const { replica, vote } = installVoteTarget(receiver, 'leader-vote-reliable-hol-board');
    const first = voteOutput(receiver, replica, vote);
    const nextHeight = structuredClone(first);
    nextHeight.leaderTimeoutVote!.targetHeight += 1;
    nextHeight.leaderTimeoutVote!.previousFrameHash = `0x${'51'.repeat(32)}`;
    nextHeight.sourceRuntimeFrame = { height: first.sourceRuntimeFrame!.height + 1, timestamp: 1_001 };
    const otherVoter = structuredClone(first);
    otherVoter.leaderTimeoutVote!.voterId = replica.signerId;
    otherVoter.leaderTimeoutVote!.signature = `0x${'52'.repeat(65)}`;
    otherVoter.sourceRuntimeFrame = { height: first.sourceRuntimeFrame!.height + 2, timestamp: 1_002 };
    const attempted: string[] = [];

    const deferred = dispatchEntityOutputs(
      runtime('leader-vote-reliable-hol-sender'),
      [nextHeight, otherVoter, first].map(output => ({ output, targetRuntimeId: receiver.runtimeId! })),
      routingDeps(receiver.runtimeId!, () => ({
        enqueueEntityInputsDelivery: (_runtimeId, delivered) => {
          const input = requireOnlyEnvelopeInput(delivered);
          const label = input.leaderTimeoutVote?.voterId === vote.voterId
            ? `primary-${input.leaderTimeoutVote.targetHeight}`
            : 'other-voter';
          attempted.push(label);
          return label === `primary-${vote.targetHeight}`
            ? deliveryFailure({
                category: 'TransientRace',
                code: 'TEST_LEADER_VOTE_HEAD_DEFERRED',
                terminal: false,
              })
            : deliveryAccepted('TEST_INDEPENDENT_VOTER_DELIVERED');
        },
      })),
    );

    expect(attempted.sort()).toEqual([`primary-${vote.targetHeight}`, 'other-voter'].sort());
    expect(deferred).toHaveLength(3);
  });

  test('an exact stale vote retires terminally, while same-round conflicts fail closed', async () => {
    const sender = runtime('leader-vote-reliable-terminal-sender');
    const receiver = runtime('leader-vote-reliable-terminal-receiver');
    const { replica, vote } = installVoteTarget(receiver, 'leader-vote-reliable-terminal-board');
    const output = voteOutput(receiver, replica, vote);

    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('enqueue');
    const persistedReplica = receiver.eReplicas.get(`${replica.entityId}:${replica.signerId}`);
    if (!persistedReplica) throw new Error('TEST_LEADER_VOTE_TERMINAL_REPLICA_MISSING');
    persistedReplica.state.height = vote.targetHeight;
    const terminal = commitReliableIngress(receiver, []);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.receipt?.body.coverage).toBe('terminal');

    const durableReceiver = runtime('leader-vote-reliable-terminal-receiver');
    installVoteTarget(durableReceiver, 'leader-vote-reliable-terminal-board');
    restoreDurableRuntimeSnapshot(durableReceiver, buildDurableRuntimeMachineSnapshot(receiver));
    const duplicate = registerReliableIngress(durableReceiver, sender.runtimeId!, output);
    expect(duplicate.kind).toBe('receipt');
    const conflictingSignature = structuredClone(output);
    conflictingSignature.leaderTimeoutVote!.signature = `0x${'61'.repeat(65)}`;
    expect(() => registerReliableIngress(durableReceiver, sender.runtimeId!, conflictingSignature))
      .toThrow('EVIDENCE_CONFLICT');
    const conflictingBody = structuredClone(output);
    conflictingBody.leaderTimeoutVote!.previousFrameHash = `0x${'62'.repeat(32)}`;
    expect(() => registerReliableIngress(durableReceiver, sender.runtimeId!, conflictingBody))
      .toThrow('LANE_ORDER_CONFLICT');
  });

  test('a certified leader view retires an exact delayed share before frame commit', () => {
    const sender = runtime('leader-vote-reliable-certified-sender');
    const receiver = runtime('leader-vote-reliable-certified-receiver');
    const { replica, vote } = installVoteTarget(receiver, 'leader-vote-reliable-certified-board');
    const secondVote: EntityLeaderTimeoutVote = {
      ...buildEntityLeaderVoteBody(replica.state),
      voterId: replica.signerId,
      signature: signAccountFrame(
        receiver,
        replica.signerId,
        hashEntityLeaderVoteBody(buildEntityLeaderVoteBody(replica.state)),
      ),
    };
    replica.pendingLeaderCertificate = buildEntityLeaderCertificate(
      vote,
      new Map([
        [vote.voterId, vote],
        [secondVote.voterId, secondVote],
      ]),
    );
    const output = voteOutput(receiver, replica, vote);

    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('enqueue');
    const terminal = commitReliableIngress(receiver, []);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.receipt?.body.coverage).toBe('terminal');
  });

  test('a reordered next-view share gets no early ACK and retires after the target frame commits', async () => {
    const sender = runtime('leader-vote-reliable-view-reorder-sender');
    const receiver = runtime('leader-vote-reliable-view-reorder-receiver');
    const boardSeed = 'leader-vote-reliable-view-reorder-board';
    const { replica, vote: firstViewVote } = installVoteTarget(receiver, boardSeed);
    const viewOneState = structuredClone(replica.state);
    viewOneState.leaderState = {
      activeValidatorId: firstViewVote.nextLeaderId,
      view: firstViewVote.toView,
      changedAtHeight: firstViewVote.targetHeight,
    };
    const nextViewBody = buildEntityLeaderVoteBody(viewOneState);
    const nextViewVote: EntityLeaderTimeoutVote = {
      ...nextViewBody,
      voterId: firstViewVote.voterId,
      signature: signAccountFrame(
        receiver,
        firstViewVote.voterId,
        hashEntityLeaderVoteBody(nextViewBody),
      ),
    };
    const nextViewOutput = voteOutput(receiver, replica, nextViewVote);
    sender.pendingNetworkOutputs = [structuredClone(nextViewOutput)];

    expect(registerReliableIngress(receiver, sender.runtimeId!, nextViewOutput).kind).toBe('enqueue');
    const early = await applyEntityInput(receiver, replica, nextViewOutput);
    expect(early.outcome.kind).toBe('rejected');
    expect(commitReliableIngress(receiver, [])).toEqual([]);
    releaseUncommittedReliableIngress(receiver, [nextViewOutput], []);
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(0);
    expect(receiver.runtimeState?.reliableIngressTerminalWatermarks?.size ?? 0).toBe(0);
    expect(sender.pendingNetworkOutputs).toEqual([nextViewOutput]);

    // A real view-1 frame makes every same-target view-2 vote a protocol no-op.
    // The retry receives an exact terminal ACK instead of mutating newer state.
    const committed = receiver.eReplicas.get(`${replica.entityId}:${replica.signerId}`);
    if (!committed) throw new Error('TEST_LEADER_VOTE_REORDER_REPLICA_MISSING');
    committed.state.height = firstViewVote.targetHeight;
    committed.state.prevFrameHash = `0x${'71'.repeat(32)}`;
    committed.state.leaderState = structuredClone(viewOneState.leaderState);
    expect(registerReliableIngress(receiver, sender.runtimeId!, nextViewOutput).kind).toBe('enqueue');
    const terminal = commitReliableIngress(receiver, []);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.receipt?.body.coverage).toBe('terminal');

    const durableReceiver = runtime('leader-vote-reliable-view-reorder-receiver');
    installVoteTarget(durableReceiver, boardSeed);
    restoreDurableRuntimeSnapshot(durableReceiver, buildDurableRuntimeMachineSnapshot(receiver));
    const duplicate = registerReliableIngress(durableReceiver, sender.runtimeId!, nextViewOutput);
    expect(duplicate.kind).toBe('receipt');
    if (duplicate.kind !== 'receipt') throw new Error('TEST_LEADER_VOTE_REORDER_RECEIPT_MISSING');
    expect(applyReliableDeliveryReceipts(sender, [duplicate.receipt])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([]);
  });
});
