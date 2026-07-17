import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../../account/crypto';
import { registerReliableIngress } from '../../machine/reliable-delivery';
import { createEmptyEnv } from '../../runtime';
import type { DeliverableEntityInput } from '../../types';

const [receiverSeed, senderRuntimeId, encodedOutput] = Bun.argv.slice(2);
if (!receiverSeed || !senderRuntimeId || !encodedOutput) {
  throw new Error('LEADER_VOTE_CRASH_FIXTURE_ARGUMENTS_MISSING');
}

const receiver = createEmptyEnv(receiverSeed);
const receiverRuntimeId = deriveSignerAddressSync(receiverSeed, 'runtime').toLowerCase();
registerSignerKey(receiver, receiverRuntimeId, deriveSignerKeySync(receiverSeed, 'runtime'));
receiver.runtimeId = receiverRuntimeId;
receiver.runtimeSeed = receiverSeed;
receiver.runtimeState ??= {};
const output = JSON.parse(encodedOutput) as DeliverableEntityInput;
const registration = registerReliableIngress(receiver, senderRuntimeId, output);
if (registration.kind !== 'enqueue') {
  throw new Error(`LEADER_VOTE_CRASH_FIXTURE_NOT_ENQUEUED:${registration.kind}`);
}

// Deliberately die after transport registration and before any Runtime WAL.
process.kill(process.pid, 'SIGKILL');
throw new Error('LEADER_VOTE_CRASH_FIXTURE_SIGKILL_RETURNED');
