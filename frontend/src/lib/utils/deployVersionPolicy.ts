export type DeployVersionAction =
  | 'persist-current'
  | 'continue'
  | 'reset-ephemeral-testnet'
  | 'require-recovery';

/** Only the local development stand is disposable without another confirmation. */
export const isDisposableLocalTestnet = (development: boolean, hostname: string): boolean =>
  development && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

export const resolveDeployVersionAction = (
  storedVersion: string,
  currentVersion: string,
  ephemeralTestnet: boolean,
): DeployVersionAction => {
  if (!storedVersion) return 'persist-current';
  if (storedVersion === currentVersion) return 'continue';
  return ephemeralTestnet ? 'reset-ephemeral-testnet' : 'require-recovery';
};
