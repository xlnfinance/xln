import type { ExternalWalletApiContext } from './external-wallet/context';
import { handleErc20Faucet, handleGasFaucet } from './external-wallet/faucet-handlers';
import { provisionFaucetWalletFunding } from './external-wallet/faucet-wallet';
import { handleWalletSnapshot } from './external-wallet/snapshot-handler';
import { handleTokens } from './external-wallet/tokens-handler';

export type { ExternalWalletApiContext } from './external-wallet/context';

// This is the public HTTP composition root. Endpoint validation, faucet
// serialization, and snapshot projection each live with their own owner.
export const createExternalWalletApi = (context: ExternalWalletApiContext) => ({
  provisionFaucetWallet: async (): Promise<void> => {
    const adapter = context.getJAdapter();
    if (!adapter) throw new Error('J-adapter not initialized');
    await provisionFaucetWalletFunding(context, adapter, await context.getTokenCatalog(), {
      ensureEth: true,
      ensureTokens: adapter.mode !== 'browservm',
    });
  },
  handleTokens: () => handleTokens(context),
  handleWalletSnapshot: (request: Request) => handleWalletSnapshot(context, request),
  handleErc20Faucet: (request: Request) => handleErc20Faucet(context, request),
  handleGasFaucet: (request: Request) => handleGasFaucet(context, request),
});
