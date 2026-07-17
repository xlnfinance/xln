import {
  process as processRuntime,
  registerRecoveryBackupBarrier,
} from '../../runtime';
import { deriveSignerAddressSync } from '../../account/crypto';
import {
  bootScenario,
  fundEntities,
  registerEntities,
} from '../../scenarios/boot';
import { formatRuntime } from '../../qa/runtime-ascii';
import { safeStringify } from '../../protocol/serialization';

type CrashBoundary =
  | 'before-intent'
  | 'after-durable-intent'
  | 'after-rpc-submit-before-result'
  | 'after-durable-result';

const [seed, requestedBoundary] = Bun.argv.slice(2);
if (!seed || !requestedBoundary) throw new Error('seed and J-submit crash boundary are required');
const boundary = requestedBoundary as CrashBoundary;

const crashNow = (): never => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error(`SIGKILL did not stop process at ${boundary}`);
};

const { env, jadapter, jurisdiction } = await bootScenario({
  name: `j-submit-crash-${boundary}`,
  seed,
  signerIds: ['1', '2'],
  storageEnabled: true,
  mode: 'browservm',
});
env.quietRuntimeLogs = true;
jadapter.startWatching(env);
const senderSigner = deriveSignerAddressSync(seed, '1').toLowerCase();
const receiverSigner = deriveSignerAddressSync(seed, '2').toLowerCase();

const [sender, receiver] = await registerEntities(env, jadapter, [
  { name: 'Sender', signer: senderSigner, position: { x: -10, y: 0, z: 0 } },
  { name: 'Receiver', signer: receiverSigner, position: { x: 10, y: 0, z: 0 } },
], jurisdiction);
if (!sender || !receiver) throw new Error('J-submit crash entities were not registered');

const senderReplica = () => {
  const replica = Array.from(env.eReplicas.values()).find((candidate) => (
    candidate.entityId === sender.id && candidate.signerId === sender.signer
  ));
  if (!replica) throw new Error('J-submit crash sender replica missing');
  return replica;
};

const driveUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let round = 0; round < 20; round += 1) {
    if (predicate()) return;
    await processRuntime(env, []);
  }
  console.error(formatRuntime(env));
  console.error(safeStringify({
    runtimeMempool: env.runtimeMempool,
    replicas: Array.from(env.eReplicas.entries()).map(([key, replica]) => ({
      key,
      stateHeight: replica.state.height,
      mempool: replica.mempool,
      proposal: replica.proposal,
      lockedFrame: replica.lockedFrame,
      validatorExecutionHeight: replica.validatorExecution?.height,
      leaderVotes: replica.leaderVotes,
    })),
  }, 2));
  throw new Error(`J-submit crash convergence failed: ${label}`);
};

await fundEntities(env, jadapter, [{ id: sender.id, tokenId: 1, amount: 100n }]);
await processRuntime(env, [{
  entityId: sender.id,
  signerId: sender.signer,
  entityTxs: [{
    type: 'r2r',
    data: { toEntityId: receiver.id, tokenId: 1, amount: 10n },
  }],
}]);
await driveUntil(
  () => (senderReplica().state.jBatchState?.batch.reserveToReserve.length ?? 0) === 1,
  'r2r committed before broadcast',
);

if (boundary === 'before-intent') crashNow();

if (boundary === 'after-durable-intent') {
  registerRecoveryBackupBarrier(env, async () => crashNow());
}
await processRuntime(env, [{
  entityId: sender.id,
  signerId: sender.signer,
  entityTxs: [{ type: 'j_broadcast', data: {} }],
}]);
await driveUntil(
  () => senderReplica().state.jBatchState?.sentBatch !== undefined &&
    Boolean(env.runtimeMempool?.runtimeTxs.some((tx) => tx.type === 'retryJSubmit')),
  'durable submit intent',
);

if (boundary === 'after-rpc-submit-before-result') {
  const submitTx = jadapter.submitTx.bind(jadapter);
  jadapter.submitTx = async (...args) => {
    const result = await submitTx(...args);
    if (!result.success) {
      throw new Error(`real BrowserVM J submit failed before crash: ${result.error ?? 'unknown'}`);
    }
    crashNow();
    return result;
  };
}

// Applies the durable retry intent, persists the exact attempt/outbox, then
// performs the real BrowserVM contract call. The wrapped mode dies after that
// call returns but before submitRuntimeJOutbox can enqueue its result RuntimeTx.
await driveUntil(
  () => Boolean(env.runtimeMempool?.runtimeTxs.some((tx) => tx.type === 'recordJSubmitResult')),
  'real submit result queued',
);

const resultTx = env.runtimeMempool?.runtimeTxs.find((tx) => tx.type === 'recordJSubmitResult');
if (!resultTx) throw new Error('J-submit result RuntimeTx was not queued after real submit');
await driveUntil(
  () => senderReplica().jSubmitState?.lastResultOutcome === 'submitted',
  'durable submitted result',
);
crashNow();
