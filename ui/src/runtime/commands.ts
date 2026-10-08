import type { RuntimeInput } from '@xln/core/api/public/runtime-module';
import type { RuntimeAdapterSendResult } from '@xln/core/api/runtime-adapter/types';
import {
  submitRuntimeCommand,
  type RuntimeCommandExecutionOptions,
} from '@xln/frontend/lib/stores/commands/runtimeCommandBus';
import { isRuntimeCommandJournalUnlocked } from '@xln/frontend/lib/stores/commands/runtimeCommandJournalKeyring';
import { waitForObservedRemoteCommand } from '@xln/frontend/lib/stores/commands/remote-command-observation';
import { getAdapter, requireAdapter } from './adapter';

/** Both wallet shells use the same command identity, journal and observed frontier. */
export async function sendRuntimeInput(
  input: RuntimeInput,
  options: RuntimeCommandExecutionOptions = {},
): Promise<RuntimeAdapterSendResult> {
  const adapter = requireAdapter();
  if (adapter.mode === 'embedded') return adapter.send(input);
  const runtimeId = adapter.runtimeId;
  const serverFingerprint = adapter.serverFingerprint;
  if (!serverFingerprint) throw new Error('REMOTE_RUNTIME_SERVER_IDENTITY_REQUIRED');
  const journalUnlocked = isRuntimeCommandJournalUnlocked(runtimeId);
  if (journalUnlocked) {
    await adapter.ensureOwnerCommandLane();
    if (adapter.commandLaneKind !== 'owner') throw new Error(`REMOTE_COMMAND_OWNER_LANE_REQUIRED:${runtimeId}`);
  }
  const submitted = await submitRuntimeCommand({
    input, runtimeId, mode: 'remote', serverFingerprint,
    nextCommandSequence: adapter.nextCommandSequence,
    initialHeight: adapter.currentHeight,
    ...(!journalUnlocked ? { remoteJournalMode: 'one-shot' as const } : {}),
    ...options,
  }, async (progress, receipt) => {
    if (receipt.commandSequence === null) throw new Error('RUNTIME_COMMAND_RECEIPT_SEQUENCE_MISSING');
    const observed = await waitForObservedRemoteCommand({
      adapter, input,
      command: { commandId: receipt.commandId, commandSequence: receipt.commandSequence },
      isCurrent: () => getAdapter() === adapter,
      accepted: progress.accepted,
    });
    await progress.observed(observed.height);
    return observed;
  });
  return submitted.result;
}
