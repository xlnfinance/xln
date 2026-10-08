/** Managed cross-j load identities and exact committed-settlement observation. */

import type { JurisdictionConfig } from '../../../../protocol/config/jurisdiction-config';
import { DaemonControlClient, setupCustody } from '../../../../orchestrator/daemon-control';
import { crossLoadSignerLabels, deriveManagedSignerSeed } from '../../../../orchestrator/mesh/mesh-seeds';
import type { CrossHub } from './cross-hub';
import { deriveAccountWatchSeed } from '../../../../protocol/identity/account-watch-seed';
import { type ConnectedRuntime, waitForCounterpartyCredit } from '../worker-runtime';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const httpBaseForRuntimeWsUrl = (wsUrl: string): string => {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
};

export const setupCrossLoadCohort = async (options: {
  runtime: ConnectedRuntime;
  relayUrl: string;
  /** Exact planned cohort, shared with startup signer inventory. */
  cohortIndex: number;
  sourceHubEntityId: string;
  targetHubEntityId: string;
  sourceJurisdiction: JurisdictionConfig;
  targetJurisdiction: JurisdictionConfig;
  sourceTokenId: number;
  targetTokenId: number;
  sourceCredit: bigint;
  targetCredit: bigint;
  custodyRuntimeSeed: string;
  disputeConfig?: { leftResponseSeconds: number; rightResponseSeconds: number };
}) => {
  const client = new DaemonControlClient({
    baseUrl: httpBaseForRuntimeWsUrl(options.runtime.wsUrl),
    authKey: options.runtime.entry.token,
    timeoutMs: 30_000,
  });
  const [sourceLabel, targetLabel] = crossLoadSignerLabels(options.cohortIndex);
  const source = await setupCustody(client, {
    name: `Production Load Source-${options.cohortIndex}`,
    seed: deriveManagedSignerSeed(options.custodyRuntimeSeed, sourceLabel),
    signerLabel: sourceLabel,
    jurisdiction: options.sourceJurisdiction,
    relayUrl: options.relayUrl,
    gossipPollMs: 250,
    hubEntityIds: options.disputeConfig ? [] : [options.sourceHubEntityId],
    creditTokenIds: [options.sourceTokenId],
    creditAmount: options.sourceCredit,
  });
  const target = await setupCustody(client, {
    name: `Production Load Target-${options.cohortIndex}`,
    seed: deriveManagedSignerSeed(options.custodyRuntimeSeed, targetLabel),
    signerLabel: targetLabel,
    jurisdiction: options.targetJurisdiction,
    relayUrl: options.relayUrl,
    gossipPollMs: 250,
    hubEntityIds: options.disputeConfig ? [] : [options.targetHubEntityId],
    creditTokenIds: [options.targetTokenId],
    creditAmount: options.targetCredit,
  });
  await client.configureP2P({
    relayUrls: [options.relayUrl],
    advertiseEntityIds: [source.entityId, target.entityId],
    gossipPollMs: 250,
  });
  if (options.disputeConfig) {
    await client.waitForDirectEntityRoutes([options.sourceHubEntityId, options.targetHubEntityId]);
    for (const [identity, hubEntityId, tokenId, amount] of [
      [source, options.sourceHubEntityId, options.sourceTokenId, options.sourceCredit],
      [target, options.targetHubEntityId, options.targetTokenId, options.targetCredit],
    ] as const) {
      await client.queueRuntimeInput({ runtimeTxs: [], entityInputs: [{
        entityId: identity.entityId, signerId: identity.signerId, entityTxs: [
          { type: 'openAccount', data: { targetEntityId: hubEntityId, disputeConfig: options.disputeConfig,
            watchSeed: deriveAccountWatchSeed({ runtimeSeed: options.custodyRuntimeSeed,
              runtimeId: options.runtime.adapter.runtimeId, entityId: identity.entityId, counterpartyId: hubEntityId }),
          } },
          { type: 'extendCredit', data: { counterpartyEntityId: hubEntityId, tokenId, amount } },
        ],
      }] });
      // The user grants the hub spending capacity; observe that exact committed side.
      await waitForCounterpartyCredit(options.runtime, identity.entityId, hubEntityId, tokenId, amount);
    }
  }
  return { source, target };
};

export const waitForSettledCrossRoute = async (
  hub: CrossHub,
  sourceHubEntityId: string,
  targetHubEntityId: string,
  orderId: string,
  sourceAmount: bigint,
  targetAmount: bigint,
) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const sourceRoutes = await hub.routes(sourceHubEntityId);
    const targetRoutes = await hub.routes(targetHubEntityId);
    const source = sourceRoutes.find(route => route.orderId === orderId);
    const target = targetRoutes.find(route => route.orderId === orderId);
    if (
      source?.status === 'settled' &&
      target?.status === 'settled' &&
      source.filledSourceAmount === sourceAmount &&
      source.filledTargetAmount === targetAmount &&
      target.filledSourceAmount === sourceAmount &&
      target.filledTargetAmount === targetAmount
    )
      return source;
    await sleep(250);
  }
  throw new Error(`PRODUCTION_SWAP_LOAD_CROSS_FILL_NOT_COMMITTED:${orderId}`);
};
