import { registerReliableIngress } from '../../runtime/reliable/reliable-delivery.ts';
import { createEmptyEnv } from '../../runtime';
import type { DeliverableEntityInput } from '../../runtime/types';

const [receiverSeed, senderRuntimeId, encodedOutput] = Bun.argv.slice(2);
if (!receiverSeed || !senderRuntimeId || !encodedOutput) {
  throw new Error('LEADER_VOTE_CRASH_FIXTURE_ARGUMENTS_MISSING');
}

const receiver = createEmptyEnv(receiverSeed);
receiver.infrastructure ??= {};
const output = JSON.parse(encodedOutput) as DeliverableEntityInput;
const registration = registerReliableIngress(receiver, senderRuntimeId, output);
if (registration.kind !== 'enqueue') {
  throw new Error(`LEADER_VOTE_CRASH_FIXTURE_NOT_ENQUEUED:${registration.kind}`);
}

// Deliberately die after transport registration and before any Runtime WAL.
process.kill(process.pid, 'SIGKILL');
throw new Error('LEADER_VOTE_CRASH_FIXTURE_SIGKILL_RETURNED');
