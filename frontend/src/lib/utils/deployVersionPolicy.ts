export type DeployVersionAction =
  | 'persist-current'
  | 'continue'
  | 'reset-ephemeral-testnet'
  | 'require-recovery';

export const resolveDeployVersionAction = (
  storedVersion: string,
  currentVersion: string,
  ephemeralTestnet: boolean,
): DeployVersionAction => {
  if (!storedVersion) return 'persist-current';
  if (storedVersion === currentVersion) return 'continue';
  return ephemeralTestnet ? 'reset-ephemeral-testnet' : 'require-recovery';
};
