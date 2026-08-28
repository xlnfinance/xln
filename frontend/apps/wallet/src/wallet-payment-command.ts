import type {
  RuntimeAdapter,
  RuntimeAdapterSendResult,
} from '../../../../core/api/runtime-adapter/types';
import type { RuntimePaymentInput } from '../../../packages/runtime-client/src/payment-command-types';

export type WalletPreparedCommand = Readonly<{
  commandId: string;
  commandSequence: number;
  input: RuntimePaymentInput;
  runtimeId: string;
  serverFingerprint: string;
  durable: boolean;
}>;

type CommandDependencies = Readonly<{
  classify: (error: unknown) => Readonly<{
    kind: 'drop' | 'defer' | 'debug-assert' | 'fatal';
    retryable: boolean;
    message: string;
  }>;
  createCommandId: () => string;
  isJournalUnlocked: (runtimeId: string) => boolean;
  resolveIntent: (options: Readonly<{
    input: RuntimePaymentInput;
    runtimeId: string;
    serverFingerprint: string;
    nextCommandSequence: number | null;
  }>) => Promise<Readonly<{
    commandId: string;
    commandSequence: number;
  }>>;
  markAccepted: (commandId: string) => Promise<void>;
  settle: (commandId: string) => Promise<void>;
}>;

let commandDependencies: Promise<CommandDependencies> | null = null;

const loadCommandDependencies = (): Promise<CommandDependencies> => {
  commandDependencies ??= Promise.all([
    import('../../../src/lib/stores/commands/runtimeCommandIntent.ts'),
    import('../../../src/lib/stores/commands/runtimeCommandIntentCodec.ts'),
    import('../../../src/lib/stores/commands/runtimeCommandJournalKeyring.ts'),
    import('../../../src/lib/utils/runtime/runtimeFailure.ts'),
  ]).then(([intent, codec, keyring, failure]) => ({
    classify: failure.classifyRuntimeFailure,
    createCommandId: codec.createRuntimeCommandId,
    isJournalUnlocked: keyring.isRuntimeCommandJournalUnlocked,
    resolveIntent: intent.resolveRemoteRuntimeCommandIntent,
    markAccepted: intent.markRemoteRuntimeCommandIntentAccepted,
    settle: intent.settleRemoteRuntimeCommandIntent,
  }));
  return commandDependencies;
};

const requireCommandIdentity = (adapter: RuntimeAdapter) => {
  const runtimeId = String(adapter.runtimeId || '').trim().toLowerCase();
  const serverFingerprint = String(adapter.serverFingerprint || '').trim().toLowerCase();
  if (!runtimeId) throw new Error('WALLET_PAYMENT_RUNTIME_ID_REQUIRED');
  if (!/^0x[0-9a-f]{64}$/.test(serverFingerprint)) {
    throw new Error('WALLET_PAYMENT_SERVER_IDENTITY_REQUIRED');
  }
  const commandSequence = Number(adapter.nextCommandSequence);
  if (!Number.isSafeInteger(commandSequence) || commandSequence <= 0) {
    throw new Error('WALLET_PAYMENT_COMMAND_SEQUENCE_REQUIRED');
  }
  return { runtimeId, serverFingerprint, commandSequence };
};

export const prepareWalletPaymentCommand = async (
  adapter: RuntimeAdapter,
  input: RuntimePaymentInput,
): Promise<WalletPreparedCommand> => {
  const dependencies = await loadCommandDependencies();
  const identity = requireCommandIdentity(adapter);
  const durable = dependencies.isJournalUnlocked(identity.runtimeId);
  if (durable) {
    await adapter.ensureOwnerCommandLane();
    if (adapter.commandLaneKind !== 'owner') throw new Error('WALLET_PAYMENT_OWNER_LANE_REQUIRED');
    const intent = await dependencies.resolveIntent({
      input,
      runtimeId: identity.runtimeId,
      serverFingerprint: identity.serverFingerprint,
      nextCommandSequence: adapter.nextCommandSequence,
    });
    return {
      commandId: intent.commandId,
      commandSequence: intent.commandSequence,
      input,
      runtimeId: identity.runtimeId,
      serverFingerprint: identity.serverFingerprint,
      durable,
    };
  }
  return {
    commandId: dependencies.createCommandId(),
    commandSequence: identity.commandSequence,
    input,
    runtimeId: identity.runtimeId,
    serverFingerprint: identity.serverFingerprint,
    durable,
  };
};

export const executeWalletPaymentCommand = async (
  adapter: RuntimeAdapter,
  command: WalletPreparedCommand,
): Promise<RuntimeAdapterSendResult> => {
  if (adapter.runtimeId.toLowerCase() !== command.runtimeId) {
    throw new Error('WALLET_PAYMENT_COMMAND_RUNTIME_CHANGED');
  }
  if (adapter.serverFingerprint?.toLowerCase() !== command.serverFingerprint) {
    throw new Error('WALLET_PAYMENT_COMMAND_SERVER_IDENTITY_CHANGED');
  }
  const dependencies = await loadCommandDependencies();
  const result = await adapter.send(command.input, {
    commandId: command.commandId,
    commandSequence: command.commandSequence,
  });
  if (result.status === 'observed') {
    if (command.durable) await dependencies.settle(command.commandId);
    return result;
  }
  if (command.durable) await dependencies.markAccepted(command.commandId);
  return result;
};

export const abandonTerminalWalletPaymentCommand = async (
  command: WalletPreparedCommand,
  error: unknown,
): Promise<Readonly<{ retryable: boolean; terminal: boolean; message: string }>> => {
  const dependencies = await loadCommandDependencies();
  const failure = dependencies.classify(error);
  if (command.durable && failure.kind === 'drop') await dependencies.settle(command.commandId);
  return {
    retryable: failure.kind === 'defer',
    terminal: failure.kind === 'drop',
    message: failure.message,
  };
};
