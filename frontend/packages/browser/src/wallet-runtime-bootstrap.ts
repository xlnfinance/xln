import type { RemoteRuntimeRequest } from '../../runtime-client/src/remote-runtime-request';

export type WalletRuntimeBootstrapInput = Readonly<{
  pairingToken: string;
  importPayload: string;
  importSource: string;
  remoteRequest: RemoteRuntimeRequest | null;
}>;

export type WalletRuntimeBootstrapDependencies = Readonly<{
  pairLocalRuntime: (pairingToken: string) => Promise<void>;
  importRemoteRuntimes: (input: Readonly<{
    payload: string;
    source: string;
  }>) => Promise<void>;
  requiresRemoteConsent: (request: RemoteRuntimeRequest) => boolean;
  publishPendingConsent: (request: RemoteRuntimeRequest) => void;
  persistRemoteRequest: (request: RemoteRuntimeRequest) => void;
  stripRemoteRuntimeParams: () => void;
}>;

export type WalletRuntimeBootstrapResult =
  | Readonly<{ status: 'continue' }>
  | Readonly<{ status: 'pending-consent'; request: RemoteRuntimeRequest }>;

export const hasWalletRuntimeBootstrapInput = (
  input: WalletRuntimeBootstrapInput,
): boolean => Boolean(
  input.pairingToken
  || input.importPayload
  || input.importSource
  || input.remoteRequest,
);

export class WalletRuntimeBootstrapCoordinator {
  readonly #dependencies: WalletRuntimeBootstrapDependencies;

  constructor(dependencies: WalletRuntimeBootstrapDependencies) {
    this.#dependencies = dependencies;
  }

  readonly process = async (
    input: WalletRuntimeBootstrapInput,
  ): Promise<WalletRuntimeBootstrapResult> => {
    await this.#dependencies.pairLocalRuntime(input.pairingToken);
    await this.#dependencies.importRemoteRuntimes({
      payload: input.importPayload,
      source: input.importSource,
    });
    if (!input.remoteRequest) return { status: 'continue' };
    if (this.#dependencies.requiresRemoteConsent(input.remoteRequest)) {
      this.#dependencies.publishPendingConsent(input.remoteRequest);
      this.#dependencies.stripRemoteRuntimeParams();
      return { status: 'pending-consent', request: input.remoteRequest };
    }
    this.#dependencies.persistRemoteRequest(input.remoteRequest);
    this.#dependencies.stripRemoteRuntimeParams();
    return { status: 'continue' };
  };
}
