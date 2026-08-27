import {
  remoteAcceptKey,
  type RemoteRuntimeRequest,
} from '../../runtime-client/src/remote-runtime-request';

export const WALLET_REMOTE_RUNTIME_AUTH_REQUIRED =
  'Paste the capability token to connect.';

export type WalletRuntimeConsentDependencies = Readonly<{
  publishAuthError: (message: string) => void;
  persistRemoteRequest: (request: RemoteRuntimeRequest) => void;
  selectEmbeddedRuntime: () => void;
  stripRemoteRuntimeParams: () => void;
  activateRuntimeChoice: () => Promise<void>;
}>;

export type WalletRuntimeConsentResult =
  | Readonly<{ status: 'accepted'; request: RemoteRuntimeRequest }>
  | Readonly<{ status: 'invalid-auth'; message: string }>;

const resolveAcceptedRequest = (
  request: RemoteRuntimeRequest,
  authInput: string,
): RemoteRuntimeRequest | null => {
  const authKey = request.requiresAuthPaste ? authInput.trim() : request.authKey;
  if (request.requiresAuthPaste && !authKey.startsWith('xlnra1.')) return null;
  return {
    ...request,
    authKey,
    acceptKey: remoteAcceptKey(request.wsUrl, authKey),
  };
};

export class WalletRuntimeConsentCoordinator {
  readonly #dependencies: WalletRuntimeConsentDependencies;

  constructor(dependencies: WalletRuntimeConsentDependencies) {
    this.#dependencies = dependencies;
  }

  readonly acceptRemote = async (
    request: RemoteRuntimeRequest,
    authInput: string,
  ): Promise<WalletRuntimeConsentResult> => {
    const acceptedRequest = resolveAcceptedRequest(request, authInput);
    if (!acceptedRequest) {
      this.#dependencies.publishAuthError(WALLET_REMOTE_RUNTIME_AUTH_REQUIRED);
      return {
        status: 'invalid-auth',
        message: WALLET_REMOTE_RUNTIME_AUTH_REQUIRED,
      };
    }
    this.#dependencies.publishAuthError('');
    this.#dependencies.persistRemoteRequest(acceptedRequest);
    this.#dependencies.stripRemoteRuntimeParams();
    await this.#dependencies.activateRuntimeChoice();
    return { status: 'accepted', request: acceptedRequest };
  };

  readonly useEmbedded = async (): Promise<void> => {
    this.#dependencies.selectEmbeddedRuntime();
    this.#dependencies.stripRemoteRuntimeParams();
    await this.#dependencies.activateRuntimeChoice();
  };
}
