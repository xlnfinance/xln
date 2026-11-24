import { isDisposableLocalTestnet, resolveDeployVersionAction } from '../../../frontend/src/lib/utils/deployVersionPolicy';
import { clearRetiredTestnetState } from '../../../frontend/src/lib/utils/control/resetBrowserData';

const DEPLOY_VERSION_KEY = 'xln-deploy-version';

export type DeployVersionContext = {
  development: boolean;
  hostname: string;
};

/** Same version fields the Svelte wallet reads from `/api/jurisdictions`. */
export function readDeployVersionPayload(
  payload: unknown,
  context: DeployVersionContext,
): { version: string; ephemeralTestnet: boolean } {
  if (!payload || typeof payload !== 'object') throw new Error('INVALID_DEPLOY_VERSION_PAYLOAD');
  const root = payload as Record<string, unknown>;
  const version = String(root['deployVersion'] || root['networkVersion'] || root['version'] || '').trim();
  if (!version) throw new Error('MISSING_DEPLOY_VERSION');
  return {
    version,
    ephemeralTestnet:
      root['ephemeralTestnet'] === true || isDisposableLocalTestnet(context.development, context.hostname),
  };
}

/**
 * A redeployed testnet cannot be read from the previous chain stores.
 * Keys, passwords and preferences stay. A real-funds mismatch stays fail-closed.
 */
export async function reconcileRetiredDeployVersion(payload: unknown, context: DeployVersionContext): Promise<void> {
  const current = readDeployVersionPayload(payload, context);
  const stored = String(localStorage.getItem(DEPLOY_VERSION_KEY) || '').trim();
  const action = resolveDeployVersionAction(stored, current.version, current.ephemeralTestnet);
  if (action === 'continue') return;
  if (action === 'require-recovery') {
    throw new Error(
      `Deploy version changed from ${stored} to ${current.version}. Review recovery coverage before resetting local data.`,
    );
  }
  if (action === 'reset-ephemeral-testnet') await clearRetiredTestnetState();
  localStorage.setItem(DEPLOY_VERSION_KEY, current.version);
}
