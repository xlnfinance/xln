/** Private BrainVault custody worker for the native Runtime process.
 * Private child IPC only. Rust owns authentication, job serialization and adoption.
 * No RuntimeReplica, financial transitions, network listener or public response here.
 */
import { deriveStoredBrainVaultOwner, readOwner, requireOwnerParentDurable } from './brainvault';
import { deriveEthereumPrivateKeyAtPath } from '../../../../brainvault/src/core/index';
import { deriveMnemonicCustodySeed } from '../../../runtime/registration/entity-creation/mnemonic-seed';
import { BRAINVAULT_V1_SPEC_ID } from '../../../../brainvault/src/core/primitives/spec';
import type { RuntimeAdapterBrainVaultInput } from '../../runtime-adapter/types';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../protocol/boundary-validation';
import { XLN_PROTOCOL_VERSION } from '../../../protocol/version';
import { safeStringify } from '../../../protocol/serialization';
import { validateRuntimeAdapterWireMessage } from '../../runtime-adapter/wire-schema';

type PrivateCommand = { op: 'load'; path: string } | {
  op: 'derive'; path: string; input: RuntimeAdapterBrainVaultInput;
};

const decodePrivateCommand = (value: unknown): PrivateCommand => {
  const command = requireBoundaryRecord(value, 'BRAINVAULT_PRIVATE_COMMAND_INVALID');
  const op = command['op'];
  const path = command['path'];
  if ((op !== 'derive' && op !== 'load') || typeof path !== 'string' || !path.trim()) {
    throw new Error('BRAINVAULT_PRIVATE_COMMAND_INVALID');
  }
  requireExactBoundaryKeys(command, op === 'derive' ? ['op', 'path', 'input'] : ['op', 'path'],
    [], 'BRAINVAULT_PRIVATE_COMMAND_FIELDS_INVALID');
  if (op === 'load') return { op, path };
  // The private transport owns op/path; the canonical adapter decoder owns all
  // BrainVault input keys and bounds, so IPC cannot admit a weaker input shape.
  const request = validateRuntimeAdapterWireMessage({
    v: XLN_PROTOCOL_VERSION, id: 'custody-input', op: 'brainvault-derive',
    jobId: 'custody-input', input: command['input'],
  });
  if (!('op' in request) || request.op !== 'brainvault-derive') {
    throw new Error('BRAINVAULT_PRIVATE_INPUT_INVALID');
  }
  return { op, path, input: request.input };
};

const abort = new AbortController();
process.on('SIGTERM', () => abort.abort());
process.on('SIGINT', () => abort.abort());
const emit = (value: unknown) => process.stdout.write(`${safeStringify(value)}\n`);

const readPrivateCommand = async (): Promise<string> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.byteLength;
    if (size > 65_536) throw new Error('BRAINVAULT_PRIVATE_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

try {
  // Parent supplies one capped private frame over stdin, never argv/environment.
  const raw: unknown = JSON.parse(await readPrivateCommand());
  const command = decodePrivateCommand(raw);
  const prepared = command.op === 'derive' ? await deriveStoredBrainVaultOwner(
    { path: command.path, ...(process.env['XLN_BRAINVAULT_WORKER_PATH']
      ? { workerPath: process.env['XLN_BRAINVAULT_WORKER_PATH'] } : {}) },
    command.input,
    { signal: abort.signal, onProgress: progress => emit({ type: 'progress', progress }) },
  ) : null;
  const stored = prepared?.stored ?? await readOwner(command.path);
  if (!stored) {
    emit({ type: 'absent' });
  } else {
    await requireOwnerParentDurable(command.path);
    const privateKey = await deriveEthereumPrivateKeyAtPath(stored.mnemonic24, "m/44'/60'/0'/0/0");
    const custodySeed = deriveMnemonicCustodySeed(stored.mnemonic24);
    const result = prepared?.result;
    // This message is secret IPC, not a RuntimeInput or browser payload.
    // Rust verifies the recovered address and keeps privateKey memory-only.
    emit({ type: 'custody-ready', signerId: stored.ethereumAddress, privateKey,
      entitySeed: `0x${Buffer.from(custodySeed).toString('hex')}`,
      publicDerivation: { specId: BRAINVAULT_V1_SPEC_ID, backend: 'native-node',
        shardCount: result?.shardCount ?? 0, factor: result?.factor ?? 0,
        workers: result?.workers ?? 0, derivationTimeMs: result?.derivationTimeMs ?? 0,
        ethereumAddress: stored.ethereumAddress } });
    custodySeed.fill(0);
  }
} catch (error) {
  // Do not echo exceptions that might contain request bodies, secrets or file paths.
  const prefix = error instanceof Error ? error.message.split(':')[0] : '';
  const code = /^(?:BRAINVAULT|ENTITY_CUSTODY)_[A-Z0-9_]+$/.test(prefix ?? '') ? prefix : 'BRAINVAULT_CUSTODY_PREPARE_FAILED';
  emit({ type: 'failed', code: abort.signal.aborted ? 'BRAINVAULT_DERIVATION_ABORTED' : code });
  process.exitCode = 1;
}
