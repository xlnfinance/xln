/** Write-once public catalog configuration; never a transaction recovery authority. */
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../../protocol/serialization';
import { resolveJurisdictionsJsonPath } from '../../jurisdictions-path';
import { decodeStackManagerRpcUrl } from '../validation';
import type { DeployJurisdictionStackRequest } from '../types';

const binding = (request: DeployJurisdictionStackRequest, deploymentId: string, rpcUrl: string) => ({
  schemaVersion: 1, deploymentId, catalogPath: resolveJurisdictionsJsonPath(), key: request.key,
  chainId: request.expectedChainId, rpcUrl: decodeStackManagerRpcUrl(rpcUrl),
});

export const readStackPublicationRpc = async (
  request: DeployJurisdictionStackRequest, directory: string, deploymentId: string,
): Promise<string | undefined> => {
  let saved: unknown;
  try { saved = JSON.parse(await readFile(join(directory, 'publication.json'), 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)
    || typeof (saved as Record<string, unknown>)['rpcUrl'] !== 'string') {
    throw new Error('STACK_MANAGER_PUBLICATION_IDENTITY_INVALID');
  }
  const expected = binding(request, deploymentId, (saved as { rpcUrl: string }).rpcUrl);
  if (safeStringify(saved) !== safeStringify(expected)) throw new Error('STACK_MANAGER_PUBLICATION_IDENTITY_MISMATCH');
  return expected.rpcUrl;
};

export const sealStackPublicationRpc = async (
  request: DeployJurisdictionStackRequest, directory: string, deploymentId: string, rpcUrl: string,
): Promise<void> => {
  const saved = await readStackPublicationRpc(request, directory, deploymentId);
  if (saved !== undefined) {
    if (saved !== rpcUrl) throw new Error('STACK_MANAGER_PUBLICATION_IDENTITY_MISMATCH');
    return;
  }
  // The native journal and redacted initial identity cannot reconstruct this
  // public endpoint after a crash. Seal it before catalog rename, so mutable
  // catalog edits cannot authorize themselves and a new transport can recover.
  const handle = await open(join(directory, 'publication.json'), 'wx', 0o600);
  try { await handle.writeFile(safeStringify(binding(request, deploymentId, rpcUrl), 2)); await handle.sync(); }
  finally { await handle.close(); }
  const parent = await open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
};
