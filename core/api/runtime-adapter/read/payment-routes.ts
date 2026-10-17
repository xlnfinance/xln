import { withRuntimeCommittedRead } from '../../../runtime/frame/lifecycle/writer-lock';
import { ensureGossipProfiles } from '../../../runtime/composition';
import type { RuntimeReplica } from '../../../runtime/types';
import { RuntimeAdapterError } from '../errors';
import type { RuntimeAdapterPaymentRoutesResponse, RuntimeAdapterReadQuery } from '../types';

export const findPaymentRoutes = async (
  env: RuntimeReplica,
  query: RuntimeAdapterReadQuery = {},
): Promise<RuntimeAdapterPaymentRoutesResponse> => {
  const sourceEntityId = String(query.sourceEntityId || '')
    .trim()
    .toLowerCase();
  const targetEntityId = String(query.targetEntityId || '')
    .trim()
    .toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(sourceEntityId) || !/^0x[0-9a-f]{64}$/.test(targetEntityId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route endpoints must be 32-byte entity ids');
  }
  const fundingAccountId = query.fundingAccountId?.trim().toLowerCase();
  if (fundingAccountId !== undefined && !/^0x[0-9a-f]{64}$/.test(fundingAccountId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'funding account must be a 32-byte entity id');
  }
  const tokenId = Number(query.tokenId);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route tokenId must be a positive integer');
  }
  let amount: bigint;
  try {
    amount = BigInt(String(query.amount || ''));
  } catch {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route amount must be an integer string');
  }
  if (amount <= 0n) throw new RuntimeAdapterError('E_BAD_QUERY', 'payment route amount must be positive');

  // Network refresh runs outside the committed-read lease; only the graph
  // search reads committed State, so only it holds the frame writer.
  if (env.infrastructure?.p2p?.syncProfiles) await env.infrastructure.p2p.syncProfiles();
  const profilesReady = await ensureGossipProfiles(env, [sourceEntityId, targetEntityId]);
  if (!profilesReady) {
    throw new RuntimeAdapterError('E_INTERNAL', 'payment route profiles are unavailable', true);
  }
  const searchRoutes = () =>
    withRuntimeCommittedRead(env, () =>
      env.gossip.getNetworkGraph().findPaths(sourceEntityId, targetEntityId, amount, tokenId, fundingAccountId),
    );
  let routes = await searchRoutes();
  if (routes.length === 0 && env.infrastructure?.p2p?.ensureRoutes) {
    // Pull-only gossip: ask the relay for the profile chains that route here.
    await env.infrastructure.p2p.ensureRoutes(sourceEntityId, targetEntityId, amount, tokenId);
    routes = await searchRoutes();
  }
  if (routes.length === 0) {
    throw new RuntimeAdapterError('E_NOT_FOUND', `no payment route from ${sourceEntityId} to ${targetEntityId}`);
  }
  return {
    routes: routes.map(route => ({
      path: route.path,
      hops: route.hops.map(hop => ({
        from: hop.from,
        to: hop.to,
        fee: hop.fee.toString(),
        feePPM: hop.feePPM,
      })),
      totalFee: route.totalFee.toString(),
      senderAmount: route.totalAmount.toString(),
      recipientAmount: amount.toString(),
      probability: route.probability,
    })),
  };
};
