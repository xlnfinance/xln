import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteRuntimeAdapter } from '../../api/runtime-adapter/remote';
import type { RuntimeAdapterConfig } from '../../api/runtime-adapter/types';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';
import { decodeRuntimeManifestEntries } from '../../scripts/operations/hlt/boundary/worker-boundary';
import { userReplica, waitFor, type PocUser } from './user';

export const connectPocHub = async (
  workDir: string,
  label = 'H1',
  ownerBindingSigner?: RuntimeAdapterConfig['ownerBindingSigner'],
  connection?: RuntimeAdapterConfig,
): Promise<RemoteRuntimeAdapter> => {
  if (connection) {
    const adapter = new RemoteRuntimeAdapter();
    await adapter.connect(connection);
    return adapter;
  }
  const manifest = JSON.parse(
    readFileSync(join(workDir, 'prod-mesh', 'runtime-import-manifest.json'), 'utf8'),
  ) as unknown;
  const entries = decodeRuntimeManifestEntries(manifest).filter(entry => entry.label === label);
  const entry = entries[0];
  if (entries.length !== 1 || !entry) throw new Error(`USDC_POC_RUNTIME_NOT_UNIQUE:${label}`);
  const adapter = new RemoteRuntimeAdapter();
  await adapter.connect({
    mode: 'remote',
    wsUrl: entry.wsUrl,
    authKey: entry.token,
    ...(ownerBindingSigner ? { ownerBindingSigner } : {}),
  });
  return adapter;
};

/** Read the opposite sovereign Runtime; local H0/presence is never proof. */
export const verifyHubCommit = async (user: PocUser, hub: string, workDir: string) => {
  const adapter = await connectPocHub(workDir, 'H1', undefined, user.hubConnection);
  try {
    let proof:
      | { height: number; stateHash: string; accountStateRoot: string; localFrameHanko: string; peerFrameHanko: string }
      | undefined;
    await waitFor('both-account-roots-match', async () => {
      const remote = requireBoundaryRecord(
        await adapter.read<unknown>(`entity/${hub}/account/${user.entityId}`),
        'USDC_POC_HUB_ACCOUNT_INVALID',
      );
      const frame = requireBoundaryRecord(remote['currentFrame'], 'USDC_POC_HUB_FRAME_INVALID');
      const local = userReplica(user).state.accounts.get(hub);
      if (
        !local ||
        local.pendingFrame ||
        local.mempool.length ||
        remote['pendingFrame'] ||
        remote['mempoolCount'] !== 0
      )
        return false;
      if (remote['currentHeight'] !== local.currentHeight || frame['stateHash'] !== local.currentFrame.stateHash)
        return false;
      if (
        !local.currentFrameHanko ||
        !local.counterpartyFrameHanko ||
        remote['currentFrameHanko'] !== local.counterpartyFrameHanko ||
        remote['counterpartyFrameHanko'] !== local.currentFrameHanko
      )
        return false;
      proof = {
        height: local.currentHeight,
        stateHash: local.currentFrame.stateHash,
        accountStateRoot: local.currentFrame.accountStateRoot,
        localFrameHanko: local.currentFrameHanko,
        peerFrameHanko: local.counterpartyFrameHanko,
      };
      return true;
    });
    if (!proof) throw new Error('USDC_POC_BILATERAL_PROOF_MISSING');
    return proof;
  } finally {
    adapter.disconnect();
  }
};
