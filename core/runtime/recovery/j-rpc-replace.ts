import type { RuntimeReplica } from '../types';
import type { JAdapter } from '../../jurisdiction/adapter/types';
import type { JReplica } from '../../types/jurisdiction-runtime';
import { createStructuredLogger } from '../../support/logger';
import { errorMessage } from '../../support/boundary-guards';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope';
import { getJurisdictionIdentityRef } from '../../jurisdiction/machine/jurisdiction-runtime';
import { attachLiveJAdapter, detachLiveJAdapter, getLiveJAdapter } from '../j-submit/live-jadapters';
import { connectVerifiedJAdapter } from './j-adapter-restore';

const rpcReplaceLog = createStructuredLogger('runtime.rpc-replace');

type ReplacementSequence = { next: bigint; verified: bigint; pending: number };
const pendingReplacements = new Map<RuntimeReplica, Map<string, ReplacementSequence>>();

const claimReplacement = (env: RuntimeReplica, ref: string) => {
  const sequences = pendingReplacements.get(env) ?? new Map<string, ReplacementSequence>();
  pendingReplacements.set(env, sequences);
  const sequence = sequences.get(ref) ?? { next: 0n, verified: 0n, pending: 0 };
  sequences.set(ref, sequence);
  sequence.pending++;
  const request = ++sequence.next;
  return {
    sequence,
    request,
    release: () => {
      if (--sequence.pending === 0) sequences.delete(ref);
      if (sequences.size === 0) pendingReplacements.delete(env);
    },
  };
};

const assertReplacementOwner = (env: RuntimeReplica, name: string, owns?: () => boolean): void => {
  const state = env.infrastructure;
  if (
    owns?.() === false ||
    state?.jurisdictionWatchersPaused ||
    state?.persistenceQuiescing ||
    state?.persistencePaused
  )
    throw new Error(`J_RPC_REPLACE_CANCELLED:${name}`);
};

const requireRpcUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('J_RPC_REPLACE_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('J_RPC_REPLACE_URL_INVALID');
  }
  return url.href;
};

/**
 * Point one already-imported jurisdiction at an RPC the owner chooses, e.g.
 * when the RPC published by its Hub is down and the owner must still dispute.
 *
 * RPC selection is a live capability: `JReplica.rpcs` and every committed
 * root stay unchanged (see applyTrustedJurisdictionRpcBindings). Authority:
 * only the local Runtime owner calls this; a peer cannot. The new endpoint
 * must answer with the committed chain id and serve code at every committed
 * contract before the old adapter is retired, so a wrong or hostile URL is
 * rejected and the current adapter keeps running. The next Runtime tick
 * restarts the watcher from the committed J position, so no J event is
 * skipped or re-applied by the switch.
 */
export const replaceJurisdictionRpc = async (
  env: RuntimeReplica,
  jurisdictionName: string,
  rpcUrlInput: string,
  options: { owns?: () => boolean } = {},
): Promise<void> => {
  const jReplica = env.state.jReplicas.get(jurisdictionName);
  if (!jReplica) throw new Error(`J_RPC_REPLACE_JURISDICTION_MISSING:${jurisdictionName}`);
  if (!jReplica.rpcs?.some(rpc => !String(rpc).toLowerCase().startsWith('browservm:'))) {
    throw new Error(`J_RPC_REPLACE_NOT_RPC_BACKED:${jurisdictionName}`);
  }
  // Native TRON also needs operator-published full/solidity hosts; an owner
  // replacement for it is not supported yet and must not be implied.
  if (jReplica.watcherReceiptCommitment === 'tron-rpc-attested') {
    throw new Error(`J_RPC_REPLACE_TRON_UNSUPPORTED:${jurisdictionName}`);
  }
  const rpcUrl = requireRpcUrl(rpcUrlInput);
  assertReplacementOwner(env, jurisdictionName, options.owns);
  const ref = getJurisdictionIdentityRef(jReplica).toLowerCase();
  const claim = claimReplacement(env, ref);
  const assertCurrent = (): void => {
    assertReplacementOwner(env, jurisdictionName, options.owns);
    if (claim.request < claim.sequence.verified) throw new Error(`J_RPC_REPLACE_SUPERSEDED:${jurisdictionName}`);
  };
  let adapter: JAdapter | null = null;
  try {
    adapter = await connectVerifiedJAdapter(env, jurisdictionName, jReplica, {
      context: `rpc-replace:${jurisdictionName}`,
      attempts: 1,
      rpcUrl,
      skipOperatorTransport: true,
    });
    if (!adapter) throw new Error(`J_RPC_REPLACE_ADAPTER_UNAVAILABLE:${jurisdictionName}`);
    await assertEndpointServesReplica(adapter, jReplica, jurisdictionName);
    assertCurrent();
    // Newer *verified* owner choices win; a later failed endpoint must neither
    // erase another jurisdiction's binding nor cancel a valid older choice.
    claim.sequence.verified = claim.request;
    const current = getLiveJAdapter(env, jurisdictionName);
    if (current) {
      detachLiveJAdapter(env, jurisdictionName, current);
      current.stopWatching();
      try {
        await current.close();
      } catch (error) {
        rpcReplaceLog.warn('retired_adapter_close_failed', { jurisdictionName, error: errorMessage(error) });
      }
    }
    assertCurrent();
    const infrastructure = ensureRuntimeInfrastructure(env);
    const next = new Map(infrastructure.trustedJurisdictionRpcUrls ?? []);
    next.set(ref, rpcUrl);
    attachLiveJAdapter(env, jurisdictionName, adapter);
    infrastructure.trustedJurisdictionRpcUrls = next;
    adapter = null; // The live registry now owns this verified capability.
  } catch (error) {
    if (adapter) {
      try {
        await adapter.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'J_RPC_REPLACE_CLEANUP_FAILED');
      }
    }
    throw error;
  } finally {
    claim.release();
  }
};

const assertEndpointServesReplica = async (adapter: JAdapter, jReplica: JReplica, name: string): Promise<void> => {
  const network = await adapter.provider.getNetwork();
  if (Number(network.chainId) !== Number(jReplica.chainId)) {
    throw new Error(`J_RPC_REPLACE_CHAIN_MISMATCH:${name}:${String(network.chainId)}:${String(jReplica.chainId)}`);
  }
  for (const [contract, address] of Object.entries(jReplica.contracts ?? {})) {
    if (!address) continue;
    if ((await adapter.provider.getCode(String(address))) === '0x') {
      throw new Error(`J_RPC_REPLACE_CONTRACT_MISSING:${name}:${contract}`);
    }
  }
};
