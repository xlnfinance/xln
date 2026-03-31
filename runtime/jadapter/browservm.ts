/**
 * JAdapter - BrowserVM Implementation
 * BrowserVM is intentionally disabled in the current runtime/test path.
 * Keep this module as a minimal stub so frontend/runtime bundles do not pull
 * generated TypeChain contracts into paths that never execute.
 */

import type { Provider, Signer } from 'ethers';

import type { JAdapter, JAdapterConfig } from './types';
import type { BrowserVMProvider } from './browservm-provider';

export async function createBrowserVMAdapter(
  _config: JAdapterConfig,
  _provider: Provider,
  _signer: Signer,
  _browserVM: BrowserVMProvider,
): Promise<JAdapter> {
  throw new Error(
    'BrowserVM JAdapter is demo-only and must not be used by the current runtime/test path. ' +
    'Use the RPC JAdapter path instead.',
  );
}
