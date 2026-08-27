export const WALLET_DEPLOY_VERSION_KEY = 'xln-deploy-version';

export type WalletDeployVersionAction =
  | 'persist-current'
  | 'continue'
  | 'reset-ephemeral-testnet'
  | 'require-recovery';

export type WalletDeployVersionPayload = Readonly<{
  version: string;
  ephemeralTestnet: boolean;
}>;

export type WalletDeployVersionStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type WalletDeployVersionDependencies = Readonly<{
  durable: WalletDeployVersionStorage;
  readCurrentPayload: () => Promise<unknown>;
  resetEphemeralTestnet: () => Promise<void>;
}>;

export type WalletDeployVersionCheckResult =
  | Readonly<{
    status: WalletDeployVersionAction;
    storedVersion: string;
    current: WalletDeployVersionPayload;
  }>
  | Readonly<{ status: 'unavailable'; error: unknown }>;

const readVersionValue = (root: Record<string, unknown>): string =>
  String(root['deployVersion'] || root['networkVersion'] || root['version'] || '').trim();

export const parseWalletDeployVersionPayload = (
  payload: unknown,
): WalletDeployVersionPayload => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('INVALID_DEPLOY_VERSION_PAYLOAD');
  }
  const root = payload as Record<string, unknown>;
  const version = readVersionValue(root);
  if (!version) throw new Error('MISSING_DEPLOY_VERSION');
  return { version, ephemeralTestnet: root['ephemeralTestnet'] === true };
};

export const resolveWalletDeployVersionAction = (
  storedVersion: string,
  currentVersion: string,
  ephemeralTestnet: boolean,
): WalletDeployVersionAction => {
  if (!storedVersion) return 'persist-current';
  if (storedVersion === currentVersion) return 'continue';
  return ephemeralTestnet ? 'reset-ephemeral-testnet' : 'require-recovery';
};

export const walletDeployVersionRecoveryMessage = (
  storedVersion: string,
  currentVersion: string,
): string => `Deploy version changed from ${storedVersion} to ${currentVersion}. Review recovery coverage before resetting local data.`;

export class WalletDeployVersionCoordinator {
  readonly #dependencies: WalletDeployVersionDependencies;

  constructor(dependencies: WalletDeployVersionDependencies) {
    this.#dependencies = dependencies;
  }

  readonly readCurrent = async (): Promise<WalletDeployVersionPayload> =>
    parseWalletDeployVersionPayload(await this.#dependencies.readCurrentPayload());

  readonly refreshStoredVersion = async (): Promise<WalletDeployVersionPayload> => {
    const current = await this.readCurrent();
    this.#dependencies.durable.setItem(WALLET_DEPLOY_VERSION_KEY, current.version);
    return current;
  };

  readonly check = async (): Promise<WalletDeployVersionCheckResult> => {
    let current: WalletDeployVersionPayload;
    try {
      current = await this.readCurrent();
    } catch (error) {
      return { status: 'unavailable', error };
    }
    const storedVersion = String(
      this.#dependencies.durable.getItem(WALLET_DEPLOY_VERSION_KEY) || '',
    ).trim();
    const status = resolveWalletDeployVersionAction(
      storedVersion,
      current.version,
      current.ephemeralTestnet,
    );
    if (status === 'persist-current') {
      this.#dependencies.durable.setItem(WALLET_DEPLOY_VERSION_KEY, current.version);
    }
    if (status === 'reset-ephemeral-testnet') {
      await this.#dependencies.resetEphemeralTestnet();
    }
    return { status, storedVersion, current };
  };
}
