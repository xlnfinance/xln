import { safeStringify } from '../../protocol/serialization';
import { proxyCreditOfficer } from './proxy';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { HubChild } from '../orchestrator-types';
import { deriveRuntimeAdapterCapabilityToken } from '../../api/runtime-adapter/security/auth';
import { buildManagedRuntimeChildSecretEnv, writeInheritedChildSecrets } from '../../support/process/child-secrets';

/** One optional officer owns the hub set. Losing it disables auto-approval;
 * it never changes hub admission or supplies an unauthenticated command path. */
export function createCreditOfficerChild(dbRoot: string, port: number) {
  const enabled = process.env['XLN_CREDIT_OFFICER_TESTNET'] === '1';
  let child: ChildProcess | null = null;
  const stop = async (): Promise<void> => {
    const proc = child;
    child = null;
    if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const finish = (): void => {
        clearTimeout(force);
        clearTimeout(deadline);
        proc.off('exit', finish);
        resolve();
      };
      const force = setTimeout(() => proc.kill('SIGKILL'), 1_000);
      const deadline = setTimeout(() => {
        console.error('CREDIT_OFFICER_CLEANUP_TIMEOUT', { pid: proc.pid });
        finish();
      }, 2_000);
      proc.once('exit', finish);
      proc.kill('SIGTERM');
    });
  };
  const start = async (hubs: readonly HubChild[]): Promise<void> => {
    if (!enabled) return;
    try {
      await stop();
      const connections = hubs.map(hub => {
        const runtimeId = hub.lastInfo?.runtimeId;
        const entityIds = hub.lastInfo?.hubEntities?.map(row => row.entityId).filter((id): id is string => Boolean(id));
        if (!runtimeId || !entityIds?.length || hub.engine !== 'typescript')
          throw new Error('CREDIT_OFFICER_HUB_NOT_READY');
        return {
          wsUrl: `ws://127.0.0.1:${hub.apiPort}/rpc`,
          runtimeId,
          entityIds,
          authKey: deriveRuntimeAdapterCapabilityToken(hub.authSeed, 'full', Date.now() + 86_400_000, {
            audience: runtimeId,
            keyId: hub.name.toLowerCase(),
            tokenId: `credit-${crypto.randomUUID()}`,
          }),
        };
      });
      child = spawn('bun', ['core/scripts/operations/credit-officer/main.ts'], {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: {
          ...buildManagedRuntimeChildSecretEnv(process.env),
          XLN_CREDIT_OFFICER_PORT: String(port),
          XLN_CREDIT_OFFICER_DB: join(dbRoot, 'credit-officer.sqlite'),
        },
      });
      child.on('error', error => console.error('CREDIT_OFFICER_PROCESS_ERROR', error));
      child.on('exit', (code, signal) => console.error(`CREDIT_OFFICER_EXIT code=${code} signal=${signal}`));
      await writeInheritedChildSecrets(child, { connections: safeStringify(connections) });
    } catch (error) {
      // Optional auto-approval must never reject hub reset/startup. No hub
      // process is touched; a failed officer remains unavailable to the proxy.
      console.error('CREDIT_OFFICER_START_FAILED', error);
      try {
        await stop();
      } catch (cleanupError) {
        console.error('CREDIT_OFFICER_CLEANUP_FAILED', cleanupError);
      }
    }
  };
  const proxy = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/credit-officer/')) return null;
    if (!enabled) return Response.json({ success: true, enabled: false, error: 'CREDIT_OFFICER_DISABLED' });
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Response.json({ success: false, error: 'CREDIT_OFFICER_UNAVAILABLE' }, { status: 503 });
    }
    return proxyCreditOfficer(request, port);
  };
  return { start, stop, proxy };
}
