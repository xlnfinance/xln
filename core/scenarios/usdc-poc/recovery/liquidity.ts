import { buildCrossJurisdictionSwapIntent } from '../../../account/swap/swap-command-route';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, hexlify } from 'ethers';
import { resolveMeshRuntimeSeed } from '../../../orchestrator/mesh/mesh-seeds';
import { deriveSignerKeySync } from '../../../account/crypto';
import { buildRuntimeAdapterOwnerBindingDigest } from '../../../api/runtime-adapter/security/owner-binding';
import { decodeCommittedCrossRoutes } from '../../../scripts/operations/hlt/cross/cross-boundary';
import {
  decodeEntitySummaries,
  selectLocalHubIdentity,
} from '../../../scripts/operations/hlt/boundary/worker-boundary';
import { connectPocHub } from '../hub-proof';
import { waitFor } from '../user';

import type { RemoteRuntimeAdapter } from '../../../api/runtime-adapter/remote';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';

const connectMaker = async (workDir: string) => {
  const root = readFileSync(join(workDir, 'secrets', 'mesh-root.seed'), 'utf8').trim();
  const owner = new Wallet(hexlify(deriveSignerKeySync(resolveMeshRuntimeSeed(root, {}, 'MM'), '1')));
  return connectPocHub(workDir, 'MM', ({ runtimeId, challenge, capability }) => {
    if (!runtimeId) return null;
    if (runtimeId !== owner.address.toLowerCase()) throw new Error('USDC_POC_MM_OWNER_BINDING_MISMATCH');
    return owner.signingKey.sign(buildRuntimeAdapterOwnerBindingDigest(runtimeId, challenge, capability)).serialized;
  });
};

const makerTemplate = async (hub: RemoteRuntimeAdapter) => {
  const identities = decodeEntitySummaries(await hub.read<unknown>('entities'));
  const sourceHub = selectLocalHubIdentity(identities, hub.runtimeId, 31337).entityId;
  const targetHub = selectLocalHubIdentity(identities, hub.runtimeId, 31338).entityId;
  const routes = decodeCommittedCrossRoutes(await hub.read<unknown>(`entity/${sourceHub}`));
  const template = routes.find(
    route =>
      route.orderId.startsWith('mmx-') &&
      route.source.tokenId === 1 &&
      route.target.tokenId === 1 &&
      route.source.counterpartyEntityId === targetHub &&
      route.target.entityId === sourceHub,
  );
  if (!template) throw new Error('USDC_POC_RECOVERY_MAKER_TEMPLATE_MISSING');
  return { template, sourceHub, targetHub };
};

const releaseQuoteSlot = async (
  maker: RemoteRuntimeAdapter,
  hub: RemoteRuntimeAdapter,
  template: CrossJurisdictionSwapRoute,
  sourceHub: string,
  tag: string,
) => {
  if (!template.sourceSignerId) throw new Error('USDC_POC_RECOVERY_MAKER_SIGNER_MISSING');
  // The default ladders occupy the bounded Pull budget. Cancel through the
  // bilateral Account before replacing this real quote; no limit is weakened.
  await maker.ensureOwnerCommandLane();
  await maker.send(
    {
      runtimeTxs: [],
      entityInputs: [
        {
          entityId: template.source.entityId,
          signerId: template.sourceSignerId,
          entityTxs: [
            { type: 'requestCrossJurisdictionClear', data: { orderId: template.orderId, cancelRemainder: true } },
          ],
        },
      ],
    },
    { commandId: `poc-maker-cancel-${tag}`, commandSequence: maker.nextCommandSequence ?? 0 },
  );
  await waitFor('recovery-maker-pull-slot-released', async () =>
    decodeCommittedCrossRoutes(await hub.read<unknown>(`entity/${sourceHub}`)).some(
      item =>
        item.orderId === template.orderId &&
        ['settled', 'cancelled', 'expired'].includes(item.status) &&
        Boolean(item.sourceCloseProof),
    ),
  );
};

const makerIntent = (template: CrossJurisdictionSwapRoute, sourceHub: string, targetHub: string, orderId: string) => {
  if (
    !template.sourceSignerId ||
    !template.sourceHubSignerId ||
    !template.targetHubSignerId ||
    !template.targetSignerId
  ) {
    throw new Error('USDC_POC_RECOVERY_MAKER_SIGNERS_MISSING');
  }
  return buildCrossJurisdictionSwapIntent({
    offerId: orderId,
    logicalTimestamp: Date.now(),
    expiresInMs: 120_000,
    giveTokenId: 1,
    wantTokenId: 1,
    giveAmount: 500_000n,
    wantAmount: 500_000n,
    priceTicks: 10_000n,
    source: {
      entityId: template.source.entityId,
      signerId: template.sourceSignerId,
      hubEntityId: targetHub,
      hubSignerId: template.sourceHubSignerId,
      jurisdiction: template.source.jurisdiction,
      disputeConfig: template.sourceDisputeConfig,
    },
    target: {
      entityId: template.target.counterpartyEntityId,
      signerId: template.targetSignerId,
      hubEntityId: sourceHub,
      hubSignerId: template.targetHubSignerId,
      jurisdiction: template.target.jurisdiction,
      disputeConfig: template.targetDisputeConfig,
    },
  });
};

/** Two independently signed half-size quotes expose a real partial-fill boundary. */
export const postRecoveryMakerQuote = async (workDir: string, tag: string, sequence: number) => {
  const hub = await connectPocHub(workDir);
  const maker = await connectMaker(workDir);
  try {
    const { template, sourceHub, targetHub } = await makerTemplate(hub);
    if (sequence === 1) await releaseQuoteSlot(maker, hub, template, sourceHub, tag);
    const route = makerIntent(template, sourceHub, targetHub, `poc-mm-${tag}-${sequence}`);
    await maker.submitCrossJurisdictionIntent(route);
    await waitFor('recovery-half-maker-admitted', async () => {
      const stored = decodeCommittedCrossRoutes(await hub.read<unknown>(`entity/${sourceHub}`)).find(
        item => item.orderId === route.orderId,
      );
      if (stored && ['settled', 'cancelled', 'expired'].includes(stored.status))
        throw new Error(`USDC_POC_HALF_MAKER_TERMINAL:${stored.status}`);
      return stored?.status === 'resting';
    });
    return { route, sourceHub, targetHub };
  } finally {
    hub.disconnect();
    maker.disconnect();
  }
};
