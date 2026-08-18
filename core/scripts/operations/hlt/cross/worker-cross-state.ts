/** Managed cross-j load identities and exact committed-settlement observation. */

import type { JurisdictionConfig } from '../../../../protocol/config/jurisdiction-config';
import { DaemonControlClient, setupCustody } from '../../../../orchestrator/daemon-control';
import { deriveManagedSignerSeed } from '../../../../orchestrator/mesh/mesh-seeds';
import { decodeCommittedCrossRoutes } from './cross-boundary';
import type { ConnectedRuntime } from '../worker-runtime';

const SOURCE_SIGNER_LABEL = 'production-load-source';
const TARGET_SIGNER_LABEL = 'production-load-target';
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
  sourceHubEntityId: string;
  targetHubEntityId: string;
  sourceJurisdiction: JurisdictionConfig;
  targetJurisdiction: JurisdictionConfig;
  sourceTokenId: number;
  targetTokenId: number;
  sourceCredit: bigint;
  targetCredit: bigint;
  custodyRuntimeSeed: string;
}) => {
  const client = new DaemonControlClient({
    baseUrl: httpBaseForRuntimeWsUrl(options.runtime.wsUrl),
    authKey: options.runtime.entry.token,
    timeoutMs: 30_000,
  });
  const source = await setupCustody(client, {
    name: 'Production Load Source',
    seed: deriveManagedSignerSeed(options.custodyRuntimeSeed, SOURCE_SIGNER_LABEL),
    signerLabel: SOURCE_SIGNER_LABEL,
    jurisdiction: options.sourceJurisdiction,
    relayUrl: options.relayUrl,
    gossipPollMs: 250,
    hubEntityIds: [options.sourceHubEntityId],
    creditTokenIds: [options.sourceTokenId],
    creditAmount: options.sourceCredit,
  });
  const target = await setupCustody(client, {
    name: 'Production Load Target',
    seed: deriveManagedSignerSeed(options.custodyRuntimeSeed, TARGET_SIGNER_LABEL),
    signerLabel: TARGET_SIGNER_LABEL,
    jurisdiction: options.targetJurisdiction,
    relayUrl: options.relayUrl,
    gossipPollMs: 250,
    hubEntityIds: [options.targetHubEntityId],
    creditTokenIds: [options.targetTokenId],
    creditAmount: options.targetCredit,
  });
  await client.configureP2P({
    relayUrls: [options.relayUrl],
    advertiseEntityIds: [source.entityId, target.entityId],
    gossipPollMs: 250,
  });
  return { source, target };
};

export const waitForSettledCrossRoute = async (
  hub: ConnectedRuntime,
  sourceHubEntityId: string,
  targetHubEntityId: string,
  orderId: string,
  sourceAmount: bigint,
  targetAmount: bigint,
) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const sourceRoutes = decodeCommittedCrossRoutes(
      await hub.adapter.read<unknown>(`entity/${sourceHubEntityId}`),
    );
    const targetRoutes = decodeCommittedCrossRoutes(
      await hub.adapter.read<unknown>(`entity/${targetHubEntityId}`),
    );
    const source = sourceRoutes.find(route => route.orderId === orderId);
    const target = targetRoutes.find(route => route.orderId === orderId);
    if (
      source?.status === 'settled' && target?.status === 'settled' &&
      source.filledSourceAmount === sourceAmount && source.filledTargetAmount === targetAmount &&
      target.filledSourceAmount === sourceAmount && target.filledTargetAmount === targetAmount
    ) return source;
    await sleep(250);
  }
  throw new Error(`PRODUCTION_SWAP_LOAD_CROSS_FILL_NOT_COMMITTED:${orderId}`);
};
