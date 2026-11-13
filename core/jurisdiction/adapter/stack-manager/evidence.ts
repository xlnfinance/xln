/** Thin application checks over the canonical native deployment directory. */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const defaultDirectory = new URL('../../../../docs/evidence/stack-manager', import.meta.url).pathname;
export const { sanitizeDeploymentMessage } = createRequire(import.meta.url)(
  '../../../../jurisdictions/scripts/deployment/evidence.cjs',
) as Readonly<{ sanitizeDeploymentMessage: (value: string, privateKeyHex: string, rpcUrl: string) => string }>;

export const assertStackDeploymentResumeExists = async (deploymentId: string, baseDirectory = defaultDirectory): Promise<void> => {
  const directory = join(resolve(baseDirectory), deploymentId);
  let identity: unknown;
  try { identity = JSON.parse(await readFile(join(directory, 'manifest.json.execution.json'), 'utf8')); }
  catch { throw new Error('STACK_MANAGER_DEPLOYMENT_IDENTITY_INVALID'); }
  if (!identity || typeof identity !== 'object' || !('schemaVersion' in identity) || identity.schemaVersion !== 1
    || !('deploymentId' in identity) || identity.deploymentId !== deploymentId) throw new Error('STACK_MANAGER_DEPLOYMENT_IDENTITY_INVALID');
  if (!(await readFile(join(directory, 'journal.jsonl'), 'utf8')).trim()) throw new Error('STACK_MANAGER_IGNITION_JOURNAL_MISSING');
};
