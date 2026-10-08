import { JsonRpcProvider } from 'ethers';
import { getEmbeddedEnv, requireAdapter } from './adapter';
import { waitFor } from './tx';
import { CONTRACT_FIELDS, networkInput, type NetworkDraft } from './network-input';
export { CONTRACT_FIELDS, type NetworkDraft } from './network-input';

/** Connect existing contracts only; this form never deploys or silently replaces a network. */
export async function connectNetwork(draft: NetworkDraft): Promise<void> {
  const env = getEmbeddedEnv();
  if (!env) throw new Error('Network configuration requires a wallet running on this device');
  const input = networkInput(draft);
  const name = draft.name.trim();
  if (env.state.jReplicas.has(name)) throw new Error(`Network ${name} already exists`);
  // One chain + Depository is one watcher identity; a second import of it is refused here, before
  // the runtime ever sees a conflicting jurisdiction.
  const depository = draft.contracts.depository.trim().toLowerCase();
  for (const [existingName, replica] of env.state.jReplicas.entries()) {
    if (Number(replica.chainId) === Number(draft.chainId) && String(replica.contracts?.depository ?? '').toLowerCase() === depository) {
      throw new Error(`This network is already connected as ${existingName}`);
    }
  }
  const provider = new JsonRpcProvider(draft.rpc.trim(), undefined, { batchMaxCount: 1 });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(draft.chainId)) throw new Error('RPC chain id does not match the configured network');
    for (const key of CONTRACT_FIELDS) {
      if (await provider.getCode(draft.contracts[key].trim()) === '0x') throw new Error(`No deployed contract at ${key}`);
    }
  } finally {
    provider.destroy();
  }
  await requireAdapter().send(input);
  await waitFor(() => env.state.jReplicas.has(name), `Connect ${name}`);
}
