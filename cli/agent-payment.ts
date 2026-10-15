import { openSync, writeFileSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { SigningKey, computeAddress } from 'ethers';
import { RemoteRuntimeAdapter } from '../core/api/runtime-adapter/remote';
import { buildRuntimeAdapterOwnerBindingDigest } from '../core/api/runtime-adapter/security/owner-binding';
import { prepareAgentPayment, sendAgentPayment } from '../core/api/payments/agent';
import { readAgentPaymentStatus } from '../core/api/payments/agent-status';
import { safeStringify } from '../core/protocol/serialization';

const usage = `Usage:
  bun cli/agent-payment.ts prepare request.json intent.json
  bun cli/agent-payment.ts send intent.json
  bun cli/agent-payment.ts status intent.json

Required environment: XLN_AGENT_WS_URL, XLN_AGENT_RUNTIME_ID, XLN_AGENT_AUTH_KEY.
prepare/send also require XLN_AGENT_OWNER_KEY_FILE (local hex private key).
Keep credentials in the trusted runner, never in an LLM prompt or a tool result.
Serialize commands on the owner's lane. Save the intent before send; retry that file.
"observed" means input committed, not payment settled. status is read-only.
See docs/agent-payments.md for scope and recovery semantics.`;

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENV:${name}`);
  return value;
};

const connect = async (adapter: RemoteRuntimeAdapter, needsOwner: boolean): Promise<void> => {
  const wsUrl = requiredEnv('XLN_AGENT_WS_URL');
  const url = new URL(wsUrl);
  if (
    url.protocol !== 'wss:' &&
    !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('AGENT_PAYMENT_CONFIDENTIAL_TRANSPORT_REQUIRED');
  }
  const runtimeId = requiredEnv('XLN_AGENT_RUNTIME_ID').toLowerCase();
  const key = needsOwner ? new SigningKey(readFileSync(requiredEnv('XLN_AGENT_OWNER_KEY_FILE'), 'utf8').trim()) : null;
  if (key && computeAddress(key.publicKey).toLowerCase() !== runtimeId)
    throw new Error('AGENT_PAYMENT_OWNER_KEY_MISMATCH');
  await adapter.connect({
    mode: 'remote',
    wsUrl,
    runtimeId,
    authKey: requiredEnv('XLN_AGENT_AUTH_KEY'),
    ...(key
      ? {
          ownerBindingSigner: ({ runtimeId, challenge, capability }) =>
            key.sign(buildRuntimeAdapterOwnerBindingDigest(runtimeId, challenge, capability)).serialized,
        }
      : {}),
  });
};

const saveNewIntent = (path: string, intent: unknown): void => {
  // Never overwrite an uncertain payment with a newly allocated command sequence.
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, safeStringify(intent, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const main = async (): Promise<void> => {
  const [action, inputPath, intentPath] = process.argv.slice(2);
  if (!action || action === '--help') {
    console.log(usage);
    return;
  }
  if (!['prepare', 'send', 'status'].includes(action) || !inputPath || (action === 'prepare' && !intentPath)) {
    throw new Error(usage);
  }
  const value: unknown = JSON.parse(readFileSync(inputPath, 'utf8'));
  const adapter = new RemoteRuntimeAdapter();
  try {
    await connect(adapter, action !== 'status');
    if (action === 'prepare' && intentPath) {
      const intent = await prepareAgentPayment(adapter, value);
      saveNewIntent(intentPath, intent);
      console.log(safeStringify({ status: 'prepared', intentPath, intent }));
    } else {
      const result =
        action === 'send' ? await sendAgentPayment(adapter, value) : await readAgentPaymentStatus(adapter, value);
      console.log(safeStringify(result));
    }
  } finally {
    adapter.disconnect();
  }
};

await main().catch(error => {
  console.error(safeStringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
