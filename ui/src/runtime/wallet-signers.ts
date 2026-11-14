import type { RuntimeReplica, XLNModule } from '@xln/core/api/public/runtime-module';
import type { RuntimeInput } from '@xln/core/runtime/types';
import { walletSignerIndex } from './keys';

/** Local authority comes from this seed's exact EOA, never from a peer's validator list. */
export function prepareWalletSignerKeys(
  xln: Pick<XLNModule, 'prewarmNumericSigners' | 'getCachedSignerPrivateKey'>,
  seed: string,
  env: RuntimeReplica,
  input?: RuntimeInput,
): void {
  const owners = [...env.state.eReplicas.values()].map(replica => ({
    address: replica.signerId.toLowerCase(),
    jurisdiction: replica.state.config.jurisdiction?.name ?? '',
  }));
  for (const tx of input?.runtimeTxs ?? [])
    if (tx.type === 'importReplica')
      owners.push({ address: tx.signerId.toLowerCase(), jurisdiction: tx.data.config.jurisdiction?.name ?? '' });
  const labels = new Set<string>();
  for (const owner of owners) {
    if (xln.getCachedSignerPrivateKey(seed, owner.address)) continue;
    const index = walletSignerIndex(seed, owner.address, owner.jurisdiction);
    if (index !== null) labels.add(String(index + 1));
  }
  if (labels.size) xln.prewarmNumericSigners(seed, [...labels]);
}
