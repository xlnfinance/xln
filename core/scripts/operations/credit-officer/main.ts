import { RemoteRuntimeAdapter } from '../../../api/runtime-adapter/remote';
import { readInheritedChildSecrets } from '../../../support/process/child-secrets';
import { CreditLedger } from '../../../orchestrator/credit-officer/ledger';
import { CreditOfficer } from '../../../orchestrator/credit-officer/officer';
import { creditOfficerHttp } from '../../../orchestrator/credit-officer/http';

if (process.env['XLN_CREDIT_OFFICER_TESTNET'] !== '1') throw new Error('CREDIT_OFFICER_DISABLED');
const secrets = readInheritedChildSecrets();
const raw = secrets['connections'];
if (!raw) throw new Error('CREDIT_OFFICER_CONNECTIONS_REQUIRED');
const connections: Array<{ wsUrl: string; authKey: string; runtimeId: string; entityIds: string[] }> = JSON.parse(raw);
const adapters = new Map<string, RemoteRuntimeAdapter>();
for (const connection of connections) {
  const adapter = new RemoteRuntimeAdapter();
  await adapter.connect({ mode: 'remote', ...connection });
  const deadline = Date.now() + 20_000;
  while (!adapter.commandReady) {
    if (Date.now() >= deadline) throw new Error('CREDIT_OFFICER_COMMAND_TIMEOUT');
    await Bun.sleep(50);
  }
  for (const entityId of connection.entityIds) adapters.set(entityId, adapter);
}
const dbPath = process.env['XLN_CREDIT_OFFICER_DB'];
const port = Number(process.env['XLN_CREDIT_OFFICER_PORT']);
if (!dbPath || !Number.isSafeInteger(port) || port < 1) throw new Error('CREDIT_OFFICER_CONFIG_REQUIRED');
const ledger = new CreditLedger(dbPath);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  maxRequestBodySize: 4096,
  fetch: creditOfficerHttp(new CreditOfficer(ledger, adapters), new Set(adapters.keys())),
});
console.log(`CREDIT_OFFICER_READY port=${server.port} hubs=${adapters.size}`);
const parent = process.ppid;
const parentWatch = setInterval(() => {
  if (process.ppid !== parent) {
    console.error('CREDIT_OFFICER_PARENT_EXITED');
    process.exit(1);
  }
}, 1000);
const stop = async () => {
  clearInterval(parentWatch);
  await server.stop(true);
  for (const adapter of new Set(adapters.values())) await adapter.disconnect();
  ledger.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
