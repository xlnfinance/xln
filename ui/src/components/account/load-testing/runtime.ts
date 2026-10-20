import {
  createLoadTestingController,
  type LoadTestingControllerDeps,
} from '@xln/frontend/lib/components/Entity/account/load-testing-controller';
import {
  buildPaymentPanelView,
  paymentRecipientProfiles,
} from '@xln/frontend/lib/components/Entity/payments/payment-panel-view';
import { buildSwapPanelRuntimeView } from '@xln/frontend/lib/components/Entity/swap/swap-panel-helpers';
import { getEmbeddedEnv } from '../../../runtime/adapter';
import { sendRuntimeInput } from '../../../runtime/commands';
import { useApp } from '../../../runtime/store';
import { peekXLN } from '../../../runtime/xln-loader';

export function createWalletLoadController(input: {
  entityId: string;
  signerId: string;
  hubId: string;
  bestSwapLevel: LoadTestingControllerDeps['bestSwapLevel'];
}) {
  const env = getEmbeddedEnv();
  const vaultId = useApp.getState().activeVaultId;
  if (!env) throw new Error('LOAD_TEST_EMBEDDED_RUNTIME_REQUIRED');
  const current = (): boolean => {
    const state = useApp.getState();
    return (
      state.adapterStatus === 'connected' &&
      state.activeVaultId === vaultId &&
      state.activeEntityId === input.entityId &&
      getEmbeddedEnv() === env &&
      state.externalWallet?.owner.toLowerCase() === input.signerId.toLowerCase()
    );
  };
  const swapView = () =>
    buildSwapPanelRuntimeView({
      replicas: env.state.eReplicas,
      profiles: env.gossip.getProfiles(),
      networkProfiles: env.gossip.getProfiles(),
    });
  const signer = (entityId: string): string => {
    const local = swapView().localReplicaEntries.find(entry => entry.entityId === entityId)?.signerId;
    const resolved = local || peekXLN()?.resolveEntityProposerId(env, entityId, 'load-testing');
    if (!resolved) throw new Error(`LOAD_TEST_SIGNER_UNAVAILABLE:${entityId}`);
    return resolved;
  };
  const controller = createLoadTestingController({
    sourceEntityId: () => input.entityId,
    selectedHubEntityId: () => input.hubId,
    paymentView: () =>
      buildPaymentPanelView({
        entityId: input.entityId,
        replicas: env.state.eReplicas,
        profiles: paymentRecipientProfiles(env.gossip.getProfiles(), input.entityId),
        networkGraph: env.gossip.getNetworkGraph(),
      }),
    swapView,
    sourceReplica: () =>
      swapView().localReplicaEntries.find(entry => entry.entityId === input.entityId)?.replica ?? null,
    runtimeFunctions: peekXLN,
    resolveSignerId: signer,
    // Identity and snapshot ownership are checked immediately before admission, even after an async route read.
    submitRuntimeInput: value => {
      if (!current()) throw new Error('LOAD_TEST_WALLET_CHANGED');
      return sendRuntimeInput(value);
    },
    bestSwapLevel: input.bestSwapLevel,
    random: Math.random,
  });
  return { ...controller, current };
}
